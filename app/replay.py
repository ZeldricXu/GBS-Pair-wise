"""Deterministic event replay.

Reduction rules (identical for full replay and snapshot catch-up):

* An event whose ``deleted`` field is exactly ``true`` deletes the object;
  after deletion the object is absent until a later event creates it again.
* The first non-deleted event for an object creates it.
* Every later non-deleted event overwrites object fields one by one. The
  ``id`` and ``deleted`` fields are never stored as state fields (they are
  event routing markers, not object data).

The reducer is a pure function of the event records: no wall clock, no random
numbers, no iteration over unordered structures, no implicit float
conversion. Replaying the same sequence always yields identical canonical
JSON bytes.
"""

from __future__ import annotations

from typing import Any

from .canonical import dumps


def apply_event(state: dict[str, dict[str, Any]], event: dict[str, Any]) -> None:
    obj_id = event["id"]
    if event.get("deleted") is True:
        state.pop(obj_id, None)
        return
    fields = {key: val for key, val in event.items() if key not in ("id", "deleted")}
    current = state.get(obj_id)
    if current is None:
        state[obj_id] = fields
    else:
        current.update(fields)


def reduce_events(
    events: list[dict[str, Any]],
    base: dict[str, dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    state: dict[str, dict[str, Any]] = {}
    if base is not None:
        state.update(base)
    for event in events:
        apply_event(state, event)
    return state


def encode_state(state: dict[str, dict[str, Any]]) -> bytes:
    """Serialize state to canonical JSON bytes.

    Top-level key order and nested field order are sorted, so the output is
    byte-identical regardless of insertion order.
    """
    ordered = {key: state[key] for key in sorted(state)}
    return dumps(ordered)
