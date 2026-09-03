import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("network_guard", ROOT / "ops/network-guard/guard.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class NetworkGuardTests(unittest.TestCase):
    def test_target_inventory_is_closed(self):
        self.assertEqual(set(MODULE.NODES), {"nix", "echova", "jiang-chenx"})

    def test_ssh_is_strict_and_pinned(self):
        command = MODULE.ssh_command("host", "hostname")
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertTrue(any(item.startswith("UserKnownHostsFile=") for item in command))

    def test_powershell_quote_doubles_single_quotes(self):
        self.assertEqual(MODULE.ps_quote("a'b"), "'a''b'")

    def test_no_business_port_or_ssh_rule_is_in_command_surface(self):
        source = Path(MODULE.__file__).read_text(encoding="utf-8")
        self.assertNotIn("--dport", source)
        self.assertNotIn("5033", source)
        self.assertNotIn("8080", source)
        self.assertIn("ICMPv4", source)
        self.assertIn("echo-request", source)


if __name__ == "__main__":
    unittest.main()

