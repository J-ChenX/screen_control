"""普通用户文件进程的版本安装与拒绝 root 回归。"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class FileWorkerInstallTest(unittest.TestCase):
    def test_version_switch_and_privileged_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            commands = temp / 'commands'
            commands.mkdir()
            identity = commands / 'id'
            identity.write_text('#!/bin/sh\necho 1000\n')
            identity.chmod(0o700)
            binary = temp / 'worker'
            binary.write_text('fixture-one')
            env = dict(os.environ, HOME=str(temp), PATH=str(commands)+os.pathsep+os.environ['PATH'])
            def install():
                return subprocess.run(['bash', str(ROOT/'deploy/g0/files/install.sh'), str(binary)],env=env,capture_output=True)
            self.assertEqual(install().returncode,0)
            current=temp/'.local/lib/screen-control-files/current'
            previous=current.resolve()
            self.assertEqual((current/'screen-control-files').read_text(),'fixture-one')
            self.assertEqual((current/'screen-control-files').stat().st_mode & 0o777,0o700)
            binary.write_text('fixture-two')
            self.assertEqual(install().returncode,0)
            self.assertEqual((current/'previous').read_text().strip(),str(previous))
            self.assertEqual((previous/'screen-control-files').read_text(),'fixture-one')
            self.assertEqual((current/'screen-control-files').read_text(),'fixture-two')
            latest=current.resolve()
            identity.write_text('#!/bin/sh\necho 0\n')
            self.assertNotEqual(install().returncode,0)
            self.assertEqual(current.resolve(),latest)
