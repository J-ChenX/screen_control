import importlib.machinery
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


ENV_LOADER = load("environment_runner", ROOT / "ops/with-env")
RENDER = load("mesh_config_renderer", ROOT / "deploy/spike/meshcentral/render_config.py")
EXAMPLE = ENV_LOADER.read_env(ROOT / ".env.example")
CLEAN_ENV = {key: value for key, value in os.environ.items() if not key.startswith("SCREEN_CONTROL_")}
PWSH = os.environ.get("SCREEN_CONTROL_TEST_PWSH") or shutil.which("pwsh")


class EnvironmentMigrationTests(unittest.TestCase):
    def test_runner_preserves_literals_and_exported_precedence(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "private.env"
            literal = "$(touch SHOULD_NOT_EXIST) `whoami` $HOME"
            path.write_text("SCREEN_CONTROL_LITERAL='" + literal + "'\nSCREEN_CONTROL_OVERRIDE='file'\n")
            env = {**CLEAN_ENV, "SCREEN_CONTROL_ENV_FILE": str(path), "SCREEN_CONTROL_OVERRIDE": "exported"}
            script = "import os,json; print(json.dumps([os.environ['SCREEN_CONTROL_LITERAL'],os.environ['SCREEN_CONTROL_OVERRIDE']]))"
            result = subprocess.run([sys.executable, str(ROOT / "ops/with-env"), sys.executable, "-c", script],
                                    env=env, cwd=temp, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), [literal, "exported"])
            self.assertFalse((Path(temp) / "SHOULD_NOT_EXIST").exists())

    def test_missing_explicit_env_and_invalid_keys_do_not_run_command(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "missing.env"
            for content in [None, "PATH=/tmp\n", "SCREEN_CONTROL_X='unclosed\n"]:
                if content is not None:
                    path.write_text(content)
                result = subprocess.run([sys.executable, str(ROOT / "ops/with-env"), sys.executable, "-c", "print('executed')"],
                                        env={**CLEAN_ENV, "SCREEN_CONTROL_ENV_FILE": str(path)}, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("executed", result.stdout)

    def test_renderer_preserves_isolation_and_uses_environment(self):
        env = {**EXAMPLE, "SCREEN_CONTROL_MESH_HOST": "other.example",
               "SCREEN_CONTROL_MESH_PORTAL_ORIGIN": "https://another.example"}
        config = RENDER.render(env)
        self.assertEqual(config["settings"]["cert"], "other.example")
        self.assertEqual(config["domains"][""]["allowedFramingOrigins"], ["https://another.example"])
        self.assertEqual(config["settings"]["userAllowedIP"], config["settings"]["agentAllowedIP"])
        self.assertFalse(config["settings"]["allowLoginToken"])
        self.assertFalse(config["domains"][""]["newAccounts"])

    def test_renderer_rejects_missing_config_and_broad_allowlists(self):
        for overrides in [
            {"SCREEN_CONTROL_MESH_BIND_IP": ""},
            {"SCREEN_CONTROL_REGISTERED_IPS": "0.0.0.0/0,100.64.0.20,100.64.0.30"},
            {"SCREEN_CONTROL_REGISTERED_IPS": "100.64.0.20,100.64.0.20,100.64.0.30"},
            {"SCREEN_CONTROL_MESH_PORTAL_ORIGIN": "https://user:pass@portal.example"},
            {"SCREEN_CONTROL_MESH_PORTAL_ORIGIN": "https://portal.example/path"},
            {"SCREEN_CONTROL_MESH_HOST": "host\nextra"},
        ]:
            with self.subTest(keys=list(overrides)), self.assertRaises(ValueError):
                RENDER.render({**EXAMPLE, **overrides})

    @unittest.skipUnless(os.name == "posix", "Linux shell validator")
    def test_linux_guard_validates_before_any_firewall_access(self):
        script = ROOT / "deploy/g0/meshagent/linux/meshagent-firewall"
        for overrides, success in [({}, True), ({"SCREEN_CONTROL_MESH_HOST": ""}, False),
            ({"SCREEN_CONTROL_REGISTERED_IPS": "0.0.0.0/0,100.64.0.20,100.64.0.30"}, False),
            ({"SCREEN_CONTROL_REGISTERED_IPS": "100.64.0.20,100.64.0.20,100.64.0.30"}, False),
            ({"SCREEN_CONTROL_REGISTERED_IPS": "100.64.0.10,100.64.0.30,100.64.0.40"}, False)]:
            result = subprocess.run(["sh", str(script), "validate"], env={**CLEAN_ENV, **EXAMPLE, **overrides}, capture_output=True)
            self.assertEqual(result.returncode == 0, success, result.stderr)

    @unittest.skipUnless(PWSH, "PowerShell runtime not installed")
    def test_windows_block_ranges_cover_exact_complement(self):
        script = ROOT / "deploy/g0/meshagent/windows/meshagent-guard.ps1"
        for allowed in ["100.64.0.10,100.64.0.20,100.64.0.30", "100.64.0.22,100.64.0.20,100.64.0.21"]:
            result = subprocess.run([PWSH, "-NoLogo", "-NoProfile", "-File", str(script), "-Mode", "Validate"],
                env={**CLEAN_ENV, **EXAMPLE, "SCREEN_CONTROL_REGISTERED_IPS": allowed}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            ranges = json.loads(result.stdout)["blocked"]
            ints = {int(ipaddress.IPv4Address(ip)) for ip in allowed.split(",")}
            total, previous = 0, -1
            for interval in ranges:
                low, high = [int(ipaddress.IPv4Address(ip)) for ip in interval.split("-")]
                self.assertGreater(low, previous)
                self.assertGreaterEqual(high, low)
                self.assertFalse(any(low <= ip <= high for ip in ints))
                total += high - low + 1
                previous = high
            self.assertEqual(total, 2**32 - len(ints))

    def test_gitignore_excludes_runtime_secrets_but_keeps_templates_and_public_key(self):
        ignored = [".env", "gateway.env", "gateway/credentials.json", "gateway/phone.key",
                   "meshcentral-data/meshcentral.db", "logs/session.har", "config.json.bak", "deploy/spike/meshcentral/config.json"]
        public = [".env.example", "deploy/spike/meshcentral/config.example.json",
                  str(next((ROOT / "deploy/releases/current/evidence-keys").glob("*.pem")).relative_to(ROOT))]
        for path in ignored + public:
            result = subprocess.run(["git", "check-ignore", "--no-index", "-q", path], cwd=ROOT)
            self.assertEqual(result.returncode, 0 if path in ignored else 1, path)
