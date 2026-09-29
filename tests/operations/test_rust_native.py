"""Rust 候选构建拒绝无效输入与保护既有目录的回归。"""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BUILD = ROOT / "deploy/g0/meshagent/rust-native/build.py"


class RustNativeBuildTests(unittest.TestCase):
    def test_bad_archive_is_rejected_before_extraction_or_build(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            archive = base / "bad.tar.gz"
            archive.write_bytes(b"invalid archive")
            work = base / "work"
            result = subprocess.run(["python3", str(BUILD), "--archive", str(archive), "--work-dir", str(work)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("固定源码摘要不符", result.stderr)
            self.assertEqual(["source.tar.gz"], sorted(p.name for p in work.iterdir()))

    def test_existing_directory_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            marker = work / "marker"
            marker.write_bytes(b"preserve")
            result = subprocess.run(["python3", str(BUILD), "--archive", str(work / "missing"), "--work-dir", str(work)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(marker.read_bytes(), b"preserve")
            self.assertEqual(["marker"], sorted(p.name for p in work.iterdir()))


if __name__ == "__main__":
    unittest.main()
