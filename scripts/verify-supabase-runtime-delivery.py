#!/usr/bin/env python3
"""Create repo-external proof of the deployed DB and Edge runtime.

This verifier uses only the Supabase CLI and two unauthenticated contract
probes.  It never launches a browser, reads an OpenAI key, or invokes a model.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
PROJECT_REF = "rrihysbxhsbxjteqmtdu"
FUNCTION = "openai-proxy"
EXPECTED_MIGRATIONS = [f"2026083000{number:02d}" for number in range(1, 12)]


class VerificationError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_json(command: list[str]) -> object:
    completed = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=180, check=False,
    )
    if completed.returncode != 0:
        raise VerificationError((completed.stderr or "command failed").strip())
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise VerificationError("Supabase CLI returned invalid JSON") from error


def current_app_version() -> str:
    source = (ROOT / "app.js").read_text(encoding="utf-8")
    match = re.search(r"const APP_VER\s*=\s*['\"]([^'\"]+)['\"]", source)
    if not match:
        raise VerificationError("app.js has no APP_VER")
    return match.group(1)


def unauthenticated_contract_probe(project_ref: str, opener=urlopen) -> dict[str, int]:
    endpoint = f"https://{project_ref}.supabase.co/functions/v1/{FUNCTION}"
    options = Request(endpoint, method="OPTIONS")
    with opener(options, timeout=30) as response:
        options_status = int(response.status)
    post = Request(endpoint, data=b"{}", method="POST",
                   headers={"Content-Type": "application/json"})
    try:
        with opener(post, timeout=30) as response:
            post_status = int(response.status)
    except HTTPError as error:
        post_status = int(error.code)
    if options_status != 204 or post_status != 401:
        raise VerificationError(
            f"Edge unauthenticated contract mismatch: OPTIONS={options_status}, POST={post_status}"
        )
    return {"optionsStatus": options_status, "unauthenticatedPostStatus": post_status}


def verify(npx: str, project_ref: str) -> dict[str, object]:
    migration_payload = run_json([
        npx, "supabase", "migration", "list", "--linked",
    ])
    rows = migration_payload.get("migrations") if isinstance(migration_payload, dict) else None
    if not isinstance(rows, list):
        raise VerificationError("migration list is invalid")
    local = [str(row.get("local") or "") for row in rows if isinstance(row, dict)]
    remote = [str(row.get("remote") or "") for row in rows if isinstance(row, dict)]
    if local != EXPECTED_MIGRATIONS or remote != EXPECTED_MIGRATIONS:
        raise VerificationError("local and remote migration 001-011 sets are not identical")

    functions_payload = run_json([
        npx, "supabase", "functions", "list", "--project-ref", project_ref,
    ])
    functions = functions_payload.get("functions") \
        if isinstance(functions_payload, dict) else None
    candidates = [row for row in functions or []
                  if isinstance(row, dict) and row.get("slug") == FUNCTION]
    if len(candidates) != 1 or candidates[0].get("status") != "ACTIVE":
        raise VerificationError("openai-proxy is missing, ambiguous, or inactive")
    remote_function = candidates[0]

    with tempfile.TemporaryDirectory(prefix="matha-edge-runtime-") as temporary:
        work = Path(temporary)
        completed = subprocess.run([
            npx, "supabase", "functions", "download", FUNCTION,
            "--project-ref", project_ref, "--use-api", "--workdir", str(work),
        ], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=180, check=False)
        if completed.returncode != 0:
            raise VerificationError((completed.stderr or "function download failed").strip())
        remote_root = work / "supabase" / "functions" / FUNCTION
        local_root = ROOT / "supabase" / "functions" / FUNCTION
        local_files = {
            path.name: path for path in local_root.glob("*.ts") if not path.name.endswith(".test.ts")
        }
        remote_files = {path.name: path for path in remote_root.glob("*.ts")}
        if set(local_files) != set(remote_files):
            raise VerificationError("remote Edge production file set differs from local")
        source = []
        for name in sorted(local_files):
            local_sha = sha256(local_files[name])
            remote_sha = sha256(remote_files[name])
            if local_sha != remote_sha:
                raise VerificationError(f"remote Edge source drift: {name}")
            source.append({"file": name, "sha256": local_sha,
                           "bytes": local_files[name].stat().st_size})

    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", check=True,
    ).stdout.strip()
    return {
        "kind": "matha-supabase-runtime-delivery-v1",
        "version": 1,
        "status": "verified",
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "projectRef": project_ref,
        "headSha": head,
        "appVersion": current_app_version(),
        "appJsSha256": sha256(ROOT / "app.js"),
        "migrations": EXPECTED_MIGRATIONS,
        "edge": {
            "slug": FUNCTION,
            "version": int(remote_function.get("version") or 0),
            "status": remote_function.get("status"),
            "verifyJwt": remote_function.get("verify_jwt"),
            "sourceFiles": source,
        },
        "contractProbe": unauthenticated_contract_probe(project_ref),
        "browserUsed": False,
        "openAiApiCalled": False,
        "credentialsSerialized": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--project-ref", default=PROJECT_REF)
    parser.add_argument("--npx", default=shutil.which("npx") or "npx")
    args = parser.parse_args()
    report = verify(args.npx, args.project_ref)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    print(json.dumps({
        "output": str(args.output.resolve()), "migrations": len(report["migrations"]),
        "edgeVersion": report["edge"]["version"],
        "sourceFiles": len(report["edge"]["sourceFiles"]),
        "options": report["contractProbe"]["optionsStatus"],
        "unauthenticatedPost": report["contractProbe"]["unauthenticatedPostStatus"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
