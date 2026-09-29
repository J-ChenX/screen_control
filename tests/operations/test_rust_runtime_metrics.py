"""防止把服务重启、工件切换或漏采主进程误报为 Rust 内存回收。"""
import copy
from pathlib import Path
import runpy
import unittest

VALIDATE = runpy.run_path(str(Path(__file__).resolve().parents[1] / "performance/windows-agent-memory.py"))["validate_samples"]


class RuntimeMemoryEvidenceTests(unittest.TestCase):
    def setUp(self):
        row = {"service": "Running", "servicePid": 10, "binarySha256": "a" * 64,
               "processes": [{"pid": 10}, {"pid": 11}]}
        self.rows = [row, copy.deepcopy(row)]

    def test_normal_child_exit_is_accepted(self):
        self.rows[1]["processes"].pop()
        VALIDATE(self.rows, 2, "A" * 64)

    def test_restart_and_binary_change_are_rejected(self):
        for change in ({"servicePid": 11}, {"binarySha256": "b" * 64}):
            with self.subTest(change=change):
                rows = copy.deepcopy(self.rows)
                rows[1].update(change)
                with self.assertRaises(ValueError):
                    VALIDATE(rows, 2)

    def test_missing_main_process_is_rejected(self):
        self.rows[1]["processes"] = [{"pid": 11}]
        with self.assertRaises(ValueError):
            VALIDATE(self.rows, 2)

    def test_wrong_artifact_and_incomplete_sequence_are_rejected(self):
        for rows, count, expected in [(self.rows, 2, "b" * 64), (self.rows, 3, None), ([], 1, None)]:
            with self.subTest(count=count, expected=expected):
                with self.assertRaises(ValueError):
                    VALIDATE(rows, count, expected)


if __name__ == "__main__":
    unittest.main()
