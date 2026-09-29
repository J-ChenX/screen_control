#!/usr/bin/env python3
"""验证超时回调同步断开 socket 后，事件循环不会访问无效 fd。"""

import argparse
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading


SCRIPT = r"""
var net=require('net'), done=0;
function connect(){
 var socket=net.createConnection({host:'127.0.0.1',port:__PORT__});
 socket.on('connect',function(){socket.setTimeout(1,function(){socket.end();});});
 socket.on('close',function(){
  done++;
  if(done===__COUNT__){console.log('done='+done);process.exit(0);}
  else setTimeout(connect,1);
 });
 socket.on('error',function(error){console.log('socket-error='+error);process.exit(2);});
}
setTimeout(function(){console.log('watchdog='+done);process.exit(3);},__WATCHDOG__);
connect();
"""


def run(binary: Path, iterations: int, expect_invalid_fd: bool) -> None:
    received = []
    errors = []
    with socket.socket() as server, tempfile.TemporaryDirectory(prefix="screen-control-preselect-") as temporary:
        server.bind(("127.0.0.1", 0))
        server.listen(32)
        server.settimeout(3)

        def peer() -> None:
            try:
                for _ in range(iterations):
                    connection, _ = server.accept()
                    with connection:
                        connection.settimeout(3)
                        while connection.recv(4096):
                            pass
                    received.append(True)
            except (OSError, TimeoutError) as error:
                errors.append(str(error))

        worker = threading.Thread(target=peer)
        worker.start()
        script = Path(temporary) / "timeout-disconnect.js"
        script.write_text(SCRIPT.replace("__PORT__", str(server.getsockname()[1]))
                          .replace("__COUNT__", str(iterations))
                          .replace("__WATCHDOG__", str(max(10000, iterations * 1000))))
        environment = dict(os.environ, ASAN_OPTIONS="detect_leaks=0:halt_on_error=1",
                           UBSAN_OPTIONS="halt_on_error=1")
        process = subprocess.run([str(binary), str(script)], cwd=temporary, env=environment,
                                 capture_output=True, text=True,
                                 timeout=max(20, iterations * 1.2 + 5))
        worker.join(timeout=4)
        if expect_invalid_fd:
            if process.returncode == 0 or "shift exponent -1 is negative" not in process.stderr:
                raise RuntimeError(f"旧候选未复现 FD_SET(-1)：exit={process.returncode}，"
                                   f"stdout={process.stdout[-300:]}，stderr={process.stderr[-800:]}")
            print("旧候选已复现 FD_SET(-1) 的 UBSan 错误")
            return
        if process.returncode != 0 or f"done={iterations}" not in process.stdout or \
                worker.is_alive() or errors or len(received) != iterations or \
                "ERROR: AddressSanitizer" in process.stderr or "runtime error:" in process.stderr:
            raise RuntimeError(f"超时断线回归失败：exit={process.returncode}，"
                               f"EOF={len(received)}/{iterations}，errors={errors}，"
                               f"stdout={process.stdout[-300:]}，stderr={process.stderr[-1200:]}")
    print(f"超时断线 {iterations} 次完成，服务端均收到 EOF，无 ASan/UBSan 报告")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=100)
    parser.add_argument("--expect-invalid-fd", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.iterations <= 1000:
        parser.error("--iterations 必须介于 1 和 1000 之间")
    run(args.binary.resolve(strict=True), args.iterations, args.expect_invalid_fd)


if __name__ == "__main__":
    main()
