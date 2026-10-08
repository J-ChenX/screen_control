"""验证 CI 范围选择、Git 重命名与保守回退，防止检查被意外跳过。"""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ci_plan", ROOT / "ops/ci/plan.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CIPlanTests(unittest.TestCase):
    def test_document_only_pr_does_not_run_builds_or_codeql(self):
        plan = MODULE.select("pull_request", ["README.md", "docs/USAGE.md", ".github/ISSUE_TEMPLATE/help.yml"])
        self.assertFalse(any(plan[key] for key in (*MODULE.MODULES, "compat", "codeql")))
        self.assertTrue(plan["codeql_matrix"]["include"])

    def test_frontend_and_backend_changes_have_independent_checks(self):
        web = MODULE.select("pull_request", ["web/src/app/App.tsx", "web/src/styles.css"])
        self.assertEqual([key for key in MODULE.MODULES if web[key]], ["web"])
        self.assertEqual(web["languages"], ["javascript-typescript"])
        go = MODULE.select("pull_request", ["internal/g0files/worker.go"])
        self.assertEqual([key for key in MODULE.MODULES if go[key]], ["go"])
        self.assertEqual(go["languages"], ["go"])

    def test_lock_changes_also_validate_hash_bindings(self):
        for path, module in [("web/pnpm-lock.yaml", "web"), ("go.mod", "go"), ("Cargo.lock", "native")]:
            with self.subTest(path=path):
                plan = MODULE.select("pull_request", [path])
                self.assertTrue(plan[module])
                self.assertTrue(plan["operations"])

    def test_python_browser_harness_selects_both_web_and_python(self):
        plan = MODULE.select("pull_request", ["tests/browser/gateway_smoke.py"])
        self.assertTrue(plan["web"])
        self.assertEqual(plan["languages"], ["javascript-typescript", "python"])

    def test_native_keeps_cross_platform_checks_without_unrelated_scans(self):
        plan = MODULE.select("pull_request", ["native/protocol-ffi/src/lib.rs", "tests/native/websocket_abi.c"])
        self.assertEqual([key for key in MODULE.MODULES if plan[key]], ["native"])
        self.assertFalse(plan["codeql"])

    def test_unknown_scope_and_shared_controls_select_all(self):
        for paths in [None, ["unknown/build.cfg"], [".github/workflows/ci.yml"], ["ops/ci/plan.py"]]:
            with self.subTest(paths=paths):
                plan = MODULE.select("pull_request", paths)
                self.assertTrue(all(plan[key] for key in MODULE.MODULES))
                self.assertEqual(plan["languages"], list(MODULE.LANGUAGES))
                self.assertFalse(plan["compat"])

    def test_main_and_manual_keep_full_checks_and_compatibility(self):
        for event in ["push", "workflow_dispatch"]:
            plan = MODULE.select(event, ["README.md"])
            self.assertTrue(all(plan[key] for key in (*MODULE.MODULES, "compat", "codeql")))

    def test_git_rename_includes_removed_code_and_added_document(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, text=True).strip()
            git("init", "-q")
            git("config", "user.email", "ci@example.invalid")
            git("config", "user.name", "CI 测试")
            git("config", "commit.gpgsign", "false")
            (root / "web").mkdir()
            (root / "web/source.ts").write_text("export const value = 1;\n")
            git("add", ".")
            git("commit", "-qm", "初始夹具")
            base = git("rev-parse", "HEAD")
            git("mv", "web/source.ts", "README.md")
            git("commit", "-qm", "重命名夹具")
            paths = MODULE.changed_paths(root, "pull_request", base, git("rev-parse", "HEAD"))
            self.assertEqual(set(paths), {"web/source.ts", "README.md"})
            self.assertTrue(MODULE.select("pull_request", paths)["web"])
            self.assertIsNone(MODULE.changed_paths(root, "pull_request", "--help", base))
            self.assertIsNone(MODULE.changed_paths(root, "push", "0" * 40, base))
            self.assertIsNone(MODULE.changed_paths(root, "pull_request", "f" * 40, base))

    def test_document_links_handle_deleted_files_and_ignore_examples(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs").mkdir()
            (root / "README.md").write_text("[说明](docs/with%20space.md#标题)\n```md\n[例子](missing.md)\n```\n")
            (root / "docs/with space.md").write_text("# 标题\n")
            MODULE.check_documents(root, ["README.md", "deleted.md"])
            (root / "docs/with space.md").unlink()
            with self.assertRaisesRegex(ValueError, "本地链接不存在"):
                MODULE.check_documents(root, ["README.md"])


if __name__ == "__main__":
    unittest.main()
