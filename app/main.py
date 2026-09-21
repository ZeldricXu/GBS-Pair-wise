"""审计服务 HTTP 接口（FastAPI）。"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from .core import ValidationError
from .store import Store, StoreError

DB_PATH = os.environ.get("AUDIT_DB", "data/audit.db")

app = FastAPI(
    title="Audit Service",
    description="只增不改的哈希链审计日志 + 确定性状态重放 + 快照",
    version="1.0.0",
)
store = Store(DB_PATH)


@app.exception_handler(ValidationError)
async def _validation_error_handler(_request: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": "invalid_event", "detail": str(exc)})


@app.exception_handler(StoreError)
async def _store_error_handler(_request: Request, exc: StoreError) -> JSONResponse:
    status_code = 400 if "必须在" in str(exc) else 500
    return JSONResponse(status_code=status_code, content={"error": "store_error", "detail": str(exc)})


@app.exception_handler(sqlite3.Error)
async def _sqlite_error_handler(_request: Request, exc: sqlite3.Error) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"error": "database_error", "detail": "数据库无法读取（文件可能已损坏或被篡改）"},
    )


class EventIn(BaseModel):
    model_config = {"extra": "forbid"}

    object_id: str = Field(..., description="被操作对象的唯一标识")
    action: str = Field(..., description="操作类型，如 create/update/delete")
    timestamp: str | int | float | None = Field(
        default=None, description="ISO 8601 字符串或 Unix 秒；省略则服务端填 UTC 当前时间"
    )
    fields: dict[str, Any] | None = Field(
        default=None, description="对象字段；带 deleted 真值表示删除，其余按字段覆盖"
    )


class SnapshotIn(BaseModel):
    model_config = {"extra": "forbid"}

    seq: int | None = Field(default=None, description="快照截到的事件序号，默认最新")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok"}


@app.post("/events", status_code=201)
def post_event(payload: EventIn) -> dict[str, Any]:
    event = store.append_event(
        payload.object_id, payload.action, payload.timestamp, payload.fields
    )
    return event


@app.get("/events")
def get_events(limit: int | None = None, after: int = 0) -> dict[str, Any]:
    if limit is not None and limit < 1:
        raise StoreError("limit 必须 >= 1")
    if after < 0:
        raise StoreError("after 必须 >= 0")
    return {"events": store.list_events(limit=limit, after=after)}


@app.get("/events/{seq}")
def get_event(seq: int) -> dict[str, Any]:
    event = store.get_event(seq)
    if event is None:
        return JSONResponse(
            status_code=404, content={"error": "not_found", "detail": f"事件 {seq} 不存在"}
        )
    return event


@app.get("/head")
def get_head() -> dict[str, Any]:
    return store.head()


@app.get("/verify")
def verify(start_seq: int = 1) -> dict[str, Any]:
    """从 start_seq 校验哈希链到最新一条；全对时 ok=true。"""
    return store.verify_chain(start_seq)


def _state_response(seq: int | None, *, use_snapshot: bool) -> Response:
    text, mode, base = store.state_at(seq, use_snapshot=use_snapshot)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return Response(
        content=text,
        media_type="application/json",
        headers={
            "X-Replay-Mode": mode,
            "X-Base-Snapshot-Seq": "" if base is None else str(base),
            "X-State-SHA256": digest,
        },
    )


@app.get("/state")
def get_state(seq: int | None = None, mode: str = "auto") -> Response:
    """重放出某时间点（某 seq）的对象状态。

    mode=full 强制全量重放；mode=auto 优先“最近快照 + 增量”。
    两条路径的 state 部分逐字节相同，可用 /replay/check 核对。
    """
    if mode not in ("auto", "full"):
        raise StoreError("mode 只支持 auto 或 full")
    return _state_response(seq, use_snapshot=(mode == "auto"))


@app.post("/snapshots", status_code=201)
def post_snapshot(payload: SnapshotIn) -> dict[str, Any]:
    return store.create_snapshot(payload.seq)


@app.get("/snapshots")
def get_snapshots() -> dict[str, Any]:
    return {"snapshots": store.list_snapshots()}


@app.get("/replay/check")
def replay_check(seq: int | None = None) -> dict[str, Any]:
    """对比全量重放与“快照 + 增量”，要求 state 部分逐字节相同。"""
    full_text, _, _ = store.state_at(seq, use_snapshot=False)
    fast_text, fast_mode, base = store.state_at(seq, use_snapshot=True)
    to_seq = json.loads(full_text)["meta"]["to_seq"]
    equal = full_text == fast_text
    return {
        "ok": equal,
        "seq": to_seq,
        "snapshot_used": fast_mode == "snapshot+incremental",
        "base_snapshot_seq": base,
        "full_state_sha256": hashlib.sha256(full_text.encode()).hexdigest(),
        "fast_state_sha256": hashlib.sha256(fast_text.encode()).hexdigest(),
        "detail": "快照+增量 与全量重放 state 逐字节一致"
        if equal
        else "快照+增量 与全量重放结果不一致，快照或事件可能已被篡改",
    }
