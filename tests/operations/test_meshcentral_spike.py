from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
VERIFY = ROOT / "deploy" / "spike" / "meshcentral" / "verify.py"


def load_verifier():
    spec = importlib.util.spec_from_file_location("meshcentral_spike_verify", VERIFY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MeshCentralSpikeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_verifier()

    def test_checked_in_spike_is_fail_closed(self):
        result = subprocess.run([sys.executable, str(VERIFY)], cwd=ROOT, check=False, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertEqual(json.loads(result.stdout)["status"], "passed")

    def test_secret_scanner_rejects_credential_values(self):
        self.assertEqual(self.module.secret_paths({"password": "do-not-store-this"}), ["$.password"])
        self.assertEqual(self.module.secret_paths({"allowLoginToken": False}), [])

    def test_provisioner_never_places_plaintext_in_native_argv_or_environment(self):
        source = (VERIFY.parent / "provision.js").read_text(encoding="utf-8")
        self.assertIn("fs.readFileSync(0)", source)
        self.assertIn('"--hashpass"', source)
        self.assertNotIn('"--pass"', source)
        self.assertNotIn("process.env", source)


if __name__ == "__main__":
    unittest.main()
