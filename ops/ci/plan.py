#!/usr/bin/env python3
"""按提交差异选择 CI 检查；范围未知时保守运行全量。"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
MODULES = ("go", "web", "native", "operations")
LANGUAGES = ("go", "javascript-typescript", "python", "actions")
SHARED = {".mise.toml", "Makefile", "ops/ci/plan.py", "tests/operations/test_ci_plan.py"}
LOCK_INPUTS = {"go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
               "native/protocol-core/Cargo.toml", "native/protocol-ffi/Cargo.toml",
               "web/package.json", "web/pnpm-lock.yaml", "web/pnpm-workspace.yaml"}
SHA = re.compile(r"[0-9a-f]{40,64}\Z")
LINK = re.compile(r"!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)")


def changed_paths(root: Path, event: str, base: str, head: str) -> list[str] | None:
    """不接受任意 Git 参数；保留新增、删除及重命名两侧路径。"""
    if not SHA.fullmatch(base) or not SHA.fullmatch(head) or set(base) == {"0"}:
        return None
    comparison = f"{base}...{head}" if event == "pull_request" else f"{base}..{head}"
    try:
        result = subprocess.run(
            ["git", "diff", "--no-renames", "--name-only", "-z", comparison],
            cwd=root, check=True, capture_output=True,
        )
    except subprocess.CalledProcessError:
        return None
    subprocess.run(["git", "diff", "--check", comparison], cwd=root, check=True)
    return [os.fsdecode(value) for value in result.stdout.split(b"\0") if value]


def is_document(path: str) -> bool:
    return (path.endswith(".md") or path in {"LICENSE", ".github/CODEOWNERS"}
            or path.startswith(".github/ISSUE_TEMPLATE/"))


def select(event: str, paths: list[str] | None) -> dict:
    modules: set[str] = set()
    languages: set[str] = set()
    full = event != "pull_request" or paths is None
    for path in paths or []:
        if is_document(path):
            continue
        if path in SHARED or path.startswith(".github/workflows/"):
            full = True
            continue
        known = False
        if path.startswith(("cmd/", "internal/")) or path in {"go.mod", "go.sum"}:
            modules.add("go")
            languages.add("go")
            known = True
        if path.startswith(("web/", "tests/browser/")):
            modules.add("web")
            languages.add("javascript-typescript")
            known = True
        if path.startswith(("native/", "tests/native/", "deploy/g0/meshagent/rust-native/")) or path in {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml"}:
            modules.add("native")
            known = True
        if path.startswith(("ops/", "deploy/", "tests/operations/")) or path in {".env.example", ".gitignore", ".gitattributes", ".editorconfig"}:
            modules.add("operations")
            known = True
        if path in LOCK_INPUTS or path.startswith("deploy/releases/current/"):
            modules.add("operations")
        if path.endswith(".py"):
            languages.add("python")
        if path.endswith((".js", ".mjs", ".cjs", ".ts", ".tsx")):
            languages.add("javascript-typescript")
        if not known:
            full = True
    if full:
        modules.update(MODULES)
        languages.update(LANGUAGES)
    ordered = [language for language in LANGUAGES if language in languages]
    matrix = [{"language": language, "build-mode": "manual" if language == "go" else "none"}
              for language in ordered]
    return {
        **{module: module in modules for module in MODULES},
        "compat": event != "pull_request", "codeql": bool(matrix),
        # 保留合法占位矩阵，作业条件为 false 时不会实际执行。
        "codeql_matrix": {"include": matrix or [{"language": "actions", "build-mode": "none"}]},
        "languages": ordered, "full": full,
    }


def check_documents(root: Path, paths: list[str]) -> None:
    """仅核对本次修改的 Markdown 本地路径，保留历史文档的原始范围。"""
    errors = []
    for relative in paths:
        path = root / relative
        if path.suffix != ".md" or not path.is_file():
            continue
        # 代码示例中的 Markdown 不作为可点击文档链接。
        source = re.sub(r"(?ms)^(`{3,}|~{3,}).*?^\1[^\n]*$", "", path.read_text(encoding="utf-8"))
        for match in LINK.finditer(source):
            target = match[1].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            resolved = (root if parsed.path.startswith("/") else path.parent) / unquote(parsed.path.lstrip("/"))
            if not resolved.exists():
                errors.append(f"{relative}: 本地链接不存在 {target}")
    if errors:
        raise ValueError("\n".join(errors))


def main() -> int:
    event = os.environ.get("CI_EVENT", "workflow_dispatch")
    paths = changed_paths(ROOT, event, os.environ.get("BASE_SHA", ""), os.environ.get("HEAD_SHA", ""))
    check_documents(ROOT, paths or [])
    plan = select(event, paths)
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    if output := os.environ.get("GITHUB_OUTPUT"):
        with Path(output).open("a", encoding="utf-8") as stream:
            for key in (*MODULES, "compat", "codeql", "codeql_matrix"):
                stream.write(f"{key}={json.dumps(plan[key], separators=(',', ':'))}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        selected = "、".join(module for module in MODULES if plan[module]) or "无，仅轻量检查"
        mode = "主分支或手动全量" if event != "pull_request" else ("范围未知或共享配置变更，全量" if plan["full"] else "按 PR 变更选择")
        with Path(summary).open("a", encoding="utf-8") as stream:
            stream.write(f"### CI 检查范围\n\n- 模式：{mode}\n- 构建与测试：{selected}\n- CodeQL：{'、'.join(plan['languages']) or '跳过'}\n- Go 兼容版：{'运行' if plan['compat'] else '跳过'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
