#!/usr/bin/env python3
"""将固定源码候选接入 Windows x64 的 MSVC 构建，不安装代理。"""

import argparse
import codecs
import hashlib
import json
from pathlib import Path
import re
import shutil


DEPENDENCIES = "$(SolutionDir)screen_control_protocol_ffi.lib;ntdll.lib;Userenv.lib;"
PROJECTS = (
    "meshservice/MeshService-2022.vcxproj",
    "meshconsole/MeshConsole-2022.vcxproj",
)


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def project_with_rust_library(raw: bytes, name: str) -> bytes:
    has_bom = raw.startswith(codecs.BOM_UTF8)
    source = raw.decode("utf-8-sig")
    pattern = (r'(<ItemDefinitionGroup Condition="\'\$\(Configuration\)\|\$\(Platform\)\'=='
               r'\'Release\|x64\'">)(.*?)(</ItemDefinitionGroup>)')
    matches = list(re.finditer(pattern, source, re.DOTALL))
    if len(matches) != 1:
        raise ValueError(f"{name}: Release|x64 配置不唯一")
    match = matches[0]
    section = match.group(2)
    anchor = "<AdditionalDependencies>"
    if section.count(anchor) != 1 or DEPENDENCIES in section:
        raise ValueError(f"{name}: 链接入口不符合固定源码")
    section = section.replace(anchor, anchor + DEPENDENCIES, 1)
    result = source[: match.start(2)] + section + source[match.end(2) :]
    return (codecs.BOM_UTF8 if has_bom else b"") + result.encode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, required=True,
                        help="build.py --prepare-only 生成的独立目录")
    parser.add_argument("--library", type=Path, required=True,
                        help="锁定工具链生成的 x86_64-pc-windows-msvc 静态库")
    args = parser.parse_args()
    work = args.work_dir.resolve(strict=True)
    library = args.library.resolve(strict=True)
    if library.name != "screen_control_protocol_ffi.lib":
        parser.error("需要 screen_control_protocol_ffi.lib")
    metadata_file = work / "candidate.json"
    metadata = json.loads(metadata_file.read_text(encoding="utf-8"))
    if metadata.get("status") != "prepared-not-deployed":
        parser.error("仅接受未部署、尚未修改的固定源码候选")
    source = work / f"MeshAgent-{metadata['baselineCommit']}"
    if not source.is_dir() or (source / library.name).exists():
        parser.error("候选源码缺失或 Rust 静态库已存在")

    updates: dict[Path, bytes] = {}
    for relative in PROJECTS:
        path = source / relative
        updates[path] = project_with_rust_library(path.read_bytes(), relative)

    resource = source / "meshservice/MeshService.rc"
    old_header = '"afxres.h"'.encode("utf-16le")
    resource_bytes = resource.read_bytes()
    if resource_bytes.count(old_header) != 2:
        parser.error("资源文件头部不符合固定源码")
    updates[resource] = resource_bytes.replace(old_header, '"winres.h"'.encode("utf-16le"))

    emitter = source / "microscript/ILibduktape_EventEmitter.c"
    lines = emitter.read_bytes().splitlines(keepends=True)
    comment = "// 固定 Polyfills.c 的立即计时器类型；直接调用原生入口，避免全局函数被脚本覆盖。".encode()
    expected_comment = 1 if "lifetimePatchSha256" in metadata else 0
    if sum(line.startswith(comment) for line in lines) != expected_comment:
        parser.error("事件转发的 MSVC 编码边界不符合固定源码")
    if expected_comment:
        updates[emitter] = b"".join(line for line in lines if not line.startswith(comment))

    for path, data in updates.items():
        path.write_bytes(data)
    shutil.copyfile(library, source / library.name)
    metadata.update(
        status="prepared-windows-not-deployed",
        windowsMsvcTarget="x86_64-pc-windows-msvc",
        windowsMsvcLibrarySha256=digest(source / library.name),
        windowsMsvcFilesSha256={str(path.relative_to(source)): digest(path) for path in updates},
    )
    metadata_file.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8")
    print(json.dumps({"status": metadata["status"],
                      "librarySha256": metadata["windowsMsvcLibrarySha256"],
                      "files": metadata["windowsMsvcFilesSha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
