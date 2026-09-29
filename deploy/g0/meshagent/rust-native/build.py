#!/usr/bin/env python3
"""从固定源码构建 Rust 帧与分片候选；不安装、不读取代理身份或修改服务。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[4]
COMMIT = "62b206e0b485b296e8a73a6547cef02bbf5a2d62"
ARCHIVE_SHA = "90931268906e6dd174a048949fa2e28200cca56f909d99aa4be843bfa918e602"
LIFETIME_PATCHES = (
    "event-emitter-forward-weak-cell.patch",
    "net-socket-active-root.patch",
    "http-callback-lifetime.patch",
    "event-emitter-finalizer-once.patch",
    "async-socket-preselect-disconnect.patch",
)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--sanitizers", action="store_true", help="用 ASan/UBSan 构建并检查完整 Linux 代理")
    parser.add_argument("--lifetime-candidate", action="store_true",
                        help="额外叠加尚未发布的原生生命周期补丁，仅生成隔离候选")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    work = args.work_dir.resolve()
    # 每次候选使用独立目录，不覆盖已有源码、产物或证据。
    work.mkdir(parents=True, exist_ok=False)
    archive = work / "source.tar.gz"
    if args.archive:
        shutil.copyfile(args.archive, archive)
    else:
        urllib.request.urlretrieve(f"https://codeload.github.com/Ylianst/MeshAgent/tar.gz/{COMMIT}", archive)
    if digest(archive) != ARCHIVE_SHA:
        raise SystemExit("固定源码摘要不符，停止构建")
    with tarfile.open(archive) as bundle:
        bundle.extractall(work, filter="data")
    source = work / f"MeshAgent-{COMMIT}"
    memory = ROOT / "deploy/g0/meshagent/native-memory"
    manifest = json.loads((memory / "native-memory-manifest.json").read_text())
    backport = memory / "native-memory-backport.patch"
    if digest(backport) != manifest["backportPatchSha256"]:
        raise SystemExit("原生回收候选摘要不符，停止构建")
    rust_patch = Path(__file__).with_name("websocket-rust.patch")
    metadata_patch = Path(__file__).with_name("metadata-ownership.patch")
    tile_patch = Path(__file__).with_name("linux-tile-rust.patch")
    ximage_patch = Path(__file__).with_name("linux-ximage-rust.patch")
    jpeg_patch = Path(__file__).with_name("linux-jpeg-buffer.patch")
    checksum_patch = Path(__file__).with_name("linux-checksum-rust.patch")
    windows_tile_patch = Path(__file__).with_name("windows-tile-rust.patch")
    pipe_patch = Path(__file__).with_name("readable-stream-pipe.patch")
    pipe_stash_patch = Path(__file__).with_name("readable-stream-stash.patch")
    timer_patch = Path(__file__).with_name("timer-lifetime.patch")
    patches = [backport, rust_patch, metadata_patch, tile_patch, ximage_patch, jpeg_patch, checksum_patch,
               windows_tile_patch,
               pipe_patch, pipe_stash_patch, timer_patch]
    if args.lifetime_candidate:
        patches.extend(Path(__file__).with_name(name) for name in LIFETIME_PATCHES)
    for patch in patches:
        subprocess.run(["patch", "--batch", "--fuzz=0", "-p1", "-i", str(patch)], cwd=source, check=True)
    header = ROOT / "native/protocol-ffi/include/screen_control_protocol.h"
    shutil.copyfile(header, source / "microstack/screen_control_protocol.h")
    # 压缩包没有 Git 元数据，禁止 make 误用父目录本项目的提交号。
    environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(work))
    jpeg_headers = source / "lib-jpeg-turbo/includes"
    environment["CPATH"] = str(jpeg_headers) + os.pathsep + environment.get("CPATH", "")
    (source / "microscript/ILibDuktape_Commit.h").write_text(
        '#define SOURCE_COMMIT_DATE "2026-02-15 + screen-control candidate"\n'
        f'#define SOURCE_COMMIT_HASH "{COMMIT}+406+415+rust-frame"\n'
    )
    metadata = {"status": "prepared-not-deployed", "baselineCommit": COMMIT,
                "archiveSha256": ARCHIVE_SHA, "backportSha256": digest(backport),
                "rustPatchSha256": digest(rust_patch), "metadataPatchSha256": digest(metadata_patch),
                "tilePatchSha256": digest(tile_patch), "ximagePatchSha256": digest(ximage_patch),
                "windowsTilePatchSha256": digest(windows_tile_patch),
                "jpegPatchSha256": digest(jpeg_patch), "checksumPatchSha256": digest(checksum_patch),
                "readablePipePatchSha256": digest(pipe_patch),
                "readablePipeStashPatchSha256": digest(pipe_stash_patch),
                "timerPatchSha256": digest(timer_patch),
                "headerSha256": digest(header), "jpegConfigSha256": digest(jpeg_headers / "jconfig.h")}
    if args.lifetime_candidate:
        metadata["lifetimePatchSha256"] = {
            name: digest(Path(__file__).with_name(name)) for name in LIFETIME_PATCHES
        }
    if not args.prepare_only:
        subprocess.run(["mise", "exec", "--", "cargo", "build", "--locked", "--release", "-p", "screen-control-protocol-ffi"], cwd=ROOT, check=True)
        library = ROOT / "target/release/libscreen_control_protocol_ffi.a"
        # 固定上游 JPEG 静态库非 PIC；保留原 makefile 的非 PIE 链接方式。
        sanitizer_flags = "-fsanitize=address,undefined -fno-omit-frame-pointer" if args.sanitizers else ""
        flags = f"{sanitizer_flags} -no-pie -L. {library} -lpthread -lutil -lm"
        make_command = ["make", "linux", "ARCHID=6", f"-j{args.jobs}", f"LDFLAGS={flags}"]
        if args.sanitizers:
            make_command.append(f"CC=gcc {sanitizer_flags}")
        with (work / "build.log").open("w") as log:
            subprocess.run(make_command, cwd=source, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)
        binary = source / ("DEBUG_meshagent_x86-64" if args.sanitizers else "meshagent_x86-64")
        metadata.update(status="built-not-deployed", binarySha256=digest(binary), librarySha256=digest(library))
        if args.sanitizers:
            environment.update(ASAN_OPTIONS="detect_leaks=0:halt_on_error=1", UBSAN_OPTIONS="halt_on_error=1")
            metadata["sanitizers"] = "address,undefined; Linux C and C-callable path"
        subprocess.run([str(binary), "-info"], cwd=work, env=environment, check=True)
        tile_object = work / "tile-integration.o"
        tile_binary = work / "tile-integration"
        subprocess.run(["cc", "-std=gnu99", "-D_POSIX", "-DJPEGMAXBUF=0", "-ffunction-sections", "-fdata-sections",
                        *sanitizer_flags.split(), "-I.", "-Imeshcore", "-Imicrostack", "-c",
                        "meshcore/KVM/Linux/linux_tile.c", "-o", str(tile_object)],
                       cwd=source, env=environment, check=True)
        subprocess.run(["cc", *sanitizer_flags.split(), "-Wl,--gc-sections",
                        str(ROOT / "tests/native/tile_integration.c"), str(tile_object), str(library),
                        "-ldl", "-lpthread", "-lm", "-o", str(tile_binary)],
                       cwd=source, env=environment, check=True)
        subprocess.run([str(tile_binary)], cwd=work, env=environment, check=True)
        metadata["captureHarness"] = "passed-with-real-linux-tile-and-ximage-c-callsites"
        jpeg_object = work / "jpeg-compression.o"
        jpeg_binary = work / "jpeg-pipeline"
        subprocess.run(["cc", "-std=gnu99", "-D_POSIX", "-DJPEGMAXBUF=0", "-ffunction-sections", "-fdata-sections",
                        *sanitizer_flags.split(), "-I.", "-Imeshcore", "-Imicrostack", "-c",
                        "meshcore/KVM/Linux/linux_compression.c", "-o", str(jpeg_object)],
                       cwd=source, env=environment, check=True)
        jpeg_library = source / "lib-jpeg-turbo/linux/x86-64/libturbojpeg.a"
        subprocess.run(["cc", *sanitizer_flags.split(), "-no-pie", "-Wl,--gc-sections", "-I.",
                        str(ROOT / "tests/native/jpeg_pipeline.c"), str(tile_object), str(jpeg_object),
                        str(library), str(jpeg_library), "-ldl", "-lpthread", "-lm", "-o", str(jpeg_binary)],
                       cwd=source, env=environment, check=True)
        for mode in ((), ("--large",), ("--huge",)):
            subprocess.run([str(jpeg_binary), *mode], cwd=work, env=environment, check=True)
        metadata["jpegPipelineHarness"] = "32-512-2048-passed-with-vendored-headers-and-static-jpeg"
        subprocess.run(["python3", str(ROOT / "tests/native/check_integration.py"), "--source", str(source)], cwd=ROOT, check=True)
        network = ["python3", str(ROOT / "tests/native/script_ws_network.py"), "--binary", str(binary)]
        if args.sanitizers:
            network.extend(["--process-timeout", "12"])
        subprocess.run(network, cwd=ROOT, env=environment, check=True)
        subprocess.run(["python3", str(ROOT / "tests/native/readable_pipe_network.py"),
                        "--binary", str(binary)], cwd=ROOT, env=environment, check=True)
        subprocess.run(["python3", str(ROOT / "tests/native/timer_lifetime.py"),
                        "--binary", str(binary)], cwd=ROOT, env=environment, check=True)
        metadata["receiveDestructorHarness"] = "passed-as-an-isolated-C-harness"
        metadata["scriptNetworkHarness"] = "passed-on-loopback-without-agent-identity"
        metadata["readablePipeHarness"] = "two-sequential-unpipe-cases-passed-on-loopback"
        metadata["timerHarness"] = "nested-discarded-timeout-handles-passed-in-full-process"
    (work / "candidate.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()
