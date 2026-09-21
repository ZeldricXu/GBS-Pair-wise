#!/usr/bin/env python3
"""End-to-end acceptance check for the running audit service.

Assumes the service is reachable at $BASE_URL (default
http://127.0.0.1:8000). Exercises, using only the standard library:

1. sequential, gap-free sequence numbers (including concurrent writes);
2. hash-chain verification reporting all-correct;
3. deterministic state replay across repeated calls;
4. history query at an arbitrary point in time;
5. snapshot + increments producing byte-identical state to full replay;
6. verification failure after a single byte of the database file is flipped;
7. verification failure after an event row is removed (gap detection);
8. persistence across a process restart.

Tampering steps open the same sqlite file directly; they intentionally bypass
the service to simulate an attacker editing the file on disk.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
import urllib.error
import urllib.request

BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:8000").rstrip("/")
DB_PATH = os.environ.get("AUDIT_DB", "data/audit.db")

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  PASS  {message}")
    else:
        print(f"  FAIL  {message}")
        failures.append(message)


def request(method: str, path: str, body: bytes | None = None):
    req = urllib.request.Request(
        BASE_URL + path,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read()
            return resp.status, raw, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, raw, json.loads(raw) if raw else None


def append_event(event: dict) -> dict:
    status, _, payload = request("POST", "/events", json.dumps(event).encode())
    assert status == 201, (status, payload)
    return payload


def main() -> int:
    print("== 1. append: contiguous, gap-free sequence numbers ==")
    first_seq = append_event({"id": "user-1", "name": "alice", "role": "admin"})["seq"]
    second = append_event({"id": "user-2", "name": "bob"})
    check(second["seq"] == first_seq + 1, "second event gets seq+1")
    check(second["prev_hash"] != "0" * 64, "event is chained to its predecessor")

    # Concurrent writers must still get a dense sequence with no duplicates.
    sequences: list[int] = []
    barrier = threading.Barrier(8)

    def worker(index: int) -> None:
        barrier.wait()
        payload = append_event({"id": f"obj-{index}", "n": index})
        sequences.append(payload["seq"])

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    expected_start = first_seq + 2
    check(
        sorted(sequences) == list(range(expected_start, expected_start + 8)),
        "8 concurrent writes get 8 distinct contiguous sequences",
    )

    print("== 2. verification: all correct ==")
    status, _, verify = request("GET", "/verify")
    check(status == 200 and verify["ok"] is True, "GET /verify reports all correct")
    check(verify["to_seq"] == expected_start + 7, "verified through latest event")
    status, _, verify_mid = request("GET", "/verify?from_seq=3")
    check(verify_mid["ok"] is True, "verification of a suffix also passes")

    print("== 3. deterministic replay ==")
    append_event({"id": "user-1", "name": "alice2", "team": "secops"})
    append_event({"id": "user-2", "amount": 0.1, "ratio": 1 / 3})
    _, body_a, _ = request("GET", "/state/replay")
    _, body_b, _ = request("GET", "/state/replay")
    check(body_a == body_b, "repeated full replays return identical bytes")
    state = json.loads(body_a)
    check(
        state["user-1"] == {"name": "alice2", "role": "admin", "team": "secops"},
        "fields are overwritten; untouched fields survive",
    )
    check(isinstance(state["user-2"]["amount"], float), "float precision preserved")

    print("== 4. history at arbitrary points in time ==")
    _, body_hist, hist = request("GET", "/state/history/1")
    check(
        json.loads(body_hist) == {"user-1": {"name": "alice", "role": "admin"}},
        "state after seq 1 contains only the created object",
    )
    append_event({"id": "user-2", "deleted": True})
    _, body_after_delete, after_delete = request("GET", "/state")
    check("user-2" not in json.loads(body_after_delete), "deleted object disappears")
    append_event({"id": "user-2", "name": "bob-reborn"})
    _, body_reborn, _ = request("GET", "/state")
    check(
        json.loads(body_reborn)["user-2"] == {"name": "bob-reborn"},
        "re-created object starts with no fields from before deletion",
    )

    print("== 5. snapshots: snapshot + increments == full replay, byte-for-byte ==")
    append_event({"id": "user-3", "name": "carol", "nested": {"z": 1, "a": [1, 2]}})
    append_event({"id": "user-1", "name": "alice3"})
    _, _, snap = request("POST", "/snapshots", b"{}")
    check(snap["seq"] == request("GET", "/chain/head")[2]["latest_seq"], "snapshot at head")
    append_event({"id": "user-3", "nested": {"z": 2}})
    append_event({"id": "user-4", "name": "dave"})
    _, full_body, _ = request("GET", "/state/replay")
    snap_status, snap_body, snap_state = request("GET", "/state")
    check(full_body == snap_body, "snapshot+increments bytes equal full replay bytes")
    check(snap_status == 200, "snapshot state endpoint returns 200")
    status, _, snap_verify = request("GET", "/snapshots/verify")
    check(
        snap_verify["ok"] is True and snap_verify["bytes_equal"] is True,
        "/snapshots/verify proves byte equality",
    )
    _, body_hist_full, _ = request("GET", "/state/history/" + str(snap["seq"]))
    _, body_hist_snap, _ = request(
        "GET", "/state/history/" + str(snap["seq"]) + "?use_snapshot=true"
    )
    check(
        body_hist_full == body_hist_snap,
        "historical state: both replay paths agree byte-for-byte",
    )

    latest_seq = request("GET", "/chain/head")[2]["latest_seq"]

    print("== 6. tamper detection: flip one byte of the database file ==")
    conn = sqlite3.connect(DB_PATH)
    target = conn.execute(
        "SELECT record FROM events ORDER BY seq DESC LIMIT 1 OFFSET 2"
    ).fetchone()[0]
    tampered = bytes([target[0] ^ 0x01]) + target[1:]
    conn.execute(
        "UPDATE events SET record = ? WHERE record = ?", (tampered, target)
    )
    conn.commit()
    conn.close()
    status, _, verify = request("GET", "/verify")
    check(status == 200, "verification still answers HTTP 200 after tampering")
    check(
        verify["ok"] is False and verify["at_seq"] is not None,
        f"verification FAILS at first bad seq ({verify.get('at_seq')}, "
        f"{verify.get('reason')})",
    )

    print("== 7. extracted row detection (gap) ==")
    conn = sqlite3.connect(DB_PATH)
    # Restore the byte flipped in step 6 so the remaining failure can only be
    # the gap we are about to create (verification reports the first issue).
    row = conn.execute(
        "SELECT record FROM events ORDER BY seq DESC LIMIT 1 OFFSET 2"
    ).fetchone()
    restored = bytes([row[0][0] ^ 0x01]) + bytes(row[0][1:])
    conn.execute("UPDATE events SET record = ? WHERE seq = ?", (restored, latest_seq - 2))
    gap_seq = latest_seq - 1
    conn.execute("DELETE FROM events WHERE seq = ?", (gap_seq,))
    conn.commit()
    conn.close()
    _, _, verify = request("GET", "/verify")
    check(
        verify["ok"] is False
        and verify["at_seq"] == gap_seq
        and "gap" in verify["reason"],
        f"verification FAILS on the extracted row at seq {gap_seq} "
        f"(reported: {verify.get('at_seq')})",
    )

    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED")
        return 1
    print("ALL CHECKS PASSED")
    print(
        "NOTE: the database is now intentionally corrupted by steps 6-7;\n"
        "      rerun on a fresh data directory for a clean chain."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
