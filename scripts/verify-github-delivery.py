#!/usr/bin/env python3
"""Create repo-external proof that current clean main passed CI and reached Pages.

This verifier uses only Git, GitHub CLI and ordinary HTTPS downloads.  It does
not launch a browser, call an AI API, or mutate the repository/remote.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_REPOSITORY = "uqrqmmw/matha"
EXPECTED_BRANCH = "main"
PAGES_ROOT = "https://uqrqmmw.github.io/matha"
_PUBLIC_REPO_AUDITOR: Any | None = None


class DeliveryVerificationError(RuntimeError):
    pass


def public_repo_auditor() -> Any:
    global _PUBLIC_REPO_AUDITOR
    if _PUBLIC_REPO_AUDITOR is not None:
        return _PUBLIC_REPO_AUDITOR
    path = REPO_ROOT / "scripts" / "audit_public_repo.py"
    spec = importlib.util.spec_from_file_location("matha_public_repo_audit", path)
    if spec is None or spec.loader is None:
        raise DeliveryVerificationError("public repository auditor is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _PUBLIC_REPO_AUDITOR = module
    return module


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256(path: Path) -> str:
    return digest(path.read_bytes())


def run(command: list[str], cwd: Path = REPO_ROOT) -> str:
    completed = subprocess.run(
        command, cwd=cwd, text=True, encoding="utf-8",
        capture_output=True, check=False,
    )
    if completed.returncode:
        raise DeliveryVerificationError(f"command failed: {' '.join(command[:3])}")
    return completed.stdout.strip()


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise DeliveryVerificationError("delivery evidence must stay outside the public repository")


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def app_version(source: bytes) -> str:
    matches = re.findall(rb"\bconst\s+APP_VER\s*=\s*['\"]([^'\"]+)['\"]", source)
    if len(matches) != 1:
        raise DeliveryVerificationError("app.js APP_VER is missing or ambiguous")
    return matches[0].decode("ascii")


def select_run(rows: list[dict[str, Any]], workflow: str, head: str) -> dict[str, Any]:
    matches = [row for row in rows if row.get("workflowName") == workflow
               and row.get("headSha") == head]
    if not matches:
        raise DeliveryVerificationError(f"no {workflow} run is bound to current HEAD")
    matches.sort(key=lambda row: str(row.get("updatedAt") or ""), reverse=True)
    row = matches[0]
    if row.get("status") != "completed" or row.get("conclusion") != "success":
        raise DeliveryVerificationError(f"{workflow} has not completed successfully")
    if not isinstance(row.get("databaseId"), int) or not str(row.get("url") or "").startswith(
            "https://github.com/uqrqmmw/matha/actions/runs/"):
        raise DeliveryVerificationError(f"{workflow} run identity is invalid")
    return {key: row.get(key) for key in (
        "databaseId", "workflowName", "status", "conclusion", "headSha", "url", "updatedAt",
    )}


def default_fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url, headers={"Cache-Control": "no-cache", "User-Agent": "matha-delivery-verifier/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if response.status != 200:
                raise DeliveryVerificationError(f"Pages returned HTTP {response.status}")
            return response.read()
    except OSError as error:
        raise DeliveryVerificationError("Pages asset download failed") from error


def verify(output: Path, *, command_runner: Callable[[list[str]], str] = run,
           fetcher: Callable[[str], bytes] = default_fetch) -> dict[str, Any]:
    output = outside_repo(output)
    if command_runner(["git", "status", "--porcelain"]):
        raise DeliveryVerificationError("working tree is not clean")
    auditor = public_repo_auditor()
    try:
        public_repo_audit = auditor.audit_tracked_tree(REPO_ROOT)
    except (OSError, auditor.PublicRepoAuditError) as error:
        raise DeliveryVerificationError(f"public repository safety audit failed: {error}") from error
    command_runner(["git", "fetch", "--quiet", "origin", EXPECTED_BRANCH])
    branch = command_runner(["git", "branch", "--show-current"])
    head = command_runner(["git", "rev-parse", "HEAD"])
    origin = command_runner(["git", "rev-parse", "origin/main"])
    if branch != EXPECTED_BRANCH or head != origin or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise DeliveryVerificationError("clean local main is not identical to origin/main")
    repo = json.loads(command_runner(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"]))
    if (repo.get("nameWithOwner") != EXPECTED_REPOSITORY
            or (repo.get("defaultBranchRef") or {}).get("name") != EXPECTED_BRANCH):
        raise DeliveryVerificationError("GitHub repository identity is invalid")
    remote_head = command_runner([
        "gh", "api", f"repos/{EXPECTED_REPOSITORY}/git/ref/heads/{EXPECTED_BRANCH}",
        "--jq", ".object.sha",
    ])
    if remote_head != head or not re.fullmatch(r"[0-9a-f]{40}", remote_head):
        raise DeliveryVerificationError("GitHub main has moved away from the verified HEAD")
    rows = json.loads(command_runner([
        "gh", "run", "list", "--commit", head, "--limit", "50", "--json",
        "databaseId,workflowName,status,conclusion,headSha,url,updatedAt",
    ]))
    if not isinstance(rows, list):
        raise DeliveryVerificationError("GitHub Actions response is invalid")
    ci = select_run(rows, "CI", head)
    pages = select_run(rows, "Deploy GitHub Pages", head)

    local_assets = {
        name: (REPO_ROOT / name).read_bytes()
        for name in ("index.html", "app.js", "sw.js", "textbook-catalog.js")
    }
    version = app_version(local_assets["app.js"])
    published: dict[str, dict[str, Any]] = {}
    for name, local in local_assets.items():
        remote = fetcher(f"{PAGES_ROOT}/{name}?delivery={head}")
        if remote != local:
            raise DeliveryVerificationError(f"published {name} is not byte-identical to current HEAD")
        published[name] = {"sha256": digest(remote), "bytes": len(remote)}
    result = {
        "kind": "matha-github-delivery-verification", "version": 1,
        "status": "verified", "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "repository": EXPECTED_REPOSITORY, "branch": EXPECTED_BRANCH,
        "headSha": head, "originMainSha": origin, "remoteMainSha": remote_head,
        "workingTreeClean": True,
        "publicRepoAudit": public_repo_audit,
        "appVersion": version, "appJsSha256": sha256(REPO_ROOT / "app.js"),
        "pagesRoot": PAGES_ROOT, "actions": {"ci": ci, "pages": pages},
        "published": published,
    }
    result["deliveryBindingSha256"] = digest(json.dumps(
        {key: result[key] for key in (
            "repository", "branch", "headSha", "originMainSha", "remoteMainSha", "appVersion",
            "appJsSha256", "pagesRoot", "publicRepoAudit", "actions", "published",
        )}, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8"))
    write_json_atomic(output, result)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = verify(args.output)
    except (DeliveryVerificationError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"verify-github-delivery: {error}", file=sys.stderr)
        return 2
    print(json.dumps({
        "status": result["status"], "headSha": result["headSha"],
        "appVersion": result["appVersion"], "record": str(args.output.resolve()),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
