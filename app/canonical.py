"""Deterministic JSON handling.

Determinism rules applied everywhere in this service:

* Object members are always emitted in sorted (UTF-8) key order.
* No insignificant whitespace.
* Non-ASCII characters are never escaped, so the bytes do not depend on the
* Separator/structural characters are fixed (``,`` ``:``).
* Floats are emitted with ``repr()``, which yields the shortest round-trippable
  representation of the IEEE-754 double; NaN/Infinity are rejected rather than
  emitted as non-standard JSON tokens.
* Parsing rejects duplicated object keys, trailing content and the
  non-standard ``NaN``/``Infinity`` tokens, so every accepted document has
  exactly one meaning.

The encoding is therefore a canonical form: equal values always produce
identical bytes, on every run, process and machine.
"""

from __future__ import annotations

import json
from typing import Any


class CanonicalError(ValueError):
    """Raised when a value cannot be represented canonically."""


def dumps(value: Any) -> bytes:
    """Encode *value* to canonical JSON bytes (UTF-8)."""
    return _encode(value).encode("utf-8")


def loads(data: bytes | str) -> Any:
    """Parse JSON strictly.

    Rejects duplicated keys, NaN, Infinity and trailing content.
    """
    try:
        return json.loads(
            data,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except CanonicalError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise CanonicalError(str(exc)) from exc


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, val in pairs:
        if key in result:
            raise CanonicalError(f"duplicate JSON object key: {key!r}")
        result[key] = val
    return result


def _reject_constant(token: str) -> Any:
    raise CanonicalError(f"non-standard JSON constant not allowed: {token}")


def _encode(value: Any) -> str:
    if value is None or isinstance(value, bool):
        return "true" if value is True else ("false" if value is False else "null")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise CanonicalError("NaN and Infinity are not allowed")
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_encode(item) for item in value) + "]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise CanonicalError("object keys must be strings")
        return (
            "{"
            + ",".join(
                json.dumps(key, ensure_ascii=False) + ":" + _encode(value[key])
                for key in sorted(value)
            )
            + "}"
        )
    raise CanonicalError(f"type cannot be encoded canonically: {type(value)!r}")
