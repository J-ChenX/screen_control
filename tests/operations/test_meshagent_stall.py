"""显式启用的隔离 cgroup 回归；只创建临时测试单元，不操作真实代理。"""
from pathlib import Path
import os
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT).strip()


@unittest.skipUnless(os.environ.get('SCREEN_CONTROL_STALL_SYSTEM_TEST') == '1',
                     '需 root 显式启用隔离 systemd 压力测试')
class MeshAgentStallTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(os.geteuid(), 0)
        self.unit = 'screen-control-stall-test-' + uuid.uuid4().hex + '.service'
        self.temp = tempfile.TemporaryDirectory(prefix='screen-control-stall-')
        self.root = Path(self.temp.name)

    def tearDown(self):
        subprocess.run(['systemctl', 'stop', self.unit], capture_output=True, timeout=40)
        subprocess.run(['systemctl', 'reset-failed', self.unit], capture_output=True)
        self.temp.cleanup()

    def start(self, source, *extra):
        script = self.root / 'fixture.py'
        script.write_text(source)
        settings = []
        for line in (ROOT / 'deploy/g0/meshagent/linux/60-stall-recovery.conf').read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                settings += ['-p', line]
        run('systemd-run', '--quiet', '--unit=' + self.unit,
            '-p', 'MemoryAccounting=yes', '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0',
            '-p', 'OOMPolicy=kill', '-p', 'Restart=always', '-p', 'RestartSec=1s',
            *settings, *extra, '/usr/bin/python3', str(script), str(self.root))

    def wait_for(self, predicate, timeout=25):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if predicate():
                return
            time.sleep(.1)
        self.fail('隔离服务未在期限内达到预期状态')

    def group(self):
        return Path('/sys/fs/cgroup' + run('systemctl', 'show', self.unit, '-p', 'ControlGroup', '--value'))

    def test_high_throttled_pipe_resumes_without_raising_hard_limit(self):
        # 父进程阻塞读管道，子进程持有连接并分配匿名页，模拟现场等待链。
        self.start('''import os, socket, sys, time
from pathlib import Path
root = Path(sys.argv[1])
a, b = socket.socketpair()
r, w = os.pipe()
if os.fork() == 0:
    os.close(r)
    data = bytearray(48 * 1024 * 1024)
    os.write(w, b'done')
    time.sleep(60)
else:
    os.close(w)
    os.read(r, 4)
    (root / 'resumed').touch()
    time.sleep(60)
''', '-p', 'MemoryHigh=24M')
        group = self.group()
        self.wait_for(lambda: int(dict(line.split() for line in (group / 'memory.events').read_text().splitlines())['high']) > 0)
        self.assertFalse((self.root / 'resumed').exists())
        run('systemctl', 'set-property', '--runtime', self.unit, 'MemoryHigh=infinity')
        self.wait_for(lambda: (self.root / 'resumed').exists())
        self.assertEqual((group / 'memory.max').read_text().strip(), str(64 * 1024 * 1024))
        self.assertEqual((group / 'memory.high').read_text().strip(), 'max')

    def test_oom_kills_waiting_parent_and_restarts_healthy(self):
        self.start('''import os, sys, time
from pathlib import Path
root = Path(sys.argv[1])
if (root / 'started').exists():
    (root / 'recovered').touch()
    time.sleep(60)
else:
    (root / 'started').touch()
    r, w = os.pipe()
    if os.fork() == 0:
        os.close(r)
        data = bytearray(128 * 1024 * 1024)
        os.write(w, b'done')
    else:
        os.close(w)
        os.read(r, 4)
        time.sleep(60)
''')
        self.wait_for(lambda: (self.root / 'recovered').exists())
        self.assertEqual(run('systemctl', 'show', self.unit, '-p', 'NRestarts', '--value'), '1')
        self.assertEqual(run('systemctl', 'is-active', self.unit), 'active')
        self.assertEqual(len((self.group() / 'cgroup.procs').read_text().split()), 1)

    def test_stop_escalates_for_entire_process_tree(self):
        self.start('''import os, signal, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = os.fork()
if child:
    Path(sys.argv[1], 'pids').write_text(str(os.getpid()) + ' ' + str(child))
time.sleep(120)
''')
        self.wait_for(lambda: (self.root / 'pids').exists())
        pids = (self.root / 'pids').read_text().split()
        started = time.monotonic()
        run('systemctl', 'stop', self.unit)
        self.assertLess(time.monotonic() - started, 25)
        for pid in pids:
            self.assertFalse(Path('/proc', pid).exists())

    def test_repeated_failures_stop_at_rate_limit(self):
        self.start("import sys\nfrom pathlib import Path\nwith Path(sys.argv[1], 'attempts').open('a') as f: f.write('attempt\\n')\nraise SystemExit(1)")
        self.wait_for(lambda: run('systemctl', 'show', self.unit, '-p', 'ActiveState', '--value') == 'failed')
        self.assertEqual((self.root / 'attempts').read_text().splitlines(), ['attempt'] * 3)
        self.assertEqual(run('systemctl', 'show', self.unit, '-p', 'ActiveState', '--value'), 'failed')


if __name__ == '__main__':
    unittest.main()
