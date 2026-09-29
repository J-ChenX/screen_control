import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("validate_toolchain", ROOT / "ops/bootstrap/validate_toolchain.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class ToolchainLockTests(unittest.TestCase):
    def setUp(self):
        self.lock_path = ROOT / "deploy/releases/current/toolchain.lock.json"

    def write_variant(self, value):
        temp = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False)
        with temp:
            json.dump(value, temp)
        self.addCleanup(Path(temp.name).unlink)
        return Path(temp.name)

    def test_current_lock_is_valid(self):
        self.assertEqual([], MODULE.validate(self.lock_path))

    def test_floating_version_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["build"]["go"]["productionVersion"] = "latest"
        path = self.write_variant(lock)
        self.assertTrue(any("floating/default" in item for item in MODULE.validate(path)))

    def test_empty_required_value_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["runtime"]["tailscale"]["targetVersion"] = ""
        path = self.write_variant(lock)
        self.assertTrue(any("empty string" in item for item in MODULE.validate(path)))

    def test_artifact_hash_drift_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["artifacts"]["files"][0]["sha256"] = "0" * 64
        path = self.write_variant(lock)
        self.assertTrue(any("artifact hash mismatch" in item for item in MODULE.validate(path)))

    def test_target_inventory_is_closed(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["targets"].append(copy.deepcopy(lock["targets"][0]) | {"node": "fourth-node"})
        path = self.write_variant(lock)
        self.assertTrue(any("targets must be exactly" in item for item in MODULE.validate(path)))

    def test_bootstrap_recorder_drift_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["bootstrap"]["recorderSha256"] = "0" * 64
        path = self.write_variant(lock)
        self.assertTrue(any("recorder hash" in item for item in MODULE.validate(path)))

    def test_environment_import_mismatch_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["bootstrap"]["environmentSnapshotHash"] = "0" * 64
        path = self.write_variant(lock)
        self.assertTrue(any("environment hash" in item for item in MODULE.validate(path)))

    def test_target_tailscale_version_drift_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["targets"][0]["tailscale"] = "1.102.2"
        path = self.write_variant(lock)
        self.assertTrue(any("Tailscale version" in item for item in MODULE.validate(path)))

    def test_rust_version_drift_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["build"]["rust"]["version"] = "1.97.0"
        self.assertTrue(any("Rust version" in item for item in MODULE.validate(self.write_variant(lock))))

    def test_rust_dependency_drift_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["build"]["rust"]["moduleLockSha256"] = "0" * 64
        self.assertTrue(any("Rust module lock" in item for item in MODULE.validate(self.write_variant(lock))))

    def test_rust_artifact_omission_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["artifacts"]["files"] = [item for item in lock["artifacts"]["files"] if item["path"] != "rust-toolchain.toml"]
        self.assertTrue(any("Rust toolchain artifacts" in item for item in MODULE.validate(self.write_variant(lock))))

    def test_rust_minimum_version_drift_is_rejected(self):
        lock = json.loads(self.lock_path.read_text(encoding="utf-8"))
        lock["build"]["rust"]["minimumVersion"] = "1.96"
        self.assertTrue(any("Rust minimum version" in item for item in MODULE.validate(self.write_variant(lock))))


if __name__ == "__main__":
    unittest.main()
