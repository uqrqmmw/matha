#!/usr/bin/env python3
"""Deploy or roll back a hash-bound private Storage release.

All versioned objects are uploaded and downloaded for SHA-256 verification
before the fixed manifest alias is replaced.  The prior alias bytes are saved
in a private deployment record.  Rollback refuses to touch the alias if a
newer deployment has replaced it.  No versioned object is deleted.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[2]


class DeploymentError(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256(path: Path) -> str:
    return digest(path.read_bytes())


def load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise DeploymentError(f"{label} does not exist: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DeploymentError(f"{label} must be a JSON object")
    return value


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise DeploymentError(f"deployment record must stay outside Git: {resolved}")


def object_url(base_url: str, bucket: str, path: str) -> str:
    if (not bucket or "/" in bucket or not path or path.startswith(("/", "\\"))
            or ".." in Path(path).parts):
        raise DeploymentError("unsafe Storage bucket or object path")
    quoted = "/".join(urllib.parse.quote(part, safe="._-") for part in path.split("/"))
    return f"{base_url.rstrip('/')}/storage/v1/object/{bucket}/{quoted}"


def headers(service_key: str) -> dict[str, str]:
    if len(service_key.strip()) < 20:
        raise DeploymentError("SUPABASE_SERVICE_ROLE_KEY is missing or invalid")
    return {"Authorization": f"Bearer {service_key}", "apikey": service_key}


def download_object(base_url: str, service_key: str, bucket: str, path: str) -> bytes | None:
    request = urllib.request.Request(object_url(base_url, bucket, path), headers=headers(service_key))
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code in {400, 404}:
            return None
        raise DeploymentError(f"Storage download failed for {bucket}/{path}: HTTP {error.code}") from error


def upload_object(base_url: str, service_key: str, bucket: str, path: str,
                  data: bytes, *, upsert: bool) -> None:
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    request_headers = {
        **headers(service_key), "Content-Type": mime,
        "x-upsert": "true" if upsert else "false",
        "Cache-Control": "no-cache" if path.endswith(".json") else "public, max-age=31536000, immutable",
    }
    request = urllib.request.Request(
        object_url(base_url, bucket, path), data=data, headers=request_headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            response.read()
    except urllib.error.HTTPError as error:
        detail = error.read(500).decode("utf-8", "replace")
        raise DeploymentError(
            f"Storage upload failed for {bucket}/{path}: HTTP {error.code} {detail}"
        ) from error


def validate_plan(plan_file: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    plan = load_json(plan_file, "upload plan")
    if (plan.get("kind") != "matha-private-storage-upload-plan"
            or plan.get("version") != 1 or plan.get("releaseReady") is not True
            or plan.get("uploadPerformed") is not False):
        raise DeploymentError("upload plan is not an unsigned ready release")
    alias = plan.get("manifestAlias")
    content = (plan.get("buckets") or {}).get("matha-content")
    if not isinstance(alias, str) or not isinstance(content, dict):
        raise DeploymentError("upload plan manifest alias is missing")
    all_files = []
    alias_row = None
    for bucket, payload in (plan.get("buckets") or {}).items():
        root = Path(str(payload.get("root") or "")) if isinstance(payload, dict) else Path()
        rows = payload.get("files") if isinstance(payload, dict) else None
        if not root.is_dir() or not isinstance(rows, list):
            raise DeploymentError(f"upload plan bucket is invalid: {bucket}")
        for row in rows:
            path = row.get("path") if isinstance(row, dict) else None
            local = (root / str(path)).resolve()
            try:
                local.relative_to(root.resolve())
            except ValueError as error:
                raise DeploymentError(f"upload path escapes root: {bucket}/{path}") from error
            if (not local.is_file() or sha256(local) != row.get("sha256")
                    or local.stat().st_size != row.get("bytes")):
                raise DeploymentError(f"local upload file changed: {bucket}/{path}")
            item = {"bucket": bucket, "path": path, "local": local,
                    "sha256": row["sha256"], "bytes": row["bytes"]}
            if bucket == "matha-content" and path == alias:
                if alias_row is not None:
                    raise DeploymentError("upload plan contains duplicate manifest alias")
                alias_row = item
            else:
                all_files.append(item)
    if alias_row is None:
        raise DeploymentError("upload plan does not contain the manifest alias")
    return plan, all_files, alias_row


def deploy(plan_file: Path, record_file: Path, base_url: str, service_key: str,
           expected_previous: str | None = None,
           downloader: Callable[[str, str, str, str], bytes | None] = download_object,
           uploader: Callable[..., None] = upload_object) -> dict[str, Any]:
    record_file = outside_repo(record_file)
    if record_file.exists():
        raise DeploymentError("deployment record already exists")
    plan, versioned, alias = validate_plan(plan_file)
    previous = downloader(base_url, service_key, alias["bucket"], alias["path"])
    if previous is None:
        raise DeploymentError("current manifest alias is missing; rollback cannot be guaranteed")
    previous_hash = digest(previous)
    if expected_previous and previous_hash != expected_previous:
        raise DeploymentError("current manifest alias does not match --expected-previous-sha256")
    uploaded = []
    for row in versioned:
        data = row["local"].read_bytes()
        existing = downloader(base_url, service_key, row["bucket"], row["path"])
        if existing is None:
            uploader(base_url, service_key, row["bucket"], row["path"], data, upsert=False)
        elif digest(existing) != row["sha256"]:
            raise DeploymentError(f"immutable versioned object already differs: {row['bucket']}/{row['path']}")
        verified = downloader(base_url, service_key, row["bucket"], row["path"])
        if verified is None or digest(verified) != row["sha256"]:
            raise DeploymentError(f"uploaded object verification failed: {row['bucket']}/{row['path']}")
        uploaded.append({"bucket": row["bucket"], "path": row["path"],
                         "sha256": row["sha256"], "bytes": row["bytes"]})
    unchanged = downloader(base_url, service_key, alias["bucket"], alias["path"])
    if unchanged is None or digest(unchanged) != previous_hash:
        raise DeploymentError("manifest alias changed during deployment; refusing the switch")
    new_alias = alias["local"].read_bytes()
    uploader(base_url, service_key, alias["bucket"], alias["path"], new_alias, upsert=True)
    switched = downloader(base_url, service_key, alias["bucket"], alias["path"])
    if switched is None or digest(switched) != alias["sha256"]:
        try:
            uploader(base_url, service_key, alias["bucket"], alias["path"], previous, upsert=True)
        finally:
            raise DeploymentError("manifest alias verification failed; prior alias restoration attempted")
    record = {
        "kind": "matha-private-storage-deployment", "version": 1,
        "releaseId": plan.get("releaseId"), "deployedAt": datetime.now(timezone.utc).isoformat(),
        "projectUrl": base_url.rstrip("/"), "uploadPlanSha256": sha256(plan_file),
        "alias": {"bucket": alias["bucket"], "path": alias["path"],
                  "previousSha256": previous_hash, "newSha256": alias["sha256"],
                  "previousBytesBase64": base64.b64encode(previous).decode("ascii")},
        "uploaded": uploaded,
        "rollbackAvailable": True,
    }
    record_file.parent.mkdir(parents=True, exist_ok=True)
    record_file.write_text(json.dumps(record, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"releaseId": plan.get("releaseId"), "objects": len(uploaded),
            "aliasSha256": alias["sha256"], "deploymentRecord": str(record_file)}


def rollback(record_file: Path, output_file: Path, base_url: str, service_key: str,
             downloader: Callable[[str, str, str, str], bytes | None] = download_object,
             uploader: Callable[..., None] = upload_object) -> dict[str, Any]:
    output_file = outside_repo(output_file)
    if output_file.exists():
        raise DeploymentError("rollback record already exists")
    record = load_json(record_file, "deployment record")
    alias = record.get("alias") or {}
    if (record.get("kind") != "matha-private-storage-deployment"
            or record.get("rollbackAvailable") is not True):
        raise DeploymentError("deployment record is not rollback-capable")
    current = downloader(base_url, service_key, alias.get("bucket"), alias.get("path"))
    if current is None or digest(current) != alias.get("newSha256"):
        raise DeploymentError("manifest alias no longer matches this deployment; refusing rollback")
    try:
        previous = base64.b64decode(alias.get("previousBytesBase64"), validate=True)
    except (ValueError, TypeError) as error:
        raise DeploymentError("deployment record prior alias bytes are invalid") from error
    if digest(previous) != alias.get("previousSha256"):
        raise DeploymentError("deployment record prior alias hash is invalid")
    uploader(base_url, service_key, alias["bucket"], alias["path"], previous, upsert=True)
    verified = downloader(base_url, service_key, alias["bucket"], alias["path"])
    if verified is None or digest(verified) != alias["previousSha256"]:
        raise DeploymentError("rollback alias verification failed")
    result = {
        "kind": "matha-private-storage-rollback", "version": 1,
        "releaseId": record.get("releaseId"), "rolledBackAt": datetime.now(timezone.utc).isoformat(),
        "deploymentRecordSha256": sha256(record_file),
        "restoredAliasSha256": alias["previousSha256"],
    }
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {**result, "rollbackRecord": str(output_file)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    deploy_parser = commands.add_parser("deploy")
    deploy_parser.add_argument("--plan", required=True, type=Path)
    deploy_parser.add_argument("--record", required=True, type=Path)
    deploy_parser.add_argument("--expected-previous-sha256")
    rollback_parser = commands.add_parser("rollback")
    rollback_parser.add_argument("--deployment-record", required=True, type=Path)
    rollback_parser.add_argument("--record", required=True, type=Path)
    for child in (deploy_parser, rollback_parser):
        child.add_argument("--supabase-url", default=os.environ.get("SUPABASE_URL", ""))
    args = parser.parse_args(argv)
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not args.supabase_url:
        print("deploy-private-release: SUPABASE_URL is missing", file=sys.stderr)
        return 2
    try:
        result = (
            deploy(args.plan, args.record, args.supabase_url, service_key,
                   args.expected_previous_sha256)
            if args.command == "deploy"
            else rollback(args.deployment_record, args.record, args.supabase_url, service_key)
        )
    except (DeploymentError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"deploy-private-release: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
