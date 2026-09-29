"""隔离验证 Linux 更新提交与回滚，不操作真实服务、网络或代理。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/g0/meshagent/rust-native/linux-canary.py"
spec = importlib.util.spec_from_file_location("linux_canary", SCRIPT)
canary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canary)


class LinuxCanaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.root, self.state = base / "agent", base / "state"
        self.root.mkdir()
        self.state.mkdir()
        (self.root / "meshagent").write_bytes(b"old")
        (self.root / "meshagent.db").write_bytes(b"identity")
        self.old = canary.digest(self.root / "meshagent")
        self.checksum = self.old + "  meshagent\n" + "b" * 64 + "  meshagent.msh\n"
        (self.root / "meshagent.sha256").write_text(self.checksum)
        self.candidate = base / "candidate"
        self.candidate.write_bytes(b"new")
        self.manifest = base / "candidate.json"
        self.manifest.write_text(json.dumps({"status": "built-not-deployed", "binarySha256": canary.digest(self.candidate)}))
        for name, value in (("ROOT", self.root), ("STATE", self.state)):
            p = patch.object(canary, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.runner = patch.object(canary, "run", return_value="active").start()
        self.health = patch.object(canary, "health", return_value={"pid": 42, "restarts": 0}).start()
        self.addCleanup(patch.stopall)

    def arm(self):
        return Path(canary.arm(self.candidate, self.manifest, self.old)["backupDir"])

    def test_retain_then_automatic_and_explicit_restore(self):
        backup = self.arm()
        self.assertIn("b" * 64 + "  meshagent.msh", (self.root / "meshagent.sha256").read_text())
        (self.root / "meshagent.db").write_bytes(b"current-identity")
        canary.retain(backup)
        self.runner.reset_mock()
        self.assertEqual(canary.restore(backup, True)["status"], "already-retained-for-observation")
        self.runner.assert_not_called()
        canary.restore(backup)
        self.assertEqual((self.root / "meshagent").read_bytes(), b"old")
        self.assertEqual((self.root / "meshagent.sha256").read_text(), self.checksum)
        self.assertEqual((self.root / "meshagent.db").read_bytes(), b"current-identity")

    def test_automatic_restore_prevents_late_retain(self):
        backup = self.arm()
        canary.restore(backup, True)
        with self.assertRaises(ValueError):
            canary.retain(backup)

    def test_failed_receipt_keeps_rollback_timer(self):
        backup = self.arm()
        self.runner.reset_mock()
        with patch.object(canary, "write_json", side_effect=OSError("写入失败")):
            with self.assertRaises(OSError):
                canary.retain(backup)
        self.assertEqual(json.loads((backup / "state.json").read_text())["status"], "armed")
        self.assertNotIn(("systemctl", "stop"), [c.args[:2] for c in self.runner.call_args_list])

    def test_failed_timer_cleanup_does_not_reverse_commit(self):
        backup = self.arm()
        def run(*args, **kwargs):
            if args[:2] == ("systemctl", "stop"):
                raise subprocess.CalledProcessError(1, args)
            return "active"
        self.runner.side_effect = run
        self.assertEqual(canary.retain(backup)["status"], "retained-for-observation")
        self.assertEqual(canary.restore(backup, True)["status"], "already-retained-for-observation")

    def test_start_failure_restores_original_binary(self):
        self.health.side_effect = [{"pid": 1, "restarts": 0}, RuntimeError("启动失败"), {"pid": 2, "restarts": 0}]
        with self.assertRaises(RuntimeError):
            self.arm()
        self.assertEqual((self.root / "meshagent").read_bytes(), b"old")

    def test_restarted_agent_or_damaged_backup_cannot_be_retained(self):
        backup = self.arm()
        self.health.return_value = {"pid": 43, "restarts": 1}
        with self.assertRaises(RuntimeError):
            canary.retain(backup)
        (backup / "meshagent").write_bytes(b"broken")
        with self.assertRaises(ValueError):
            canary.retain(backup)

    def test_pending_update_rejected(self):
        self.arm()
        with self.assertRaises(RuntimeError):
            self.arm()

    def test_experimental_manifest_rejected_before_service_change(self):
        value = json.loads(self.manifest.read_text())
        value["lifetimePatchSha256"] = {"experimental": "a" * 64}
        self.manifest.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            self.arm()
        self.runner.assert_not_called()

    def test_failed_timer_creation_leaves_current_binary_untouched(self):
        self.runner.side_effect = subprocess.CalledProcessError(1, ["systemd-run"])
        with self.assertRaises(subprocess.CalledProcessError):
            self.arm()
        self.assertEqual((self.root / "meshagent").read_bytes(), b"old")
        state = next(self.state.glob("rust-canary-*/state.json"))
        self.assertEqual(json.loads(state.read_text())["status"], "schedule-failed")


if __name__ == "__main__":
    unittest.main()
