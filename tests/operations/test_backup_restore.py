import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("backup_restore", ROOT / "ops/backup/backup_restore.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class BackupRestoreTests(unittest.TestCase):
    def test_safe_archive_names(self):
        self.assertEqual(str(MODULE.safe_name("payload/config/app.json")), "payload/config/app.json")
        for unsafe in ("/etc/passwd", "payload/../escape", "other/file", ""):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                MODULE.safe_name(unsafe)

    def test_key_is_exclusive_and_private(self):
        with tempfile.TemporaryDirectory(dir="/dev/shm") as temporary:
            key = Path(temporary) / "backup.key"
            result = MODULE.init_key(key)
            self.assertTrue(result["created"])
            self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o400)
            with self.assertRaises(FileExistsError):
                MODULE.init_key(key)

    def test_key_rejects_open_permissions(self):
        with tempfile.TemporaryDirectory(dir="/dev/shm") as temporary:
            key = Path(temporary) / "backup.key"
            key.write_bytes(os.urandom(48))
            os.chmod(key, 0o644)
            with self.assertRaises(ValueError):
                MODULE.validate_key(key)

    def test_encrypted_online_backup_and_isolated_restore(self):
        with tempfile.TemporaryDirectory(dir="/dev/shm") as temporary:
            key = Path(temporary) / "backup.key"
            MODULE.init_key(key)
            result = MODULE.exercise(key)
        self.assertEqual(result["status"], "passed")
        self.assertTrue(result["sourceUnchanged"])
        self.assertTrue(result["isolatedRestore"])
        self.assertTrue(result["temporaryPlaintextRemoved"])
        self.assertEqual(result["recovery"]["oldAuthorityObjectsRemaining"], 0)
        self.assertEqual(set(result["sqliteIntegrityChecks"].values()), {"ok"})


if __name__ == "__main__":
    unittest.main()
