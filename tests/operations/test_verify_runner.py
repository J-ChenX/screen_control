from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
RUNNER = ROOT / "ops" / "verify" / "run"


def load_runner():
    loader = importlib.machinery.SourceFileLoader("verify_runner", str(RUNNER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


class VerifyRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_runner()

    def test_all_scenarios_obey_closed_schema(self):
        scenarios = list((ROOT / "ops/verify/scenarios").glob("*.yaml"))
        self.assertGreaterEqual(len(scenarios), 12)
        for path in scenarios:
            value = self.module.load_scenario(path.stem)
            self.assertEqual(set(value), self.module.REQUIRED_SCENARIO)

    def test_bounded_command_capture_fails_closed(self):
        with mock.patch.object(self.module, "MAX_OUTPUT", 32):
            result = self.module.run_command([sys.executable, "-c", "import sys;sys.stdout.buffer.write(b'x'*64)"], 5)
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["truncated"])
        self.assertEqual(result["stdoutBytes"], 64)
        self.assertEqual(result["stdoutSha256"], hashlib.sha256(b"x" * 64).hexdigest())

    def test_signed_evidence_requires_trusted_key_and_detects_tamper(self):
        evidence_parent = ROOT / "evidence"
        evidence_parent.mkdir(mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=evidence_parent) as temp_name:
            temp = Path(temp_name)
            key_root = temp / "keys"
            formal_root = temp / "formal"
            policy_path = temp / "policy.json"
            with mock.patch.object(self.module, "KEY_ROOT", key_root), mock.patch.object(
                self.module, "FORMAL_ROOT", formal_root
            ), mock.patch.object(self.module, "EVIDENCE_POLICY_PATH", policy_path):
                signer = self.module.init_signer()
                trusted_public = temp / "trusted.pem"
                trusted_public.write_bytes((key_root / "evidence-ed25519.pub.pem").read_bytes())
                policy_path.write_text(json.dumps({
                    "schemaVersion": "screen-control.evidence-policy/v1",
                    "trustedKeys": [{
                        "keyId": signer["keyId"], "algorithm": "Ed25519",
                        "publicKey": str(trusted_public.relative_to(ROOT)),
                        "publicKeySha256": signer["publicKeySha256"], "status": "active",
                    }],
                }), encoding="utf-8")
                scenario = {
                    "prerequisites": [], "commands": [[sys.executable, "-c", "print('ok')"]],
                    "cleanup": [], "timeoutSeconds": 5, "thresholds": {"exitCode": 0},
                    "sensitivity": "R0", "writablePaths": [], "artifacts": [],
                }
                bundle = self.module.create_evidence(
                    "TEST-SIGN", "work-package", scenario, "0" * 64,
                    ROOT / "deploy/releases/current/toolchain.lock.json", "unit-test",
                )
                self.assertTrue(self.module.verify_evidence(bundle)["valid"])
                bundle.chmod(0o700)
                index = bundle / "index.json"
                index.chmod(0o600)
                index.write_bytes(index.read_bytes() + b"\n")
                result = self.module.verify_evidence(bundle)
                self.assertFalse(result["valid"])
                self.assertIn("hash mismatch index.json", result["errors"])


if __name__ == "__main__":
    unittest.main()

