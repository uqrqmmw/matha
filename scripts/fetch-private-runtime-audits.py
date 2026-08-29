#!/usr/bin/env python3
"""Download hash-addressed Galaxy Tab audit evidence from private Supabase Storage.

This is deliberately read-only.  It uses the already authenticated Supabase CLI,
pins the last CLI version whose single-object download works on Windows, validates
the content hash embedded in every filename, and writes outside the public repo.
It never calls OpenAI or any paid OCR service.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROJECT_REF = "rrihysbxhsbxjteqmtdu"
CLI_VERSION = "2.115.0"
REMOTE_PREFIX = "ss:///matha-content/runtime-audits"
REMOTE_PATH_RE = re.compile(
    r"^/matha-content/runtime-audits/(?P<user>[a-f0-9]{64})/"
    r"(?P<name>matha-paper-runtime-audit-(?P<run>paper-run-\d{10,20})-"
    r"(?P<short>[a-f0-9]{16})\.json)$"
)


class AuditFetchError(RuntimeError):
    pass


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def default_output() -> Path:
    return Path.home() / "Desktop" / "數學檔案" / "matha-private-evals" / "runtime-audits"


def accepted_remote_paths(paths: Iterable[object]) -> list[str]:
    return sorted({str(path) for path in paths if REMOTE_PATH_RE.fullmatch(str(path))})


def validate_runtime_audit(path: Path, remote_path: str) -> dict:
    match = REMOTE_PATH_RE.fullmatch(remote_path)
    if not match:
        raise AuditFetchError(f"不接受的遠端物件路徑：{remote_path}")
    digest = file_sha256(path)
    if not digest.startswith(match.group("short")):
        raise AuditFetchError(f"封存檔 SHA-256 與檔名不符：{path.name}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AuditFetchError(f"封存檔不是有效 JSON：{path.name}") from error
    run = value.get("run") or {}
    summary = value.get("summary") or {}
    if value.get("kind") != "matha-paper-runtime-audit-v1":
        raise AuditFetchError(f"封存檔 kind 不合法：{path.name}")
    if run.get("id") != match.group("run") or summary.get("passed") is not True:
        raise AuditFetchError(f"封存檔 run 或驗收狀態不合法：{path.name}")
    return {"sha256": digest, "runId": match.group("run"), "sourceId": run.get("sourceId")}


def cli_command() -> list[str]:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        raise AuditFetchError("找不到 npx，無法使用既有 Supabase CLI 登入")
    return [npx, "--yes", f"supabase@{CLI_VERSION}"]


def run_cli(arguments: list[str]) -> str:
    result = subprocess.run(
        [*cli_command(), *arguments],
        cwd=REPO_ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout or "Supabase CLI 執行失敗").strip()
        raise AuditFetchError(detail[-1200:])
    return result.stdout


def discover(project_ref: str, runner: Callable[[list[str]], str] = run_cli) -> list[str]:
    raw = runner([
        "storage", "ls", REMOTE_PREFIX,
        "--project-ref", project_ref,
        "--recursive", "--experimental", "--output-format", "json",
    ])
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise AuditFetchError("Supabase CLI 沒有回傳有效的 Storage 清冊") from error
    return accepted_remote_paths(value.get("paths") or [])


def sync_audits(
    remote_paths: list[str],
    output: Path,
    project_ref: str,
    runner: Callable[[list[str]], str] = run_cli,
) -> dict:
    output = output.resolve()
    if output == REPO_ROOT or REPO_ROOT in output.parents:
        raise AuditFetchError("私人真機證據不得下載到公開 Git repository")
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for remote_path in remote_paths:
        match = REMOTE_PATH_RE.fullmatch(remote_path)
        if not match:
            continue
        target_dir = output / match.group("user")
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / match.group("name")
        status = "reused"
        try:
            evidence = validate_runtime_audit(target, remote_path)
        except (AuditFetchError, OSError):
            partial = target.with_suffix(target.suffix + ".partial")
            partial.unlink(missing_ok=True)
            runner([
                "storage", "cp", f"ss://{remote_path}", str(partial),
                "--project-ref", project_ref, "--experimental",
            ])
            try:
                evidence = validate_runtime_audit(partial, remote_path)
            except Exception:
                partial.unlink(missing_ok=True)
                raise
            partial.replace(target)
            status = "downloaded"
        rows.append({
            "remotePath": remote_path,
            "localPath": str(target),
            "status": status,
            **evidence,
        })
    report = {
        "schema": 1,
        "generatedAt": datetime.now(timezone(timedelta(hours=8))).isoformat(),
        "projectRef": project_ref,
        "remotePrefix": REMOTE_PREFIX,
        "found": len(remote_paths),
        "valid": len(rows),
        "items": rows,
    }
    index = output / "runtime-audit-download-index.json"
    temporary = index.with_suffix(".json.partial")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(index)
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-ref", default=DEFAULT_PROJECT_REF)
    parser.add_argument("--output", type=Path, default=default_output())
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args(argv)
    try:
        paths = discover(args.project_ref)
        report = sync_audits(paths, args.output, args.project_ref)
    except AuditFetchError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps({
        "ok": True,
        "found": report["found"],
        "valid": report["valid"],
        "output": str(args.output.resolve()),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
