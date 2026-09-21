"""审计服务核心测试。

运行：python -m unittest discover -s tests -v
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from app.core import GENESIS_HASH, ValidationError, canonical_json
from app.store import Store, StoreError


class StoreTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db_path = str(Path(self.tmp.name) / "audit.db")
        self.store = Store(self.db_path)
        self.addCleanup(self.store.close)

    def append(self, object_id: str, action: str, fields=None, timestamp=None):
        return self.store.append_event(object_id, action, timestamp, fields or {})

    def seed(self) -> None:
        """造一批有代表性的事件：创建、覆盖、删除、重建。"""
        self.append("user-1", "create", {"name": "Alice", "role": "admin"}, "2026-01-01T10:00:00Z")
        self.append("user-1", "update", {"role": "auditor"}, "2026-01-02T10:00:00+08:00")
        self.append("user-2", "create", {"name": "Bob"}, 1767225600)
        self.append("user-2", "delete", {"deleted": True}, "2026-01-04T10:00:00Z")
        self.append("user-2", "create", {"name": "Bob2", "v": 1}, "2026-01-05T10:00:00Z")


class TestAppendAndChain(StoreTestBase):
    def test_seqs_are_contiguous_no_gaps(self) -> None:
        for expected in range(1, 11):
            event = self.append("o", "ping", {"i": expected})
            self.assertEqual(event["seq"], expected)
            self.assertEqual(len(event["hash"]), 64)
        seqs = [e["seq"] for e in self.store.list_events()]
        self.assertEqual(seqs, list(range(1, 11)))

    def test_first_event_anchored_to_genesis(self) -> None:
        event = self.append("o", "create", {"x": 1})
        self.assertEqual(event["prev_hash"], GENESIS_HASH)
        self.assertEqual(self.store.head()["last_hash"], event["hash"])

    def test_invalid_event_is_rejected_without_consuming_seq(self) -> None:
        self.append("o", "create", {"x": 1})
        with self.assertRaises(ValidationError):
            self.append("", "create", {"x": 1})
        with self.assertRaises(ValidationError):
            self.append("o", "create", {"x": float("nan")})
        with self.assertRaises(ValidationError):
            self.append("o", "create", {"x": 1}, "not-a-time")
        good = self.append("o", "create", {"x": 2})
        self.assertEqual(good["seq"], 2, "失败的写入不得占用序号")

    def test_concurrent_appends_stay_contiguous(self) -> None:
        errors: list[Exception] = []

        def worker(start: int) -> None:
            try:
                for i in range(start, start + 25):
                    self.append("o", "ping", {"i": i})
            except Exception as exc:  # pragma: no cover
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(i * 25 + 1,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertFalse(errors)
        seqs = [e["seq"] for e in self.store.list_events()]
        self.assertEqual(sorted(seqs), list(range(1, 101)))


class TestVerify(StoreTestBase):
    def test_clean_chain_verifies_ok(self) -> None:
        self.seed()
        result = self.store.verify_chain()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["count"], 5)

        mid = self.store.verify_chain(3)
        self.assertTrue(mid["ok"])
        self.assertEqual(mid["checked_from"], 3)

    def test_modified_row_is_detected(self) -> None:
        self.seed()
        self._raw_sql(
            "UPDATE events SET object_id = 'user-9' WHERE seq = 3"
        )
        result = self.store.verify_chain()
        self.assertFalse(result["ok"])
        self.assertEqual(result["first_mismatch"], 3)
        self.assertEqual(result["reason"], "hash_mismatch")

    def test_middle_row_removed_is_detected(self) -> None:
        self.seed()
        self._raw_sql("DELETE FROM events WHERE seq = 2")
        result = self.store.verify_chain()
        self.assertFalse(result["ok"])
        self.assertEqual(result["first_mismatch"], 2)
        self.assertEqual(result["reason"], "seq_gap")

    def test_rechained_forgery_is_detected_by_head_pointer(self) -> None:
        """攻击者抽掉一条后把后面的事件全部重编号、重算哈希，
        链内自洽——只有 meta 头指针（链外锚点）能抓住它。"""
        self.seed()
        from app.core import compute_event_hash

        self._raw_sql("DELETE FROM events WHERE seq = 2")
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT * FROM events WHERE seq >= 3 ORDER BY seq"
            ).fetchall()
            cols = rows[0].keys()
            prev = conn.execute("SELECT hash FROM events WHERE seq = 1").fetchone()[0]
            for new_seq, row in zip(range(2, 2 + len(rows)), rows):
                data = dict(zip(cols, row))
                fields = json.loads(data["fields"])
                new_hash = compute_event_hash(
                    new_seq, prev, data["object_id"], data["action"],
                    data["timestamp"], fields,
                )
                conn.execute(
                    "UPDATE events SET seq = ?, prev_hash = ?, hash = ? WHERE seq = ?",
                    (new_seq, prev, new_hash, data["seq"]),
                )
                prev = new_hash
            conn.commit()
        finally:
            conn.close()
        result = self.store.verify_chain()
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "head_pointer_mismatch")

    def test_tail_truncation_is_detected(self) -> None:
        self.seed()
        self._raw_sql("DELETE FROM events WHERE seq >= 4")
        result = self.store.verify_chain()
        self.assertFalse(result["ok"])
        self.assertEqual(result["first_mismatch"], 4)

    def test_single_byte_flip_in_db_file_is_detected(self) -> None:
        """模拟审计员的做法：服务停掉，直接在数据库文件里改一个字节。"""
        self.seed()
        self.store.close()

        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
        conn.close()

        data = Path(self.db_path).read_bytes()
        marker = b"2026-01-04T10:00:00.000000Z"
        position = data.index(marker)
        corrupted = bytearray(data)
        corrupted[position] = ord("9") if chr(corrupted[position]) != "9" else ord("8")
        Path(self.db_path).write_bytes(corrupted)

        reopened = Store(self.db_path)
        self.addCleanup(reopened.close)
        result = reopened.verify_chain()
        self.assertFalse(result["ok"], "物理文件改了一个字节，校验必须失败")

    def _raw_sql(self, statement: str) -> None:
        conn = sqlite3.connect(self.db_path)
        try:
            conn.execute(statement)
            conn.commit()
        finally:
            conn.close()


class TestReplayDeterminism(StoreTestBase):
    def test_replay_rules(self) -> None:
        self.seed()
        text, mode, base = self.store.state_at(5, use_snapshot=False)
        state = json.loads(text)["state"]
        self.assertEqual(
            state,
            {
                "user-1": {"name": "Alice", "role": "auditor"},
                "user-2": {"name": "Bob2", "v": 1},
            },
        )

    def test_deleted_first_appearance_leaves_tombstone(self) -> None:
        self.append("ghost", "delete", {"deleted": True})
        text, _, _ = self.store.state_at(1, use_snapshot=False)
        self.assertEqual(json.loads(text)["state"], {"ghost": {"deleted": True}})

    def test_deleted_false_clears_tombstone_then_fields_apply(self) -> None:
        self.append("o", "delete", {"deleted": True})
        self.append("o", "restore", {"deleted": False, "name": "x"})
        text, _, _ = self.store.state_at(2, use_snapshot=False)
        self.assertEqual(json.loads(text)["state"], {"o": {"name": "x"}})

    def test_replay_is_byte_identical_across_reopen(self) -> None:
        self.seed()
        text1, _, _ = self.store.state_at(5, use_snapshot=False)
        self.store.close()
        reopened = Store(self.db_path)
        self.addCleanup(reopened.close)
        text2, _, _ = reopened.state_at(5, use_snapshot=False)
        self.assertEqual(text1, text2)

    def test_timestamp_normalization_timezone_independent(self) -> None:
        event = self.append("o", "create", {}, "2026-01-02T10:00:00+08:00")
        self.assertEqual(event["timestamp"], "2026-01-02T02:00:00.000000Z")
        naive = self.append("p", "create", {}, "2026-01-02T02:00:00")
        self.assertEqual(naive["timestamp"], "2026-01-02T02:00:00.000000Z")

    def test_float_roundtrip_is_stable(self) -> None:
        tricky = 0.1 + 0.2
        self.append("o", "create", {"x": tricky, "i": 3, "nested": {"z": 1, "a": 2}})
        text, _, _ = self.store.state_at(1, use_snapshot=False)
        self.assertIn(canonical_json(tricky), text)
        self.assertLess(text.index('"nested"'), text.index('"x"'))


class TestSnapshots(StoreTestBase):
    def test_snapshot_plus_incremental_matches_full_byte_for_byte(self) -> None:
        for i in range(1, 21):
            self.append(f"obj-{i % 5}", "upsert", {"n": i}, f"2026-02-01T00:00:{i:02d}Z")
        self.store.create_snapshot(7)
        self.store.create_snapshot(13)

        for seq in (7, 13, 15, 20):
            full_text, _, _ = self.store.state_at(seq, use_snapshot=False)
            fast_text, mode, base = self.store.state_at(seq, use_snapshot=True)
            self.assertEqual(mode, "snapshot+incremental")
            self.assertEqual(full_text, fast_text, f"seq={seq} 快照路径与全量结果不一致")

    def test_state_before_snapshot_exists_uses_full(self) -> None:
        self.seed()
        self.store.create_snapshot(4)
        _, mode, base = self.store.state_at(3, use_snapshot=True)
        self.assertEqual(mode, "full")
        self.assertIsNone(base)

    def test_snapshot_tampering_makes_paths_diverge(self) -> None:
        self.seed()
        self.store.create_snapshot(3)
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute("SELECT state_json FROM snapshots WHERE seq = 3").fetchone()
            tampered = row[0].replace("Alice", "Mallory")
            conn.execute("UPDATE snapshots SET state_json = ? WHERE seq = 3", (tampered,))
            conn.commit()
        finally:
            conn.close()
        full_text, _, _ = self.store.state_at(5, use_snapshot=False)
        fast_text, _, _ = self.store.state_at(5, use_snapshot=True)
        self.assertNotEqual(full_text, fast_text)


class TestEdgeCases(StoreTestBase):
    def test_state_at_empty_store(self) -> None:
        text, mode, _ = self.store.state_at(0, use_snapshot=False)
        self.assertEqual(json.loads(text), {"state": {}, "meta": {"from_seq": 1, "to_seq": 0}})

    def test_verify_empty_store_is_ok(self) -> None:
        self.assertTrue(self.store.verify_chain()["ok"])

    def test_invalid_seq_ranges(self) -> None:
        self.seed()
        with self.assertRaises(StoreError):
            self.store.verify_chain(0)
        with self.assertRaises(StoreError):
            self.store.verify_chain(99)
        with self.assertRaises(StoreError):
            self.store.state_at(-1)


if __name__ == "__main__":
    unittest.main()
