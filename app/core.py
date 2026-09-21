"""纯函数核心：规范化编码、哈希链、确定性重放。

本模块不接触数据库，规则集中在这里，保证同一批事件无论在哪里
跑、重启多少次，哈希值与重放结果都逐字节一致。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable

GENESIS_HASH = "0" * 64


class ValidationError(ValueError):
    """事件内容不合法（时间无法解析、出现 NaN/Infinity 等）。"""


def canonical_json(value: Any) -> str:
    """把 JSON 可表达的值规范化成唯一字节序列。

    - 对象键按 UTF-8 码点排序，无空白；
    - 禁止 NaN / Infinity（它们不是合法 JSON，且跨实现不一致）；
    - 整数与浮点保持 JSON 默认往返写法（Python repr 最短往返，
      即 Ryu 算法输出，IEEE-754 binary64 在所有平台逐位一致）；
    - ensure_ascii=False，固定 UTF-8 编码，避免 \\uXXXX 转义差异。
    """
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def normalize_timestamp(value: Any) -> str:
    """把输入时间归一化为 UTC、微秒精度的 ``...Z`` 字符串。

    接受：
    - 数值：Unix 秒（int/float）；
    - 字符串：ISO 8601，允许 ``Z`` 结尾与偏移量；
    - None：由调用方决定是否用服务端时间兜底。

    纳秒及以上精度截断到微秒（向下对齐到微秒边界）。
    """
    if isinstance(value, bool):
        raise ValidationError("timestamp 必须是 ISO 8601 字符串或 Unix 秒数值")
    if isinstance(value, (int, float)):
        try:
            dt = datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError) as exc:
            raise ValidationError(f"无法解析 timestamp: {value!r}") from exc
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            raise ValidationError("timestamp 不能为空字符串")
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError as exc:
            raise ValidationError(f"无法解析 timestamp: {value!r}") from exc
        if dt.tzinfo is None:
            # 朴素时间一律按 UTC 解释，避免依赖机器时区。
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
    else:
        raise ValidationError("timestamp 必须是 ISO 8601 字符串或 Unix 秒数值")

    micros = (dt.microsecond // 1000) * 1000  # 纳秒截断
    dt = dt.replace(microsecond=micros)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def server_timestamp() -> str:
    now = datetime.now(tz=timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def compute_event_hash(
    seq: int,
    prev_hash: str,
    object_id: str,
    action: str,
    timestamp: str,
    fields: Any,
) -> str:
    """计算事件哈希。

    每个字段做长度前缀，杜绝分隔符注入；输入一律按 UTF-8 编码。
    被哈希的“规范化事件”与实际入库内容一致（fields 为规范化 JSON）。
    """
    fields_bytes = canonical_json(fields).encode("utf-8")
    parts = [
        f"event|v1|{seq}",
        str(prev_hash),
        str(object_id),
        str(action),
        str(timestamp),
    ]
    payload = b"".join(
        b"".join([str(len(part.encode("utf-8"))).encode("ascii"), b":", part.encode("utf-8")])
        for part in parts
    )
    payload += str(len(fields_bytes)).encode("ascii") + b":" + fields_bytes
    return hashlib.sha256(payload).hexdigest()


def normalize_event(
    seq: int,
    prev_hash: str,
    object_id: Any,
    action: Any,
    timestamp: Any,
    fields: Any,
) -> dict[str, Any]:
    """校验并规范化一条事件，返回将入库/参与哈希的规范形态。"""
    if not isinstance(object_id, str) or not object_id.strip():
        raise ValidationError("object_id 必须是非空字符串")
    object_id = object_id.strip()
    if not isinstance(action, str) or not action.strip():
        raise ValidationError("action 必须是非空字符串")
    action = action.strip()
    if fields is None:
        fields = {}
    if not isinstance(fields, dict):
        raise ValidationError("fields 必须是 JSON 对象")
    # 提前做一次规范化：NaN/Infinity/循环引用等在这里以 400 拒绝。
    try:
        fields_text = canonical_json(fields)
    except (ValueError, TypeError) as exc:
        raise ValidationError(f"fields 无法规范化为 JSON: {exc}") from exc
    fields = json.loads(fields_text)
    ts = normalize_timestamp(timestamp) if timestamp is not None else server_timestamp()
    event_hash = compute_event_hash(seq, prev_hash, object_id, action, ts, fields)
    return {
        "seq": seq,
        "prev_hash": prev_hash,
        "object_id": object_id,
        "action": action,
        "timestamp": ts,
        "fields": fields,
        "hash": event_hash,
    }


def _is_deleted(fields: dict[str, Any]) -> bool:
    value = fields.get("deleted")
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def apply_event(state: dict[str, Any], event: dict[str, Any]) -> None:
    """把一条事件按规则并入内存状态（就地修改）。

    - 对象首次出现且带 deleted：记为已删除（墓碑）；
    - 带 deleted 真值：删除对象；
    - 其余事件：对象不存在则创建，存在则按顶层字段浅覆盖；
      事件里显式给出的 ``deleted: false`` 会清掉墓碑标记。
    """
    obj_id = event["object_id"]
    fields = event["fields"]
    deleted = _is_deleted(fields)
    if deleted:
        state[obj_id] = {"deleted": True}
        return
    current = state.get(obj_id)
    if current is None or current.get("deleted") is True:
        current = {}
    for key, value in fields.items():
        if key == "deleted":
            continue
        current[key] = value
    state[obj_id] = current


def replay_events(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """按给定顺序（seq 升序）重放事件，得到对象状态。"""
    state: dict[str, Any] = {}
    for event in events:
        apply_event(state, event)
    return state


def state_envelope(
    state: dict[str, Any],
    *,
    to_seq: int,
) -> str:
    """把状态包装成固定的规范化 JSON 文本。

    全量重放与“快照 + 增量”使用完全相同的包装方式，因此字节一致。
    对象按 object_id（UTF-8 码点）排序，内层字段也按键排序。
    """
    envelope = {
        "state": state,
        "meta": {
            "from_seq": 1,
            "to_seq": to_seq,
        },
    }
    return canonical_json(envelope)
