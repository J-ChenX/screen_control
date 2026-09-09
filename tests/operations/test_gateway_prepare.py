import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/gateway/prepare.py'

class GatewayPrepareTests(unittest.TestCase):
    def test_private_keys_match_hashes_and_never_printed(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'gateway'
            p = subprocess.run([sys.executable, str(SCRIPT), '--origin', 'https://remote.example.com', '--directory', str(root)], text=True, capture_output=True)
            self.assertEqual(p.returncode, 0, p.stderr)
            data = json.loads((root / 'credentials.json').read_text())
            self.assertEqual(len(data), 3)
            for c in data:
                key = (root / (c['deviceId'] + '.key')).read_text().strip()
                self.assertEqual(len(bytes.fromhex(key)), 32)
                self.assertEqual(hashlib.sha256(key.encode()).hexdigest(), c['sha256'])
                self.assertNotIn(key, p.stdout + p.stderr)
            for path in root.iterdir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            again = subprocess.run([sys.executable, str(SCRIPT), '--origin', 'https://remote.example.com', '--directory', str(root)], capture_output=True)
            self.assertNotEqual(again.returncode, 0)
            self.assertEqual(json.loads((root / 'credentials.json').read_text()), data)

    def test_rejects_non_https_and_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            for origin in ['http://remote.example.com', 'https://remote.example.com/path', 'https://remote.example.com:8444']:
                p = subprocess.run([sys.executable, str(SCRIPT), '--origin', origin, '--directory', str(Path(tmp) / 'gateway')], capture_output=True)
                self.assertNotEqual(p.returncode, 0)
            self.assertFalse((Path(tmp) / 'gateway').exists())
