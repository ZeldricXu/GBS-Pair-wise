"""FastAPI application: append-only audit service.

Endpoints
---------
POST   /events                 append one event; returns its sequence number
GET    /events/{seq}           fetch one stored event (with chain metadata)
GET    /events                 list events in sequence order
GET    /chain/head             newest sequence number and chain head hash
GET    /verify?from_seq=1      hash-chain verification; first mismatch or all-ok
GET    /state                  current state (snapshot + increments by default)
GET    /state/replay           state produced by a full replay from seq 1
GET    /state/history/{seq}    state at an arbitrary point in time
POST   /snapshots              create a snapshot (optionally at a given seq)
GET    /snapshots              list snapshots
GET    /snapshots/verify       prove snapshot path == full replay, byte-for-byte
GET    /health                 liveness probe

State endpoints return the canonical state JSON as the raw body; two state
bodies may therefore be compared byte-for-byte.
"""

from __future__ import annotations

import hashlib
import os

from fastapi import FastAPI, HTTPException, Query, Request, Response

from .canonical import CanonicalError, dumps, loads
from .store import EventStore, StoreError

DB_PATH = os.environ.get("AUDIT_DB", "data/audit.db")

store = EventStore(DB_PATH)
app = FastAPI(title="Append-Only Audit Service", version="1.0.0")


def json_response(payload: object, status_code: int = 200) -> Response:
    return Response(
        content=dumps(payload),
        status_code=status_code,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


async def read_event_body(request: Request) -> dict:
    raw = await request.body()
    try:
        event = loads(raw)
    except CanonicalError as exc:
        raise HTTPException(status_code=400, detail=f"invalid JSON: {exc}") from exc
    validate_event(event)
    return event


def validate_event(event: object) -> None:
    if not isinstance(event, dict):
        raise HTTPException(status_code=400, detail="event must be a JSON object")
    obj_id = event.get("id")
    if not isinstance(obj_id, str) or not obj_id:
        raise HTTPException(
            status_code=400, detail="event must contain a non-empty string 'id'"
        )
    deleted = event.get("deleted", False)
    if not isinstance(deleted, bool):
        raise HTTPException(
            status_code=400, detail="'deleted' must be a JSON boolean when present"
        )


def state_response(state_blob: bytes, target: int, method: str, snapshot_seq) -> Response:
    headers = {
        "X-State-Seq": str(target),
        "X-State-Method": method,
        "X-State-Hash": hashlib.sha256(state_blob).hexdigest(),
        "X-Snapshot-Seq": "" if snapshot_seq is None else str(snapshot_seq),
        "Cache-Control": "no-store",
    }
    return Response(content=state_blob, media_type="application/json", headers=headers)


@app.get("/health")
def health() -> Response:
    return json_response({"status": "ok", "latest_seq": store.latest_seq()})


@app.post("/events")
async def append_event(request: Request) -> Response:
    event = await read_event_body(request)
    result = store.append(event)
    return json_response(result, status_code=201)


@app.get("/events/{seq}")
def get_event(seq: int) -> Response:
    result = store.get_event(seq)
    if result is None:
        raise HTTPException(status_code=404, detail=f"event {seq} not found")
    return json_response(result)


@app.get("/events")
def list_events(start: int = Query(1, ge=1), limit: int = Query(1000, ge=1, le=10000)) -> Response:
    events = []
    for item in store.iter_events(start):
        events.append(item)
        if len(events) >= limit:
            break
    return json_response({"events": events})


@app.get("/chain/head")
def chain_head() -> Response:
    return json_response(
        {"latest_seq": store.latest_seq(), "head_hash": store.head_hash()}
    )


@app.get("/verify")
def verify_chain(from_seq: int = Query(1, alias="from_seq")) -> Response:
    # Always HTTP 200: a failed verification is a valid answer, not a server
    # error. The body states explicitly whether everything is correct.
    return json_response(store.verify(from_seq))


@app.get("/state")
def current_state() -> Response:
    """Current state, using the newest snapshot plus increments."""
    state_blob, target, snapshot_seq = store.replay_from_snapshot()
    method = "snapshot+increments" if snapshot_seq is not None else "full-replay"
    return state_response(state_blob, target, method, snapshot_seq)


@app.get("/state/replay")
def full_replay_state() -> Response:
    """Current state produced by full replay from seq 1."""
    state_blob, target = store.replay_full()
    return state_response(state_blob, target, "full-replay", None)


@app.get("/state/history/{seq}")
def historical_state(seq: int, use_snapshot: bool = False) -> Response:
    """State exactly after event *seq* (seq 0 = empty initial state)."""
    try:
        if use_snapshot:
            state_blob, target, snapshot_seq = store.replay_from_snapshot(seq)
            method = "snapshot+increments" if snapshot_seq is not None else "full-replay"
            return state_response(state_blob, target, method, snapshot_seq)
        state_blob, target = store.replay_full(seq)
        return state_response(state_blob, target, "full-replay", None)
    except StoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/snapshots")
async def create_snapshot(request: Request) -> Response:
    raw = await request.body()
    at_seq = None
    if raw.strip():
        try:
            body = loads(raw)
        except CanonicalError as exc:
            raise HTTPException(status_code=400, detail=f"invalid JSON: {exc}") from exc
        if not isinstance(body, dict):
            raise HTTPException(
                status_code=400,
                detail="body must be JSON object with integer 'at_seq'",
            )
        if "at_seq" in body:
            value = body["at_seq"]
            if isinstance(value, bool) or not isinstance(value, int):
                raise HTTPException(
                    status_code=400, detail="'at_seq' must be an integer"
                )
            at_seq = value
    try:
        result = store.create_snapshot(at_seq)
    except StoreError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    payload = {
        "seq": result["seq"],
        "state_hash": result["state_hash"],
        "created_at": result["created_at"],
    }
    return json_response(payload, status_code=201)


@app.get("/snapshots")
def get_snapshots() -> Response:
    return json_response({"snapshots": store.list_snapshots()})


@app.get("/snapshots/verify")
def verify_snapshot() -> Response:
    """Prove snapshot+increments equals full replay, byte-for-byte."""
    full_blob, target = store.replay_full()
    snap_blob, snap_target, snapshot_seq = store.replay_from_snapshot()
    equal = full_blob == snap_blob
    return json_response(
        {
            "ok": equal and target == snap_target,
            "target_seq": target,
            "snapshot_seq": snapshot_seq,
            "full_replay_hash": hashlib.sha256(full_blob).hexdigest(),
            "snapshot_replay_hash": hashlib.sha256(snap_blob).hexdigest(),
            "bytes_equal": equal,
            "reason": "identical" if equal else "state bodies differ",
        }
    )
