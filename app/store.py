"""Append-only sqlite storage with a hash chain and snapshots.

Hash chain
----------
Every event record carries::

    seq          1, 2, 3, ... (no gaps, enforced by the primary key)
    prev_hash    hex sha256 of the previous record (64 zeroes for seq 1)
    record       canonical JSON of {seq, prev_hash, timestamp, event}
    record_hash  hex sha256(record)

Verification hashes the stored ``record`` blob itself and compares it against
the stored ``record_hash``, then checks chain linkage and sequence
contiguity, so changing any single byte of an event payload, forging a hash,
or deleting a row is detected.

WAL is intentionally disabled: with the rollback journal and
``synchronous=FULL`` every commit is fsynced, so a returned sequence number
means the event is already on disk and there is just one ordinary database
file for auditors to inspect.

A process-wide lock serializes writers. Readers open a fresh connection per
operation, which also guarantees on-disk tampering is observed immediately.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Any, Iterator

from .canonical import dumps, loads
from .replay import apply_event, encode_state

GENESIS_HASH = "0" * 64

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    seq         INTEGER PRIMARY KEY,
    prev_hash   TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    record      BLOB NOT NULL,
    record_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
    seq        INTEGER PRIMARY KEY,
    state      BLOB NOT NULL,
    state_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


class StoreError(RuntimeError):
    pass


def _row_to_event(row: sqlite3.Row) -> dict[str, Any]:
    record = loads(bytes(row["record"]))
    return {
        "seq": record["seq"],
        "prev_hash": record["prev_hash"],
        "timestamp": record["timestamp"],
        "event": record["event"],
        "record_hash": row["record_hash"],
    }


class EventStore:
    def __init__(self, path: str) -> None:
        self.path = path
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        self._write_lock = threading.Lock()
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.row_factory = sqlite3.Row
        return conn

    # -- writing -----------------------------------------------------------

    def append(self, event: dict[str, Any]) -> dict[str, Any]:
        """Append one event and return its complete stored record."""
        event_blob = dumps(event)
        stored_event = loads(event_blob)
        timestamp = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        with self._write_lock:
            conn = self._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute(
                    "SELECT seq, record_hash FROM events "
                    "ORDER BY seq DESC LIMIT 1"
                ).fetchone()
                if row is None:
                    seq = 1
                    prev_hash = GENESIS_HASH
                else:
                    seq = row["seq"] + 1
                    prev_hash = row["record_hash"]
                record = {
                    "seq": seq,
                    "prev_hash": prev_hash,
                    "timestamp": timestamp,
                    "event": stored_event,
                }
                record_blob = dumps(record)
                record_hash = hashlib.sha256(record_blob).hexdigest()
                conn.execute(
                    "INSERT INTO events "
                    "(seq, prev_hash, timestamp, record, record_hash) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        seq,
                        prev_hash,
                        timestamp,
                        record_blob,
                        record_hash,
                    ),
                )
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            finally:
                conn.close()
        return {
            "seq": seq,
            "prev_hash": prev_hash,
            "timestamp": timestamp,
            "event": stored_event,
            "record_hash": record_hash,
        }

    def create_snapshot(self, at_seq: int | None = None) -> dict[str, Any]:
        """Reduce events [1..at_seq] (or all) and persist the state."""
        with self._write_lock:
            conn = self._connect()
            try:
                latest = conn.execute(
                    "SELECT COALESCE(MAX(seq), 0) AS m FROM events"
                ).fetchone()["m"]
                target = latest if at_seq is None else at_seq
                if target < 0 or target > latest:
                    raise StoreError(f"snapshot target seq {target} does not exist")
                base_row = conn.execute(
                    "SELECT seq, state FROM snapshots WHERE seq <= ? "
                    "ORDER BY seq DESC LIMIT 1",
                    (target,),
                ).fetchone()
                state: dict[str, dict[str, Any]] = {}
                start_seq = 0
                if base_row is not None:
                    state.update(loads(base_row["state"]))
                    start_seq = base_row["seq"]
                rows = conn.execute(
                    "SELECT record FROM events WHERE seq > ? AND seq <= ? "
                    "ORDER BY seq ASC",
                    (start_seq, target),
                ).fetchall()
                for row in rows:
                    apply_event(state, loads(bytes(row["record"]))["event"])
                state_blob = encode_state(state)
                state_hash = hashlib.sha256(state_blob).hexdigest()
                created_at = datetime.now(timezone.utc).isoformat(
                    timespec="microseconds"
                )
                conn.execute(
                    "INSERT INTO snapshots (seq, state, state_hash, created_at) "
                    "VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(seq) DO UPDATE SET "
                    "state=excluded.state, state_hash=excluded.state_hash, "
                    "created_at=excluded.created_at",
                    (target, state_blob, state_hash, created_at),
                )
            finally:
                conn.close()
        return {
            "seq": target,
            "state_hash": state_hash,
            "created_at": created_at,
            "state": state_blob,
        }

    # -- reading -----------------------------------------------------------

    def latest_seq(self) -> int:
        with self._connect() as conn:
            return conn.execute(
                "SELECT COALESCE(MAX(seq), 0) AS m FROM events"
            ).fetchone()["m"]

    def head_hash(self) -> str | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT record_hash FROM events ORDER BY seq DESC LIMIT 1"
            ).fetchone()
        return None if row is None else row["record_hash"]

    def get_event(self, seq: int) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT record, record_hash "
                "FROM events WHERE seq = ?",
                (seq,),
            ).fetchone()
        return None if row is None else _row_to_event(row)

    def iter_events(self, start: int = 1) -> Iterator[dict[str, Any]]:
        conn = self._connect()
        try:
            for row in conn.execute(
                "SELECT record, record_hash "
                "FROM events WHERE seq >= ? ORDER BY seq ASC",
                (start,),
            ):
                yield _row_to_event(row)
        finally:
            conn.close()

    def latest_snapshot(self, at_most: int | None = None) -> dict[str, Any] | None:
        with self._connect() as conn:
            if at_most is None:
                row = conn.execute(
                    "SELECT seq, state, state_hash, created_at FROM snapshots "
                    "ORDER BY seq DESC LIMIT 1"
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT seq, state, state_hash, created_at FROM snapshots "
                    "WHERE seq <= ? ORDER BY seq DESC LIMIT 1",
                    (at_most,),
                ).fetchone()
        if row is None:
            return None
        return {
            "seq": row["seq"],
            "state": bytes(row["state"]),
            "state_hash": row["state_hash"],
            "created_at": row["created_at"],
        }

    def list_snapshots(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT seq, state_hash, created_at FROM snapshots ORDER BY seq ASC"
            ).fetchall()
        return [dict(row) for row in rows]

    # -- verification ------------------------------------------------------

    def verify(self, start: int = 1) -> dict[str, Any]:
        """Verify from *start* through the latest event.

        Checks, in order:
        1. the range starts at an existing record (or seq 1 on an empty log);
        2. sequence numbers are contiguous (no gaps / extracted rows);
        3. each stored ``record`` blob hashes to its stored ``record_hash``;
        4. each record's ``prev_hash`` equals the previous record's hash.

        Returns the first mismatch position; ``ok=true`` means all correct.
        """
        if start < 1:
            return {"ok": False, "at_seq": start, "reason": "invalid start sequence"}
        try:
            conn = self._connect()
            try:
                latest = conn.execute(
                    "SELECT COALESCE(MAX(seq), 0) AS m FROM events"
                ).fetchone()["m"]
                if latest == 0:
                    if start == 1:
                        return {"ok": True, "checked": 0, "from_seq": 1, "to_seq": 0}
                    return {
                        "ok": False,
                        "at_seq": start,
                        "reason": "sequence does not exist",
                    }
                if start > latest:
                    return {
                        "ok": False,
                        "at_seq": start,
                        "reason": "sequence does not exist",
                    }

                if start == 1:
                    expected_seq = 1
                    expected_prev = GENESIS_HASH
                else:
                    anchor = conn.execute(
                        "SELECT record_hash FROM events WHERE seq = ?",
                        (start - 1,),
                    ).fetchone()
                    first = conn.execute(
                        "SELECT prev_hash FROM events WHERE seq = ?", (start,)
                    ).fetchone()
                    if anchor is None or first is None:
                        return {
                            "ok": False,
                            "at_seq": start,
                            "reason": "gap: expected this sequence but it is missing",
                        }
                    expected_prev = anchor["record_hash"]
                    expected_seq = start

                rows = conn.execute(
                    "SELECT seq, prev_hash, record, record_hash FROM events "
                    "WHERE seq >= ? ORDER BY seq ASC",
                    (start,),
                ).fetchall()
            finally:
                conn.close()
        except sqlite3.DatabaseError as exc:
            return {"ok": False, "at_seq": None, "reason": f"database error: {exc}"}

        count = 0
        for row in rows:
            if row["seq"] != expected_seq:
                return {
                    "ok": False,
                    "at_seq": expected_seq,
                    "reason": "gap: expected this sequence but it is missing",
                }
            actual_hash = hashlib.sha256(bytes(row["record"])).hexdigest()
            if actual_hash != row["record_hash"]:
                return {
                    "ok": False,
                    "at_seq": row["seq"],
                    "reason": "hash mismatch: record content was modified",
                    "expected_hash": row["record_hash"],
                    "actual_hash": actual_hash,
                }
            if row["prev_hash"] != expected_prev:
                return {
                    "ok": False,
                    "at_seq": row["seq"],
                    "reason": "chain broken: prev_hash does not match predecessor",
                    "expected_prev_hash": expected_prev,
                    "actual_prev_hash": row["prev_hash"],
                }
            expected_prev = row["record_hash"]
            expected_seq += 1
            count += 1

        return {"ok": True, "checked": count, "from_seq": start, "to_seq": latest}

    # -- replay / state ----------------------------------------------------

    def replay_full(self, up_to: int | None = None) -> tuple[bytes, int]:
        """Full replay from seq 1; return (canonical state bytes, target seq)."""
        state: dict[str, dict[str, Any]] = {}
        with self._connect() as conn:
            latest = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) AS m FROM events"
            ).fetchone()["m"]
            target = latest if up_to is None else up_to
            if target < 0 or target > latest:
                raise StoreError(f"sequence {target} does not exist")
            rows = conn.execute(
                "SELECT record FROM events WHERE seq <= ? ORDER BY seq ASC",
                (target,),
            ).fetchall()
        for row in rows:
            apply_event(state, loads(bytes(row["record"]))["event"])
        return encode_state(state), target

    def replay_from_snapshot(
        self, up_to: int | None = None
    ) -> tuple[bytes, int, int | None]:
        """Replay using the newest eligible snapshot plus increments.

        Return (canonical state bytes, target seq, snapshot seq or None).
        Without a snapshot this is a plain full replay.
        """
        with self._connect() as conn:
            latest = conn.execute(
                "SELECT COALESCE(MAX(seq), 0) AS m FROM events"
            ).fetchone()["m"]
            target = latest if up_to is None else up_to
            if target < 0 or target > latest:
                raise StoreError(f"sequence {target} does not exist")
            snap_row = conn.execute(
                "SELECT seq, state FROM snapshots WHERE seq <= ? "
                "ORDER BY seq DESC LIMIT 1",
                (target,),
            ).fetchone()
            state: dict[str, dict[str, Any]] = {}
            if snap_row is None:
                snapshot_seq = None
                rows = conn.execute(
                    "SELECT record FROM events WHERE seq <= ? ORDER BY seq ASC",
                    (target,),
                ).fetchall()
            else:
                snapshot_seq = snap_row["seq"]
                state.update(loads(snap_row["state"]))
                rows = conn.execute(
                    "SELECT record FROM events WHERE seq > ? AND seq <= ? "
                    "ORDER BY seq ASC",
                    (snapshot_seq, target),
                ).fetchall()
        for row in rows:
            apply_event(state, loads(bytes(row["record"]))["event"])
        return encode_state(state), target, snapshot_seq
