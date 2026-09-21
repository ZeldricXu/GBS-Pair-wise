"""SQLite 持久层。

设计要点
--------
- 单文件数据库（默认 ``data/audit.db``），仅依赖标准库 ``sqlite3``；
- 单进程 + 进程内锁串行写，``BEGIN IMMEDIATE`` 拿全库写锁，
  seq 直接取 ``max+1``，提交即连续、无空洞；
- 事件哈希链之外另存一条头指针（最新 seq/hash 与创世锚点），
  抽掉中间任意一条或砍掉整个尾巴都能在校验时暴露。
"""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from .core import (
    GENESIS_HASH,
    ValidationError,
    apply_event,
    compute_event_hash,
    normalize_event,
    replay_events,
    server_timestamp,
    state_envelope,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    seq        INTEGER PRIMARY KEY,
    prev_hash  TEXT NOT NULL,
    hash       TEXT NOT NULL,
    object_id  TEXT NOT NULL,
    action     TEXT NOT NULL,
    timestamp  TEXT NOT NULL,
    fields     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    genesis_hash TEXT NOT NULL,
    last_seq     INTEGER NOT NULL,
    last_hash    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
    seq        INTEGER PRIMARY KEY,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


class StoreError(RuntimeError):
    """存储层错误（数据库损坏、IO 失败等）。"""


def _row_to_event(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "seq": row["seq"],
        "prev_hash": row["prev_hash"],
        "hash": row["hash"],
        "object_id": row["object_id"],
        "action": row["action"],
        "timestamp": row["timestamp"],
        "fields": json.loads(row["fields"]),
    }


class Store:
    def __init__(self, db_path: str):
        self.db_path = db_path
        path = Path(db_path)
        if path.parent != Path(""):
            path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        with self._conn:
            self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ------------------------------------------------------------------ 写入
    def append_event(
        self,
        object_id: Any,
        action: Any,
        timestamp: Any,
        fields: Any,
    ) -> dict[str, Any]:
        """串行追加一条事件，返回含连续 seq 与哈希的规范事件。"""
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                row = self._conn.execute(
                    "SELECT last_seq, last_hash FROM meta WHERE id = 1"
                ).fetchone()
                if row is None:
                    seq = 1
                    prev_hash = GENESIS_HASH
                else:
                    seq = row["last_seq"] + 1
                    prev_hash = row["last_hash"]
                event = normalize_event(
                    seq, prev_hash, object_id, action, timestamp, fields
                )
                self._conn.execute(
                    "INSERT INTO events (seq, prev_hash, hash, object_id, action,"
                    " timestamp, fields) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        event["seq"],
                        event["prev_hash"],
                        event["hash"],
                        event["object_id"],
                        event["action"],
                        event["timestamp"],
                        canonical_fields(event["fields"]),
                    ),
                )
                self._conn.execute(
                    "INSERT INTO meta (id, genesis_hash, last_seq, last_hash)"
                    " VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET"
                    " last_seq = excluded.last_seq, last_hash = excluded.last_hash",
                    (GENESIS_HASH, event["seq"], event["hash"]),
                )
                self._conn.commit()
            except ValidationError:
                self._conn.rollback()
                raise
            except sqlite3.Error as exc:
                self._conn.rollback()
                raise StoreError(f"写入失败: {exc}") from exc
            return event

    # ------------------------------------------------------------------ 读取
    def _fetch_range(self, from_seq: int, to_seq: int) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq ASC",
            (from_seq, to_seq),
        ).fetchall()
        return [_row_to_event(row) for row in rows]

    def head(self) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT genesis_hash, last_seq, last_hash FROM meta WHERE id = 1"
        ).fetchone()
        if row is None:
            return {"last_seq": 0, "last_hash": GENESIS_HASH, "genesis_hash": GENESIS_HASH}
        return dict(row)

    def get_event(self, seq: int) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT * FROM events WHERE seq = ?", (seq,)
        ).fetchone()
        return _row_to_event(row) if row is not None else None

    def list_events(self, limit: int | None = None, after: int = 0) -> list[dict[str, Any]]:
        if limit is None:
            rows = self._conn.execute(
                "SELECT * FROM events WHERE seq > ? ORDER BY seq ASC", (after,)
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
                (after, limit),
            ).fetchall()
        return [_row_to_event(row) for row in rows]

    # ------------------------------------------------------------------ 校验
    def verify_chain(self, start_seq: int = 1) -> dict[str, Any]:
        """从 start_seq 校验到最新。

        覆盖：创世锚点、序号空洞、prev_hash 断链、单条内容哈希、头指针/截尾。
        """
        with self._lock:
            meta = self.head()
            last_seq = meta["last_seq"]
            if last_seq == 0:
                return {
                    "ok": True,
                    "checked_from": start_seq,
                    "checked_to": 0,
                    "count": 0,
                    "message": "事件流为空，没有可校验的记录",
                }
            if start_seq < 1 or start_seq > last_seq:
                raise StoreError(f"start_seq 必须在 1..{last_seq} 之间")

            events = self._fetch_range(start_seq, last_seq)

            if start_seq == 1:
                expected_prev = meta["genesis_hash"]
            else:
                anchor = self.get_event(start_seq - 1)
                if anchor is None:
                    return {
                        "ok": False,
                        "first_mismatch": start_seq - 1,
                        "reason": "missing_anchor",
                        "expected": f"序号 {start_seq - 1} 应存在",
                        "actual": None,
                    }
                expected_prev = anchor["hash"]

            expected_seq = start_seq
            last_hash = GENESIS_HASH
            for event in events:
                if event["seq"] != expected_seq:
                    return {
                        "ok": False,
                        "first_mismatch": expected_seq,
                        "reason": "seq_gap",
                        "expected": expected_seq,
                        "actual": event["seq"],
                    }
                if event["prev_hash"] != expected_prev:
                    return {
                        "ok": False,
                        "first_mismatch": event["seq"],
                        "reason": "prev_hash_mismatch",
                        "expected": expected_prev,
                        "actual": event["prev_hash"],
                    }
                actual_hash = compute_event_hash(
                    event["seq"],
                    event["prev_hash"],
                    event["object_id"],
                    event["action"],
                    event["timestamp"],
                    event["fields"],
                )
                if event["hash"] != actual_hash:
                    return {
                        "ok": False,
                        "first_mismatch": event["seq"],
                        "reason": "hash_mismatch",
                        "expected": actual_hash,
                        "actual": event["hash"],
                    }
                expected_prev = event["hash"]
                last_hash = event["hash"]
                expected_seq += 1

            got = events[-1]["seq"]
            if got != last_seq or last_hash != meta["last_hash"]:
                mismatch_at = min(got + 1, last_seq) if got < last_seq else last_seq
                return {
                    "ok": False,
                    "first_mismatch": mismatch_at,
                    "reason": "head_pointer_mismatch",
                    "expected": {"seq": last_seq, "hash": meta["last_hash"]},
                    "actual": {"seq": got, "hash": last_hash},
                }
            return {
                "ok": True,
                "checked_from": start_seq,
                "checked_to": last_seq,
                "count": len(events),
                "last_hash": last_hash,
            }

    # ------------------------------------------------------------------ 快照
    def create_snapshot(self, seq: int | None = None) -> dict[str, Any]:
        with self._lock:
            last_seq = self.head()["last_seq"]
            if seq is None:
                seq = last_seq
            if seq < 0 or seq > last_seq:
                raise StoreError(f"seq 必须在 0..{last_seq} 之间")
            events = self._fetch_range(1, seq)
            state = replay_events(events)
            state_text = state_envelope(
                state,
                to_seq=seq,
            )
            created_at = server_timestamp()
            self._conn.execute(
                "INSERT INTO snapshots (seq, state_json, created_at) VALUES (?, ?, ?)"
                " ON CONFLICT(seq) DO UPDATE SET state_json = excluded.state_json,"
                " created_at = excluded.created_at",
                (seq, state_text, created_at),
            )
            self._conn.commit()
            return {
                "seq": seq,
                "created_at": created_at,
                "state_sha256": sha256_text(state_text),
            }

    def list_snapshots(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT seq, created_at, state_json FROM snapshots ORDER BY seq ASC"
        ).fetchall()
        return [
            {
                "seq": row["seq"],
                "created_at": row["created_at"],
                "state_sha256": sha256_text(row["state_json"]),
            }
            for row in rows
        ]

    def load_snapshot_state(self, seq: int) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT state_json FROM snapshots WHERE seq = ?", (seq,)
        ).fetchone()
        if row is None:
            return None
        return json.loads(row["state_json"])["state"]

    def state_at(
        self,
        seq: int | None = None,
        *,
        use_snapshot: bool = True,
    ) -> tuple[str, str, int | None]:
        """返回 (规范化结果文本, 模式, 基准快照 seq)。"""
        with self._lock:
            last_seq = self.head()["last_seq"]
            if seq is None:
                seq = last_seq
            if seq < 0 or seq > last_seq:
                raise StoreError(f"seq 必须在 0..{last_seq} 之间")

            if use_snapshot and seq > 0:
                snap_seq = self._conn.execute(
                    "SELECT MAX(seq) AS m FROM snapshots WHERE seq <= ?", (seq,)
                ).fetchone()["m"]
            else:
                snap_seq = None

            if snap_seq is not None:
                state = self.load_snapshot_state(snap_seq)
                if state is None:  # pragma: no cover - 读取受同一把锁保护
                    raise StoreError("快照读取失败")
                for event in self._fetch_range(snap_seq + 1, seq):
                    apply_event(state, event)
                mode = "snapshot+incremental"
                base = snap_seq
            else:
                state = replay_events(self._fetch_range(1, seq))
                mode = "full"
                base = None

            text = state_envelope(
                state,
                to_seq=seq,
            )
            return text, mode, base


def canonical_fields(fields: Any) -> str:
    return json.dumps(
        fields, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    )


def sha256_text(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()
