#!/usr/bin/env python3
"""IO-04a 加密在线备份与隔离恢复基线，失败时默认拒绝继续。"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import time
from typing import Any


SCHEMA = "screen-control.backup-receipt/v1"
ARCHIVE_SCHEMA = "screen-control.backup-archive/v1"
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_FILES = 4096
FIXTURE_SECRET = b"io04a-synthetic-credential-must-remain-encrypted"


def canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(path, 0o700)


def validate_key(path: Path) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError("backup key must be a regular file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode not in {0o400, 0o600}:
        raise ValueError("backup key mode must be 0400 or 0600")
    if path.stat().st_size < 32 or path.stat().st_size > 4096:
        raise ValueError("backup key size is invalid")


def init_key(path: Path) -> dict[str, Any]:
    if path.exists() or path.is_symlink():
        raise FileExistsError("refusing to replace backup key")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    try:
        os.write(descriptor, (secrets.token_urlsafe(48) + "\n").encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    validate_key(path)
    return {"created": True, "mode": "0400"}


def gpg_command(key: Path, decrypt: bool = False) -> list[str]:
    base = [
        "gpg", "--no-options", "--batch", "--yes", "--no-symkey-cache",
        "--pinentry-mode", "loopback", "--passphrase-file", str(key),
    ]
    if decrypt:
        return [*base, "--decrypt"]
    return [
        *base, "--symmetric", "--cipher-algo", "AES256", "--compress-algo", "none",
        "--s2k-mode", "3", "--s2k-digest-algo", "SHA512", "--s2k-count", "1048576",
    ]


def sqlite_online_backup(source: Path, destination: Path) -> dict[str, Any]:
    source_uri = f"file:{source}?mode=ro"
    with sqlite3.connect(source_uri, uri=True, timeout=5) as live, sqlite3.connect(destination) as snapshot:
        live.backup(snapshot)
    os.chmod(destination, 0o600)
    with sqlite3.connect(f"file:{destination}?mode=ro", uri=True) as restored:
        check = restored.execute("PRAGMA integrity_check").fetchone()[0]
        if check != "ok":
            raise RuntimeError("SQLite online backup failed integrity_check")
        page_count = restored.execute("PRAGMA page_count").fetchone()[0]
    return {"integrity": check, "pages": page_count, "sha256": sha256_file(destination)}


def safe_name(name: str) -> PurePosixPath:
    value = PurePosixPath(name)
    if value.is_absolute() or not value.parts or any(part in {"", ".", ".."} for part in value.parts):
        raise ValueError("unsafe archive member")
    if value.parts[0] not in {"manifest.json", "payload"}:
        raise ValueError("archive member outside fixed roots")
    return value


def add_regular(archive: tarfile.TarFile, source: Path, name: str) -> None:
    value = source.read_bytes()
    if len(value) > MAX_FILE_BYTES:
        raise ValueError("backup source file exceeded bound")
    info = tarfile.TarInfo(name)
    info.size = len(value)
    info.mode = 0o600
    info.mtime = 0
    archive.addfile(info, io.BytesIO(value))


def encrypt_stage(stage: Path, manifest: dict[str, Any], archive_path: Path, key: Path) -> None:
    validate_key(key)
    with archive_path.open("xb") as encrypted:
        process = subprocess.Popen(gpg_command(key), stdin=subprocess.PIPE, stdout=encrypted, stderr=subprocess.PIPE)
        assert process.stdin is not None and process.stderr is not None
        try:
            with tarfile.open(fileobj=process.stdin, mode="w|") as archive:
                manifest_bytes = canonical(manifest)
                info = tarfile.TarInfo("manifest.json")
                info.size = len(manifest_bytes)
                info.mode = 0o600
                info.mtime = 0
                archive.addfile(info, io.BytesIO(manifest_bytes))
                for path in sorted(stage.rglob("*")):
                    if path.is_symlink():
                        raise ValueError("backup source symlink is forbidden")
                    if path.is_file():
                        add_regular(archive, path, "payload/" + path.relative_to(stage).as_posix())
            process.stdin.close()
            process.stdin = None
            _, stderr = process.communicate(timeout=60)
            code = process.returncode
        except BaseException:
            process.kill()
            process.communicate()
            raise
    if code != 0 or len(stderr) > MAX_FILE_BYTES:
        raise RuntimeError("GPG encryption failed")
    os.chmod(archive_path, 0o400)


def decrypt_archive(archive_path: Path, restore: Path, key: Path) -> dict[str, Any]:
    validate_key(key)
    if archive_path.is_symlink() or not archive_path.is_file() or archive_path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("encrypted archive is unsafe or too large")
    process = subprocess.Popen(gpg_command(key, decrypt=True) + [str(archive_path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None and process.stderr is not None
    manifest: dict[str, Any] | None = None
    extracted = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                extracted += 1
                if extracted > MAX_FILES or not member.isfile() or member.issym() or member.islnk():
                    raise ValueError("archive member type/count is unsafe")
                name = safe_name(member.name)
                if member.size > MAX_FILE_BYTES:
                    raise ValueError("archive member exceeded bound")
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValueError("archive member has no content")
                value = stream.read(MAX_FILE_BYTES + 1)
                if len(value) != member.size:
                    raise ValueError("archive member size mismatch")
                if member.name == "manifest.json":
                    manifest = json.loads(value)
                    continue
                destination = restore.joinpath(*name.parts[1:])
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.chmod(destination.parent, 0o700)
                descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    os.write(descriptor, value)
                finally:
                    os.close(descriptor)
        process.stdout.close()
        process.stdout = None
        _, stderr = process.communicate(timeout=60)
        code = process.returncode
    except BaseException:
        process.kill()
        process.communicate()
        raise
    if code != 0 or len(stderr) > MAX_FILE_BYTES or manifest is None:
        raise RuntimeError("GPG decryption or manifest recovery failed")
    return manifest


def tree_digest(root: Path) -> str:
    values = []
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("fixture tree contains symlink")
        # SQLite 在只读在线备份期间可能正常更新共享内存中的协调字节。
        # 通过备份 API 和 integrity_check 验证数据库的逻辑状态；
        # 受保护目录树的变更检测仅排除这些
        # 已记录的临时辅助文件。
        if path.is_file() and not path.name.endswith(("-wal", "-shm")):
            relative = path.relative_to(root).as_posix()
            if path.suffix == ".db":
                with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as database:
                    logical = hashlib.sha256(("\n".join(database.iterdump()) + "\n").encode()).hexdigest()
                values.append([relative, "sqlite-logical", logical])
            else:
                values.append([relative, path.stat().st_size, sha256_file(path)])
    return hashlib.sha256(canonical(values)).hexdigest()


def create_database(path: Path, role: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with sqlite3.connect(path) as database:
        database.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE recovery_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL);
            INSERT INTO recovery_state VALUES(1, 7);
            CREATE TABLE credentials(id TEXT PRIMARY KEY, issued_epoch INTEGER NOT NULL);
            INSERT INTO credentials VALUES('synthetic-old-device', 7);
            CREATE TABLE sessions(id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
            INSERT INTO sessions VALUES('synthetic-old-session', 7);
            CREATE TABLE capabilities(id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
            INSERT INTO capabilities VALUES('synthetic-old-capability', 7);
            CREATE TABLE leases(id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
            INSERT INTO leases VALUES('synthetic-old-lease', 7);
            CREATE TABLE operations(id TEXT PRIMARY KEY, status TEXT NOT NULL);
            INSERT INTO operations VALUES('synthetic-pending-operation', 'pending');
            CREATE TABLE fixture(role TEXT NOT NULL, marker BLOB NOT NULL);
        """)
        database.execute("INSERT INTO fixture VALUES(?, ?)", (role, FIXTURE_SECRET))
        database.commit()
    os.chmod(path, 0o600)


def create_fixture(source: Path) -> dict[str, str]:
    source.mkdir(mode=0o700)
    for relative, role in {
        "sqlite/control.db": "control",
        "mesh/mesh.db": "mesh",
        "sync/history.db": "syncclipboard",
    }.items():
        create_database(source / relative, role)
    for relative, value in {
        "config/service.json": {"schema": 1, "credential": FIXTURE_SECRET.decode()},
        "mesh/config.json": {"schema": 1, "agentCredential": FIXTURE_SECRET.decode()},
        "sync/config.json": {"schema": 1, "deviceCredential": FIXTURE_SECRET.decode()},
    }.items():
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(canonical(value))
        os.chmod(path, 0o600)
    history = source / "sync/history/synthetic.txt"
    history.parent.mkdir(parents=True, mode=0o700)
    history.write_bytes(b"synthetic clipboard content")
    os.chmod(history, 0o600)
    return {"sourceTreeSha256": tree_digest(source)}


def stage_online_backup(source: Path, stage: Path) -> dict[str, Any]:
    private_directory(stage)
    sqlite_results: dict[str, Any] = {}
    database_paths = {"sqlite/control.db", "mesh/mesh.db", "sync/history.db"}
    for path in sorted(source.rglob("*")):
        if not path.is_file() or path.name.endswith(("-wal", "-shm")):
            continue
        relative = path.relative_to(source).as_posix()
        destination = stage / relative
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(destination.parent, 0o700)
        if relative in database_paths:
            sqlite_results[relative] = sqlite_online_backup(path, destination)
        else:
            shutil.copyfile(path, destination)
            os.chmod(destination, 0o600)
    files = []
    for path in sorted(stage.rglob("*")):
        if path.is_file():
            files.append({"path": path.relative_to(stage).as_posix(), "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    return {"sqlite": sqlite_results, "files": files}


def validate_restored(restore: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("schemaVersion") != ARCHIVE_SCHEMA or set(manifest) != {"schemaVersion", "createdAt", "files", "sqlite"}:
        raise ValueError("backup manifest schema mismatch")
    expected = {item["path"]: item for item in manifest["files"]}
    actual = {path.relative_to(restore).as_posix(): path for path in restore.rglob("*") if path.is_file()}
    if set(expected) != set(actual):
        raise ValueError("restored file set differs from manifest")
    for relative, item in expected.items():
        path = actual[relative]
        if path.stat().st_size != item["bytes"] or sha256_file(path) != item["sha256"]:
            raise ValueError("restored file integrity mismatch")
    old_epochs: dict[str, int] = {}
    new_epochs: dict[str, int] = {}
    for relative in sorted(manifest["sqlite"]):
        path = restore / relative
        with sqlite3.connect(path) as database:
            if database.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("restored SQLite integrity_check failed")
            old_epoch = database.execute("SELECT epoch FROM recovery_state WHERE singleton=1").fetchone()[0]
            database.execute("BEGIN IMMEDIATE")
            database.execute("UPDATE recovery_state SET epoch=epoch+1 WHERE singleton=1")
            for table in ("credentials", "sessions", "capabilities", "leases"):
                database.execute(f"DELETE FROM {table}")
            database.execute("UPDATE operations SET status='unknown' WHERE status!='complete'")
            database.commit()
            new_epoch = database.execute("SELECT epoch FROM recovery_state WHERE singleton=1").fetchone()[0]
            remaining = sum(database.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("credentials", "sessions", "capabilities", "leases"))
            unknown = database.execute("SELECT count(*) FROM operations WHERE status='unknown'").fetchone()[0]
        if new_epoch != old_epoch + 1 or remaining != 0 or unknown < 1:
            raise RuntimeError("restore did not revoke prior authority or reconcile operations")
        old_epochs[relative] = old_epoch
        new_epochs[relative] = new_epoch
    for relative in ("config/service.json", "mesh/config.json", "sync/config.json"):
        (restore / relative).write_bytes(canonical({"schema": 1, "credentialState": "rotation-required", "recoveryEpoch": max(new_epochs.values())}))
        os.chmod(restore / relative, 0o600)
    return {"oldEpochs": old_epochs, "newEpochs": new_epochs, "oldAuthorityObjectsRemaining": 0, "pendingOperationsMarkedUnknown": True}


def exercise(key: Path) -> dict[str, Any]:
    validate_key(key)
    started = time.monotonic()
    parent = Path("/dev/shm")
    if not parent.is_dir():
        raise RuntimeError("IO-04a requires a memory-backed isolated workspace")
    with tempfile.TemporaryDirectory(prefix="screen-control-io04a-", dir=parent) as temporary:
        root = Path(temporary)
        os.chmod(root, 0o700)
        source = root / "source"
        fixture = create_fixture(source)
        before = tree_digest(source)
        stage = root / "stage"
        staged = stage_online_backup(source, stage)
        manifest = {
            "schemaVersion": ARCHIVE_SCHEMA,
            "createdAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
            **staged,
        }
        archive = root / "backup.tar.gpg"
        encrypt_stage(stage, manifest, archive, key)
        shutil.rmtree(stage)
        if FIXTURE_SECRET in archive.read_bytes():
            raise RuntimeError("encrypted archive exposed fixture secret")
        restore = root / "isolated-restore"
        private_directory(restore)
        recovered_manifest = decrypt_archive(archive, restore, key)
        recovery = validate_restored(restore, recovered_manifest)
        after = tree_digest(source)
        if before != after:
            raise RuntimeError("source tree changed during backup/restore exercise")
        archive_sha = sha256_file(archive)
        archive_mode = format(stat.S_IMODE(archive.stat().st_mode), "04o")
        result = {
            "schemaVersion": SCHEMA,
            "status": "passed",
            "mode": "synthetic-baseline",
            "categories": ["config", "sqlite", "mesh", "syncclipboard"],
            "encryption": {"format": "OpenPGP", "cipher": "AES256", "archiveMode": archive_mode},
            "archiveSha256": archive_sha,
            "fileCount": len(staged["files"]),
            "sqliteIntegrityChecks": {name: value["integrity"] for name, value in staged["sqlite"].items()},
            "sourceTreeSha256Before": before,
            "sourceTreeSha256After": after,
            "sourceUnchanged": before == after == fixture["sourceTreeSha256"],
            "isolatedRestore": True,
            "recovery": recovery,
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "temporaryPlaintextRemoved": True,
        }
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    init = subparsers.add_parser("init-key")
    init.add_argument("--key-file", type=Path, required=True)
    run = subparsers.add_parser("exercise")
    run.add_argument("--key-file", type=Path, required=True)
    args = parser.parse_args()
    result = init_key(args.key_file) if args.action == "init-key" else exercise(args.key_file)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileExistsError, OSError, RuntimeError, ValueError, sqlite3.Error, subprocess.SubprocessError, tarfile.TarError) as error:
        print(f"backup-restore: {error}", file=os.sys.stderr)
        raise SystemExit(1)
