"""控制面启动地址竞态与恢复策略的回归验证。"""
import errno
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("mesh_wait", ROOT / "deploy/g0/meshcentral/wait-bind.py")
WAIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WAIT)


class MeshCentralRecoveryTests(unittest.TestCase):
    def test_address_not_ready_then_recovers(self):
        probe = MagicMock()
        probe.__enter__.return_value = probe
        probe.bind.side_effect = [OSError(errno.EADDRNOTAVAIL, "地址尚未出现"), None]
        with patch.object(WAIT.socket, "socket", return_value=probe), patch.object(WAIT.time, "sleep") as sleep:
            WAIT.wait_for_address("100.64.0.20", 90)
        self.assertEqual(probe.bind.call_count, 2)
        sleep.assert_called_once()

    def test_missing_address_fails_after_deadline(self):
        probe = MagicMock()
        probe.__enter__.return_value = probe
        probe.bind.side_effect = OSError(errno.EADDRNOTAVAIL, "地址尚未出现")
        with patch.object(WAIT.socket, "socket", return_value=probe):
            with self.assertRaises(TimeoutError):
                WAIT.wait_for_address("100.64.0.20", 0)

    def test_unexpected_socket_error_is_not_hidden(self):
        probe = MagicMock()
        probe.__enter__.return_value = probe
        probe.bind.side_effect = OSError(errno.EACCES, "禁止绑定")
        with patch.object(WAIT.socket, "socket", return_value=probe):
            with self.assertRaises(PermissionError):
                WAIT.wait_for_address("100.64.0.20", 90)

    def test_config_rejects_wildcard_and_public_addresses(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            for address in ["0.0.0.0", "127.0.0.1", "8.8.8.8"]:
                config.write_text(json.dumps({"settings": {"portBind": address}}))
                with self.assertRaises(ValueError):
                    WAIT.read_bind_address(config)
            config.write_text(json.dumps({"settings": {"portBind": "100.64.0.20"}}))
            self.assertEqual(WAIT.read_bind_address(config), "100.64.0.20")

    def test_service_recovers_clean_exit_and_dependency_restart(self):
        unit = (ROOT / "deploy/g0/meshcentral/screen-control-meshcentral-g0.service").read_text()
        self.assertIn("Restart=always", unit)
        self.assertIn("StartLimitIntervalSec=0", unit)
        self.assertIn("PartOf=docker.service tailscaled.service", unit)
        self.assertIn("WantedBy=multi-user.target docker.service tailscaled.service", unit)
        self.assertIn("ExecStartPre=/usr/bin/python3", unit)
        self.assertIn("wait-bind.py", unit)
