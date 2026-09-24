"""GC 配置只改内存策略，并保留可精确恢复的原始文件。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('sync_memory', ROOT / 'deploy/g0/suite/configure-syncclipboard-memory.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SyncClipboardMemoryTests(unittest.TestCase):
    def test_profiles_preserve_existing_settings_and_backup(self):
        for role, size in [('server', 256), ('desktop', 384)]:
            with self.subTest(role=role), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'App.runtimeconfig.json'
                original = b'{"runtimeOptions":{"tfm":"net8.0","configProperties":{"System.GC.Server":true,"other":7}}}\n'
                path.write_bytes(original)
                path.chmod(0o640)
                backup = MODULE.configure(path, role)
                self.assertEqual(backup.read_bytes(), original)
                result = json.loads(path.read_bytes())['runtimeOptions']
                self.assertEqual(result['tfm'], 'net8.0')
                self.assertEqual(result['configProperties'], {
                    'System.GC.Server': False, 'System.GC.ConserveMemory': 5,
                    'System.GC.HeapHardLimit': size * 1024 * 1024, 'other': 7,
                })
                self.assertEqual(path.stat().st_mode & 0o777, 0o640)
                second = MODULE.configure(path, role)
                self.assertNotEqual(second, backup)
                self.assertEqual(backup.read_bytes(), original)

    def test_reject_invalid_file_without_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'App.runtimeconfig.json'
            path.write_text('{invalid')
            with self.assertRaises(ValueError): MODULE.configure(path, 'desktop')
            self.assertEqual(path.read_text(), '{invalid')
            link = Path(directory) / 'Link.runtimeconfig.json'
            link.symlink_to(path)
            with self.assertRaises(ValueError): MODULE.configure(link, 'desktop')

    def test_process_budgets_leave_native_memory_headroom(self):
        for role, high, limit in [('server', 384, 512), ('desktop', 640, 768)]:
            text = (ROOT / f'deploy/g0/suite/syncclipboard-{role}-memory.conf').read_text()
            self.assertIn(f'MemoryHigh={high}M', text)
            self.assertIn(f'MemoryMax={limit}M', text)
            self.assertIn('OOMPolicy=kill', text)


if __name__ == '__main__': unittest.main()
