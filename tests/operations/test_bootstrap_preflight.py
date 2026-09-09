from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT = PROJECT_ROOT / "ops" / "bootstrap" / "preflight"


def load_preflight():
    loader = importlib.machinery.SourceFileLoader("bootstrap_preflight", str(PREFLIGHT))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    fixture_env = {}
    for line in (PROJECT_ROOT / ".env.example").read_text().splitlines():
        if line.startswith("SCREEN_CONTROL_"):
            key, value = line.split("=", 1)
            fixture_env[key] = value.strip("\"' ")
    with mock.patch.dict(os.environ, fixture_env):
        loader.exec_module(module)
    return module


class PreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_preflight()

    def test_executable_matches_reviewed_pin(self):
        self.assertEqual(self.module.script_hash(), self.module.pinned_hash())

    def test_target_and_command_surface_is_closed(self):
        self.assertEqual(set(self.module.NODES), {"nix", "echova", "jiang-chenx"})
        forbidden_patterns = {
            r"(?m)(?:^|[;|&]\s*)(?:rm|mv|cp|scp|install|apt|apt-get|dnf|yum)(?:\s|$)",
            r"systemctl\s+(?:restart|stop|disable|enable)",
            r"\bnetsh\b",
            r"\b(?:set|new|remove)-netfirewall",
            r"\b(?:restart|stop)-service\b",
        }
        labels = [self.module.command_label(probe).lower() for probe in self.module.LINUX_PROBES]
        powershell = [str(probe.command).lower() for probe in self.module.WINDOWS_PROBES]
        surface = "\n".join(labels + powershell)
        for pattern in forbidden_patterns:
            self.assertNotRegex(surface, pattern)

    def test_io01b_command_surface_is_fixed_and_local(self):
        self.assertEqual(len(self.module.TOOLCHAIN_COMMANDS), 6)
        surface = "\n".join(" ".join(command) for command in self.module.TOOLCHAIN_COMMANDS)
        self.assertNotIn("ssh", surface)
        self.assertNotRegex(surface, r"(?m)(?:^|\s)(?:curl|wget|apt|rm|scp)(?:\s|$)")
        self.assertIn("validate_toolchain.py", surface)
        self.assertIn("go test ./...", surface)

    def test_redaction_removes_private_network_and_home_identity(self):
        value = "user=/home/alice/a ip=192.168.1.9 ipv6=fd00::1234 mac=aa:bb:cc:dd:ee:ff password=hunter2"
        redacted = self.module.redact_text(value)
        self.assertNotIn("alice", redacted)
        self.assertNotIn("192.168.1.9", redacted)
        self.assertNotIn("aa:bb:cc:dd:ee:ff", redacted)
        self.assertNotIn("fd00::1234", redacted)
        self.assertNotIn("hunter2", redacted)

    def complete_snapshot(self, node):
        return {
            "schemaVersion": self.module.SCHEMA_VERSION,
            "workPackage": self.module.WORK_PACKAGE,
            "node": node.name,
            "osFamily": node.os_family,
            "clockGate": "pass",
            "clockSamples": [],
            "clockSyncHealthy": True,
            "categories": {},
            "spikeBlockers": [],
            "status": "complete",
            "probeResults": [],
        }

    @staticmethod
    def event(probe_id, summary, category="fixture"):
        return {"probeId": probe_id, "category": category, "status": "passed", "stdoutSummary": summary}

    def semantic_events(self, node):
        peers = [
            {"HostName": item.expected_hostname, "Online": True, "TailscaleIPs": [item.expected_tailscale_ip]}
            for item in self.module.NODES.values()
            if item.name != node.name
        ]
        common = [
            self.event("tailscale_version", {"short": "1.102.2"}),
            self.event("tailscale_status", {"BackendState": "Running", "Self": {"HostName": node.expected_hostname, "Online": True, "TailscaleIPs": [node.expected_tailscale_ip]}, "RegisteredPeers": peers}),
            self.event("tailscale_netcheck", {"UDP": True}),
            self.event("hostname", node.expected_hostname),
            self.event("ssh_service", "active"),
        ]
        if node.os_family == "linux":
            return common + [
                self.event("os_release", {"PRETTY_NAME": "Linux"}), self.event("kernel", "kernel"),
                self.event("architecture", "x86_64"), self.event("boot_id", {"sha256": "0" * 64}),
                self.event("xrandr_display_1", "Screen 0: current 1920 x 1080"), self.event("sessions", "1"),
                self.event("gpu_pci", {"summary": "GPU; Kernel driver in use"}), self.event("browser_firefox", "Firefox 1"),
                self.event("firewall_nft_privileged", {"bytes": 10}), self.event("identity", {"isRoot": False}),
                self.event("capabilities", {"current": "none"}), self.event("disk_bytes", {"rows": ["disk"]}),
                self.event("disk_inodes", {"rows": ["inode"]}), self.event("listening_sockets", {"listeners": []}),
            ]
        return common + [
            self.event("os_build", {"caption": "Windows", "version": "10", "build": "1", "architecture": "64-bit"}),
            self.event("kernel", "kernel"), self.event("display", [{"CurrentHorizontalResolution": 3840, "CurrentVerticalResolution": 2160}]),
            self.event("session", {"hasInteractiveSession": True}), self.event("gpu", [{"Name": "GPU", "DriverVersion": "1"}]),
            self.event("browsers", [{"product": "Edge", "version": "1"}]), self.event("firewall_profiles", [{"Enabled": 1}]),
            self.event("firewall_rules_hash", {"bytes": 10}), self.event("identity", {"isAdmin": True}),
            self.event("disk", [{"DeviceID": "C:"}]), self.event("listening_tcp", {"listeners": []}),
        ]

    def test_sealed_bundle_verifies_and_detects_tamper(self):
        def fake_collect_node(node):
            return self.complete_snapshot(node), []

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with mock.patch.object(self.module, "collect_node", side_effect=fake_collect_node), mock.patch.object(
                self.module, "known_host_evidence", return_value={"file": "fixture", "fileSha256": "0" * 64, "fingerprints": {}}
            ):
                bundle = self.module.collect(["nix", "echova", "jiang-chenx"], root)
            result = self.module.verify_bundle(bundle)
            self.assertTrue(result["valid"])

            manifest = bundle / "manifest.json"
            manifest.chmod(0o600)
            content = json.loads(manifest.read_text(encoding="utf-8"))
            content["operator"] = "tampered"
            manifest.write_text(json.dumps(content), encoding="utf-8")
            result = self.module.verify_bundle(bundle)
            self.assertFalse(result["valid"])
            self.assertIn("hash mismatch manifest.json", result["errors"])

    def test_partial_node_run_cannot_claim_formal_bootstrap_completion(self):
        def fake_collect_node(node):
            return self.complete_snapshot(node), []

        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(self.module, "collect_node", side_effect=fake_collect_node), mock.patch.object(
                self.module, "known_host_evidence", return_value={"file": None, "fileSha256": None, "fingerprints": {}}
            ):
                bundle = self.module.collect(["nix"], Path(temp))
            index = json.loads((bundle / "index.json").read_text(encoding="utf-8"))
            self.assertEqual(index["status"], "diagnostic-partial-node-set")
            self.assertEqual(index["missingNodes"], ["echova", "jiang-chenx"])

    def test_tailscale_version_accepts_actual_lowercase_schema(self):
        raw = json.dumps({"majorMinorPatch": "1.102.2", "short": "1.102.2", "long": "1.102.2-t1", "gitCommit": "abc"}).encode()
        result = self.module.parse_summary("tailscale_version", raw)
        self.assertEqual(result["short"], "1.102.2")
        self.assertEqual(result["gitCommit"], "abc")

    def test_windows_output_decoding_handles_gb18030_and_utf16le(self):
        value = {"caption": "中文 Windows"}
        raw = json.dumps(value, ensure_ascii=False)
        self.assertEqual(self.module.parse_json_bytes(raw.encode("gb18030")), value)
        self.assertEqual(self.module.parse_json_bytes(raw.encode("utf-16le")), value)

    def test_semantic_fixtures_cover_required_categories_on_both_platforms(self):
        for name in ("nix", "jiang-chenx"):
            node = self.module.NODES[name]
            checks, _ = self.module.semantic_fact_checks(node, self.semantic_events(node))
            self.assertTrue(all(check["status"] == "complete" for check in checks.values()), checks)

    def test_clock_gate_uses_best_of_three_and_sync_health(self):
        node = self.module.NODES["jiang-chenx"]
        events = []
        for number, duration in ((1, 900), (2, 200), (3, 500)):
            events.append({
                "probeId": f"clock_utc_{number}", "status": "passed",
                "stdoutSummary": {"utc": "2026-01-01T00:00:00Z"},
                "sampleReceivedUtc": "2026-01-01T00:00:00.100000Z",
                "finishedUtc": "2026-01-01T00:00:00.100000Z", "monotonicDurationMs": duration,
            })
        events.extend([self.event("clock_sync", {"serviceStatus": "Running"}), self.event("clock_sync_detail", "Leap 0 Source NTP")])
        selected, samples, healthy, issues = self.module.evaluate_clock(node, events)
        self.assertEqual(selected["probeId"], "clock_utc_2")
        self.assertEqual(len(samples), 3)
        self.assertTrue(healthy)
        self.assertEqual(issues, [])

    def test_empty_browser_result_fails_semantic_gate(self):
        event = {"probeId": "browsers", "status": "passed", "stdoutSummary": []}
        checks, _ = self.module.semantic_fact_checks(self.module.NODES["jiang-chenx"], [event])
        self.assertEqual(checks["browser"]["status"], "unknown")

    def test_remote_command_enforces_strict_known_hosts(self):
        probe = self.module.LINUX_PROBES[0]
        command = self.module.build_command(self.module.NODES["echova"], probe)
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertTrue(any(part.startswith("UserKnownHostsFile=") for part in command))

    def test_bounded_capture_hashes_full_output(self):
        payload = b"x" * 64
        with mock.patch.object(self.module, "MAX_PROBE_OUTPUT_BYTES", 32):
            result = self.module.run_bounded([sys.executable, "-c", "import sys;sys.stdout.buffer.write(b'x'*64)"], 5, False)
        self.assertTrue(result["stdoutTruncated"])
        self.assertEqual(result["stdoutBytes"], 64)
        self.assertEqual(result["stdoutSha256"], hashlib.sha256(payload).hexdigest())

    def test_sensitive_scan_blocks_unredacted_credentials(self):
        result = self.module.sensitive_scan({"fixture": b"password=hunter2"})
        self.assertEqual(result["status"], "quarantined")
        self.assertEqual(result["matches"][0]["patternId"], "credential-value")

    def test_legacy_bundle_integrity_is_separate_from_current_trust(self):
        def fake_collect_node(node):
            return self.complete_snapshot(node), []

        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(self.module, "collect_node", side_effect=fake_collect_node), mock.patch.object(
                self.module, "known_host_evidence", return_value={"file": None, "fileSha256": None, "fingerprints": {}}
            ):
                bundle = self.module.collect(["nix"], Path(temp))
            bundle.chmod(0o700)
            for name in ("recorder", "preflight.sha256", "bundle.schema.json"):
                (bundle / name).chmod(0o600)
                (bundle / name).unlink()
            manifest_path = bundle / "manifest.json"
            index_path = bundle / "index.json"
            for path in (manifest_path, index_path):
                path.chmod(0o600)
                value = json.loads(path.read_text(encoding="utf-8"))
                value["recorderSha256"] = "0" * 64
                path.write_bytes(self.module.canonical_json(value))
            seal_path = bundle / "seal.json"
            seal_path.chmod(0o600)
            files = {path.name: self.module.sha256_file(path) for path in bundle.iterdir() if path.name != "seal.json"}
            seal = json.loads(seal_path.read_text(encoding="utf-8"))
            seal["files"] = files
            seal["bundleSha256"] = self.module.sha256_bytes(self.module.canonical_json(files))
            seal_path.write_bytes(self.module.canonical_json(seal))
            result = self.module.verify_bundle(bundle)
            self.assertTrue(result["integrityValid"])
            self.assertFalse(result["provenanceComplete"])
            self.assertFalse(result["currentRecorderMatch"])

    def test_bundle_verifier_rejects_traversal_name_without_reading_it(self):
        def fake_collect_node(node):
            return self.complete_snapshot(node), []

        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(self.module, "collect_node", side_effect=fake_collect_node), mock.patch.object(
                self.module, "known_host_evidence", return_value={"file": None, "fileSha256": None, "fingerprints": {}}
            ):
                bundle = self.module.collect(["nix"], Path(temp))
            bundle.chmod(0o700)
            seal_path = bundle / "seal.json"
            seal_path.chmod(0o600)
            seal = json.loads(seal_path.read_text(encoding="utf-8"))
            seal["files"]["../outside"] = "0" * 64
            seal["bundleSha256"] = self.module.sha256_bytes(self.module.canonical_json(seal["files"]))
            seal_path.write_bytes(self.module.canonical_json(seal))
            result = self.module.verify_bundle(bundle)
            self.assertFalse(result["integrityValid"])
            self.assertTrue(any("unsafe sealed filename" in error for error in result["errors"]))

    def test_toolchain_bundle_verifies_and_detects_tamper(self):
        fake_result = {
            "exitCode": 0,
            "timedOut": False,
            "stdout": b"ok\n",
            "stderr": b"",
            "stdoutSha256": hashlib.sha256(b"ok\n").hexdigest(),
            "stderrSha256": hashlib.sha256(b"").hexdigest(),
            "stdoutBytes": 3,
            "stderrBytes": 0,
            "stdoutTruncated": False,
            "stderrTruncated": False,
            "sampleReceivedUtc": None,
        }
        with tempfile.TemporaryDirectory() as temp, mock.patch.object(self.module, "run_bounded", return_value=fake_result):
            bundle = self.module.record_toolchain(Path(temp))
            self.assertTrue(self.module.verify_toolchain_bundle(bundle)["valid"])
            bundle.chmod(0o700)
            lock = bundle / "toolchain.lock.json"
            lock.chmod(0o600)
            lock.write_bytes(lock.read_bytes() + b"\n")
            result = self.module.verify_toolchain_bundle(bundle)
            self.assertFalse(result["integrityValid"])
            self.assertIn("hash mismatch toolchain.lock.json", result["errors"])


if __name__ == "__main__":
    unittest.main()
