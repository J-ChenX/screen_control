"""在隔离目录模拟节点身份，不操作真实服务或 Tailscale 配置。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy/g0/suite/configure-tailscale.sh"


class TailscaleSuiteTests(unittest.TestCase):
    def run_configuration(self, local_device, identified_device, register_lerrem=True):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            commands = root / "bin"
            commands.mkdir()
            nodes = [
                {"ID": f"node-{device}", "DNSName": f"{device}.example.ts.net.",
                 "TailscaleIPs": [f"100.64.0.{index}"]}
                for index, device in enumerate(("echova", "nix", "jiang-chenx", "xiaomi-15", "lerrem"), 10)
            ]
            local = next(node for node in nodes if node["ID"] == f"node-{local_device}")
            status = {"Self": local, "Peer": {node["ID"]: node for node in nodes if node != local}}
            status_file = root / "status.json"
            status_file.write_text(json.dumps(status))
            mocks = {
                "tailscale": '''#!/bin/sh
case "$1 $2" in
  'debug prefs') printf '{"OperatorUser":"suite-test"}' ;;
  'status --json') cat "$TEST_STATUS" ;;
  'serve get-config') printf '{}' ;;
  'serve --yes') exit 0 ;;
  *) exit 90 ;;
esac
''',
                "curl": '''#!/bin/sh
case "$*" in
  */api/v1/identity/device*) printf '{"data":{"deviceId":"%s"}}' "$TEST_IDENTITY" ;;
  */api/v1/health*) printf '{"data":{"status":"ok"}}' ;;
  *5033*) printf '401' ;;
  *) exit 91 ;;
esac
''',
                "systemctl": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_SERVICE_CALLS"\n',
            }
            for name, source in mocks.items():
                path = commands / name
                path.write_text(source)
                path.chmod(0o700)
            env = {key: value for key, value in os.environ.items() if not key.startswith("SCREEN_CONTROL_")}
            env.update({
                "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                "HOME": str(root), "XDG_CONFIG_HOME": str(root / "config"),
                "XDG_STATE_HOME": str(root / "state"), "USER": "suite-test",
                "TEST_STATUS": str(status_file), "TEST_IDENTITY": identified_device,
                "TEST_SERVICE_CALLS": str(root / "service-calls"),
                "SCREEN_CONTROL_ECHOVA_DNS_NAME": "echova",
                "SCREEN_CONTROL_NIX_DNS_NAME": "nix",
                "SCREEN_CONTROL_WINDOWS_DNS_NAME": "jiang-chenx",
                "SCREEN_CONTROL_PHONE_HOSTNAME": "xiaomi-15",
                "SCREEN_CONTROL_PHONE_IP": "100.64.0.13",
            })
            if register_lerrem:
                env["SCREEN_CONTROL_LERREM_DNS_NAME"] = "lerrem"
            result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=10)
            identity_file = root / "config/screen-control/tailscale.env"
            content = identity_file.read_text() if identity_file.exists() else None
            restarted = (root / "service-calls").exists()
            return result, content, restarted

    def test_host_identity_follows_local_stable_node(self):
        for device in ("lerrem", "echova"):
            with self.subTest(device=device):
                result, content, restarted = self.run_configuration(device, device)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("lerrem=node-lerrem", content)
                self.assertIn("echova=node-echova", content)
                self.assertTrue(restarted)

    def test_old_server_identity_is_rejected_on_lerrem(self):
        result, _, _ = self.run_configuration("lerrem", "echova")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("期望 lerrem，实际 echova", result.stderr)

    def test_missing_local_registration_fails_before_write_or_restart(self):
        result, content, restarted = self.run_configuration("lerrem", "lerrem", register_lerrem=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SCREEN_CONTROL_LERREM_DNS_NAME", result.stderr)
        self.assertIsNone(content)
        self.assertFalse(restarted)
