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
import contextlib
import hashlib
import json
import mimetypes
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[2]
EXPECTED_SUPABASE_URL = "https://rrihysbxhsbxjteqmtdu.supabase.co"
EXPECTED_ALIAS = "manifest-mistral-ocr4-verified-v1.json"
EXPECTED_QUESTIONS = 217
EXPECTED_PACKS = 191
EXPECTED_VERSIONED_OBJECTS = 410
EXPECTED_REVIEW_POLICY = "owner-delegated-agent-direct-pixel-v1"
EXPECTED_CORPUS = {
    "corpusGeneration": "mistral-ocr4-verified-v1",
    "sourceInventorySha256": "c0cedf6b71917211fce887f002978b1180ee661e86f16885e1625c34e5f9fc96",
    "sourceDocuments": 25,
    "sourcePages": 6720,
    "ocrProvider": "mistral",
    "ocrModel": "mistral-ocr-latest",
    "verificationPolicy": "pdf-crop-and-answer-review-v1",
}
SAFE_SHA = re.compile(r"[a-f0-9]{64}")
SAFE_RELEASE = re.compile(r"[a-z0-9][a-z0-9-]{7,63}")
ROLLBACK_CAPABLE_STATES = {
    "prepared", "deployed", "switch-outcome-unknown", "recovery-required",
}
ROLLBACK_RECORD_STATES = {
    "prepared", "rollback-outcome-unknown", "recovery-required", "rolled-back",
}


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


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    """Durably replace a private record without exposing a partial JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=1)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise DeploymentError(f"deployment record must stay outside Git: {resolved}")


def safe_storage_path(value: Any, label: str) -> str:
    if (not isinstance(value, str) or not value or "\\" in value
            or value.startswith("/") or any(part in {"", ".", ".."} for part in value.split("/"))):
        raise DeploymentError(f"unsafe Storage path in {label}")
    return value


@contextlib.contextmanager
def deployment_lock(base_url: str, alias_path: str):
    """Serialize release/rollback mutation on this machine.

    The OS releases the advisory lock if the process dies, so an interrupted
    deployment cannot strand a stale lock file.  This supplements (but cannot
    replace) the alias hash compare immediately before a remote write.
    """
    identity = digest(f"{base_url.rstrip('/')}\n{alias_path}".encode("utf-8"))[:24]
    path = Path(tempfile.gettempdir()) / f"matha-private-release-{identity}.lock"
    handle = path.open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise DeploymentError("another local private release operation is active") from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


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


def transient_http_status(status: int) -> bool:
    """Return whether a Storage response is safe to retry without mutation.

    Supabase's edge can surface Cloudflare/vendor transient gateway codes in
    the 520-599 range (including 544), not only the conventional 5xx codes.
    Downloads are read-only, so retrying those responses is safe.
    """
    return status in {408, 429, 500, 502, 503, 504} or 520 <= status <= 599


def download_object(base_url: str, service_key: str, bucket: str, path: str) -> bytes | None:
    last_error: BaseException | None = None
    for attempt in range(4):
        separator = "&" if "?" in object_url(base_url, bucket, path) else "?"
        url = f"{object_url(base_url, bucket, path)}{separator}_matha_cb={time.time_ns()}"
        request = urllib.request.Request(
            url,
            headers={**headers(service_key), "Cache-Control": "no-cache", "Pragma": "no-cache"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code in {400, 404}:
                return None
            if not transient_http_status(error.code):
                raise DeploymentError(
                    f"Storage download failed for {bucket}/{path}: HTTP {error.code}"
                ) from error
            last_error = error
        except (TimeoutError, urllib.error.URLError) as error:
            last_error = error
        if attempt < 3:
            time.sleep(1 << attempt)
    raise DeploymentError(f"Storage download repeatedly failed for {bucket}/{path}") from last_error


def wait_for_hash(downloader: Callable[[str, str, str, str], bytes | None],
                  base_url: str, service_key: str, bucket: str, path: str,
                  expected: str, *, attempts: int = 5) -> bytes | None:
    """Read through transient Storage cache propagation until exact bytes are visible."""
    for attempt in range(attempts):
        value = downloader(base_url, service_key, bucket, path)
        if value is not None and digest(value) == expected:
            return value
        if attempt < attempts - 1:
            time.sleep(1 << min(attempt, 3))
    return None


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
    release_id = plan.get("releaseId")
    if not isinstance(release_id, str) or SAFE_RELEASE.fullmatch(release_id) is None:
        raise DeploymentError("upload plan releaseId is missing or unsafe")
    alias = safe_storage_path(plan.get("manifestAlias"), "manifest alias")
    if alias != EXPECTED_ALIAS:
        raise DeploymentError("upload plan does not target the formal manifest alias")
    expected_manifest = f"releases/{release_id}/manifest.json"
    if plan.get("versionedManifest") != expected_manifest:
        raise DeploymentError("upload plan versioned manifest path is invalid")
    if plan.get("summary") != {
        "questions": EXPECTED_QUESTIONS,
        "contentFiles": EXPECTED_PACKS + 3,
        "stemAssets": EXPECTED_QUESTIONS,
    }:
        raise DeploymentError("upload plan summary is not the formal 217-question bundle")
    source_value = plan.get("source")
    source_hash = plan.get("sourceSha256")
    approved_by = plan.get("releaseApprovedBy")
    if (not isinstance(source_value, str) or not source_value.strip()
            or not isinstance(source_hash, str) or SAFE_SHA.fullmatch(source_hash) is None
            or not isinstance(approved_by, str) or len(approved_by.strip()) < 3):
        raise DeploymentError("upload plan signed-source binding is incomplete")
    source_path = Path(source_value)
    if not source_path.is_absolute():
        source_path = plan_file.resolve().parent / source_path
    source_path = source_path.resolve()
    if not source_path.is_file() or sha256(source_path) != source_hash:
        raise DeploymentError("upload plan signed source is missing or changed")
    signed_source = load_json(source_path, "signed question source")
    if (signed_source.get("schema") != 3
            or signed_source.get("kind") != "private-question-source"
            or signed_source.get("releaseId") != release_id
            or signed_source.get("releaseApprovedBy") != approved_by
            or signed_source.get("reviewPolicy") != EXPECTED_REVIEW_POLICY
            or any(signed_source.get(key) != value for key, value in EXPECTED_CORPUS.items())
            or not isinstance(signed_source.get("questions"), list)
            or len(signed_source["questions"]) != EXPECTED_QUESTIONS):
        raise DeploymentError("signed question source is not the formal reviewed 217-question source")

    buckets = plan.get("buckets")
    if not isinstance(buckets, dict) or set(buckets) != {"matha-content", "matha-figures"}:
        raise DeploymentError("upload plan must contain only the two formal private buckets")
    all_files: list[dict[str, Any]] = []
    alias_row: dict[str, Any] | None = None
    seen: set[tuple[str, str]] = set()
    content_rows: list[dict[str, Any]] = []
    figure_rows: list[dict[str, Any]] = []
    prefix = f"releases/{release_id}/"
    for bucket in ("matha-content", "matha-figures"):
        payload = buckets.get(bucket)
        root_value = payload.get("root") if isinstance(payload, dict) else None
        rows = payload.get("files") if isinstance(payload, dict) else None
        if not isinstance(root_value, str) or not root_value.strip() or not isinstance(rows, list):
            raise DeploymentError(f"upload plan bucket is invalid: {bucket}")
        root = Path(root_value).resolve()
        if not root.is_dir():
            raise DeploymentError(f"upload plan bucket root is missing: {bucket}")
        for raw in rows:
            if not isinstance(raw, dict):
                raise DeploymentError(f"upload plan row is invalid: {bucket}")
            path = safe_storage_path(raw.get("path"), bucket)
            expected_hash = raw.get("sha256")
            size = raw.get("bytes")
            if (not isinstance(expected_hash, str) or SAFE_SHA.fullmatch(expected_hash) is None
                    or not isinstance(size, int) or isinstance(size, bool) or size < 0):
                raise DeploymentError(f"upload plan row hash/size is invalid: {bucket}/{path}")
            key = (bucket, path)
            if key in seen:
                raise DeploymentError(f"upload plan contains a duplicate object: {bucket}/{path}")
            seen.add(key)
            local = (root / Path(*path.split("/"))).resolve()
            try:
                local.relative_to(root)
            except ValueError as error:
                raise DeploymentError(f"upload path escapes root: {bucket}/{path}") from error
            if (not local.is_file() or sha256(local) != expected_hash
                    or local.stat().st_size != size):
                raise DeploymentError(f"local upload file changed: {bucket}/{path}")
            item = {"bucket": bucket, "path": path, "local": local,
                    "sha256": expected_hash, "bytes": size}
            if "questionId" in raw:
                item["questionId"] = raw.get("questionId")
            if bucket == "matha-content" and path == alias:
                if alias_row is not None:
                    raise DeploymentError("upload plan contains duplicate manifest alias")
                alias_row = item
            else:
                if not path.startswith(prefix):
                    raise DeploymentError(f"upload plan contains a non-versioned object: {bucket}/{path}")
                all_files.append(item)
                (content_rows if bucket == "matha-content" else figure_rows).append(item)
    if alias_row is None:
        raise DeploymentError("upload plan does not contain the manifest alias")
    pending_path = f"{prefix}content/pending-visuals.json"
    content_paths = {row["path"] for row in content_rows}
    pack_rows = [
        row for row in content_rows
        if row["path"].startswith(f"{prefix}content/") and row["path"] != pending_path
    ]
    question_ids = [row.get("questionId") for row in figure_rows]
    if (len(all_files) != EXPECTED_VERSIONED_OBJECTS
            or len(content_rows) != EXPECTED_PACKS + 2
            or len(pack_rows) != EXPECTED_PACKS
            or any(not row["path"].endswith(".json") for row in pack_rows)
            or expected_manifest not in content_paths or pending_path not in content_paths
            or len(figure_rows) != EXPECTED_QUESTIONS
            or any(not row["path"].startswith(f"{prefix}stems/")
                   or not row["path"].endswith(".png")
                   or not isinstance(row.get("questionId"), str)
                   or not row["questionId"] for row in figure_rows)
            or len(set(question_ids)) != EXPECTED_QUESTIONS):
        raise DeploymentError("upload plan is not the exact 191-pack/217-stem/410-object release")
    manifest_row = next(row for row in content_rows if row["path"] == expected_manifest)
    if (alias_row["sha256"], alias_row["bytes"]) != (
            manifest_row["sha256"], manifest_row["bytes"]):
        raise DeploymentError("manifest alias does not equal the versioned manifest")
    return plan, all_files, alias_row


def deploy(plan_file: Path, record_file: Path, base_url: str, service_key: str,
           expected_previous: str,
           downloader: Callable[[str, str, str, str], bytes | None] = download_object,
           uploader: Callable[..., None] = upload_object) -> dict[str, Any]:
    if base_url.rstrip("/") != EXPECTED_SUPABASE_URL:
        raise DeploymentError("Supabase URL does not match the project used by app.js")
    if not isinstance(expected_previous, str) or SAFE_SHA.fullmatch(expected_previous) is None:
        raise DeploymentError("--expected-previous-sha256 is required for a formal deployment")
    record_file = outside_repo(record_file)
    plan, versioned, alias = validate_plan(plan_file)
    with deployment_lock(base_url, alias["path"]):
        if record_file.exists():
            raise DeploymentError("deployment record already exists")
        previous = downloader(base_url, service_key, alias["bucket"], alias["path"])
        if previous is None:
            raise DeploymentError("current manifest alias is missing; rollback cannot be guaranteed")
        previous_hash = digest(previous)
        if previous_hash != expected_previous:
            raise DeploymentError("current manifest alias does not match --expected-previous-sha256")
        uploaded = []
        for row in versioned:
            data = row["local"].read_bytes()
            if digest(data) != row["sha256"] or len(data) != row["bytes"]:
                raise DeploymentError(
                    f"local upload file changed during deployment: {row['bucket']}/{row['path']}"
                )
            existing = downloader(base_url, service_key, row["bucket"], row["path"])
            if existing is None:
                uploader(base_url, service_key, row["bucket"], row["path"], data, upsert=False)
            elif digest(existing) != row["sha256"]:
                raise DeploymentError(f"immutable versioned object already differs: {row['bucket']}/{row['path']}")
            verified = wait_for_hash(
                downloader, base_url, service_key, row["bucket"], row["path"], row["sha256"]
            )
            if verified is None:
                raise DeploymentError(f"uploaded object verification failed: {row['bucket']}/{row['path']}")
            uploaded.append({"bucket": row["bucket"], "path": row["path"],
                             "sha256": row["sha256"], "bytes": row["bytes"]})
        unchanged = downloader(base_url, service_key, alias["bucket"], alias["path"])
        if unchanged is None or digest(unchanged) != previous_hash:
            raise DeploymentError("manifest alias changed during deployment; refusing the switch")
        new_alias = alias["local"].read_bytes()
        if digest(new_alias) != alias["sha256"] or len(new_alias) != alias["bytes"]:
            raise DeploymentError("local manifest alias changed during deployment")
        # Persist the exact rollback bytes before the only mutable operation.  If
        # the process or network dies while the alias request is in flight, this
        # prepared record is already sufficient for rollback recovery.
        record = {
            "kind": "matha-private-storage-deployment", "version": 1,
            "state": "prepared", "preparedAt": datetime.now(timezone.utc).isoformat(),
            "releaseId": plan.get("releaseId"), "deployedAt": None,
            "projectUrl": base_url.rstrip("/"), "uploadPlanSha256": sha256(plan_file),
            "alias": {"bucket": alias["bucket"], "path": alias["path"],
                      "previousSha256": previous_hash, "newSha256": alias["sha256"],
                      "previousBytesBase64": base64.b64encode(previous).decode("ascii")},
            "uploaded": uploaded,
            "rollbackAvailable": True,
        }
        write_json_atomic(record_file, record)
        try:
            uploader(base_url, service_key, alias["bucket"], alias["path"], new_alias, upsert=True)
        except Exception:
            record["state"] = "switch-outcome-unknown"
            record["failedAt"] = datetime.now(timezone.utc).isoformat()
            write_json_atomic(record_file, record)
            raise
        switched = wait_for_hash(
            downloader, base_url, service_key, alias["bucket"], alias["path"], alias["sha256"]
        )
        if switched is None:
            try:
                uploader(base_url, service_key, alias["bucket"], alias["path"], previous, upsert=True)
            except Exception as error:
                record["state"] = "recovery-required"
                record["failedAt"] = datetime.now(timezone.utc).isoformat()
                write_json_atomic(record_file, record)
                raise DeploymentError(
                    "manifest alias verification and prior-alias restoration response both failed"
                ) from error
            restored = wait_for_hash(
                downloader, base_url, service_key, alias["bucket"], alias["path"], previous_hash,
            )
            record["state"] = (
                "restored-after-failed-switch" if restored is not None else "recovery-required"
            )
            record["failedAt"] = datetime.now(timezone.utc).isoformat()
            write_json_atomic(record_file, record)
            raise DeploymentError("manifest alias verification failed; prior alias restoration attempted")
        record["state"] = "deployed"
        record["deployedAt"] = datetime.now(timezone.utc).isoformat()
        write_json_atomic(record_file, record)
        return {"releaseId": plan.get("releaseId"), "objects": len(uploaded),
                "aliasSha256": alias["sha256"], "deploymentRecord": str(record_file)}


def rollback(record_file: Path, output_file: Path, base_url: str, service_key: str,
             downloader: Callable[[str, str, str, str], bytes | None] = download_object,
             uploader: Callable[..., None] = upload_object) -> dict[str, Any]:
    if base_url.rstrip("/") != EXPECTED_SUPABASE_URL:
        raise DeploymentError("Supabase URL does not match the project used by app.js")
    record_file = outside_repo(record_file)
    output_file = outside_repo(output_file)
    record = load_json(record_file, "deployment record")
    alias = record.get("alias") or {}
    if (record.get("kind") != "matha-private-storage-deployment"
            or record.get("version") != 1
            or record.get("rollbackAvailable") is not True
            or record.get("state") not in ROLLBACK_CAPABLE_STATES
            or str(record.get("projectUrl") or "").rstrip("/") != base_url.rstrip("/")
            or not isinstance(record.get("releaseId"), str)
            or SAFE_RELEASE.fullmatch(record["releaseId"]) is None
            or not isinstance(record.get("uploadPlanSha256"), str)
            or SAFE_SHA.fullmatch(record["uploadPlanSha256"]) is None
            or alias.get("bucket") != "matha-content"
            or alias.get("path") != EXPECTED_ALIAS
            or not isinstance(alias.get("previousSha256"), str)
            or SAFE_SHA.fullmatch(alias["previousSha256"]) is None
            or not isinstance(alias.get("newSha256"), str)
            or SAFE_SHA.fullmatch(alias["newSha256"]) is None
            or alias.get("newSha256") == alias.get("previousSha256")):
        raise DeploymentError("deployment record is not rollback-capable")
    if not isinstance(record.get("preparedAt"), str) or not record["preparedAt"]:
        raise DeploymentError("deployment record has no durable prepared timestamp")
    if (record.get("state") == "deployed"
            and (not isinstance(record.get("deployedAt"), str) or not record["deployedAt"])):
        raise DeploymentError("deployed record has no completion timestamp")
    uploaded = record.get("uploaded")
    prefix = f"releases/{record['releaseId']}/"
    if (not isinstance(uploaded, list) or len(uploaded) != EXPECTED_VERSIONED_OBJECTS
            or any(not isinstance(row, dict)
                   or row.get("bucket") not in {"matha-content", "matha-figures"}
                   or not isinstance(row.get("path"), str)
                   or not row["path"].startswith(prefix)
                   or not isinstance(row.get("sha256"), str)
                   or SAFE_SHA.fullmatch(row["sha256"]) is None
                   or not isinstance(row.get("bytes"), int)
                   or isinstance(row.get("bytes"), bool) or row["bytes"] < 0
                   for row in uploaded)
            or len({(row["bucket"], row["path"]) for row in uploaded})
            != EXPECTED_VERSIONED_OBJECTS):
        raise DeploymentError("deployment record does not contain the exact versioned object set")
    content_uploaded = [row for row in uploaded if row["bucket"] == "matha-content"]
    figure_uploaded = [row for row in uploaded if row["bucket"] == "matha-figures"]
    versioned_manifest = f"{prefix}manifest.json"
    pending_path = f"{prefix}content/pending-visuals.json"
    pack_uploaded = [
        row for row in content_uploaded
        if row["path"].startswith(f"{prefix}content/") and row["path"] != pending_path
    ]
    manifest_rows = [row for row in content_uploaded if row["path"] == versioned_manifest]
    if (len(content_uploaded) != EXPECTED_PACKS + 2
            or len(figure_uploaded) != EXPECTED_QUESTIONS
            or len(pack_uploaded) != EXPECTED_PACKS
            or any(not row["path"].endswith(".json") for row in pack_uploaded)
            or not any(row["path"] == pending_path for row in content_uploaded)
            or len(manifest_rows) != 1
            or manifest_rows[0]["sha256"] != alias["newSha256"]
            or any(not row["path"].startswith(f"{prefix}stems/")
                   or not row["path"].endswith(".png") for row in figure_uploaded)):
        raise DeploymentError("deployment record object distribution is not the formal release")
    try:
        previous = base64.b64decode(alias.get("previousBytesBase64"), validate=True)
    except (ValueError, TypeError) as error:
        raise DeploymentError("deployment record prior alias bytes are invalid") from error
    if digest(previous) != alias.get("previousSha256"):
        raise DeploymentError("deployment record prior alias hash is invalid")
    deployment_sha = sha256(record_file)
    expected_binding = {
        "kind": "matha-private-storage-rollback", "version": 1,
        "releaseId": record.get("releaseId"),
        "projectUrl": base_url.rstrip("/"),
        "deploymentRecordSha256": deployment_sha,
        "alias": {
            "bucket": "matha-content", "path": EXPECTED_ALIAS,
            "deployedSha256": alias["newSha256"],
            "restoredSha256": alias["previousSha256"],
        },
        "restoredAliasSha256": alias["previousSha256"],
    }
    with deployment_lock(base_url, EXPECTED_ALIAS):
        if output_file.exists():
            result = load_json(output_file, "rollback record")
            if (result.get("state") not in ROLLBACK_RECORD_STATES
                    or any(result.get(key) != value for key, value in expected_binding.items())
                    or not isinstance(result.get("preparedAt"), str)
                    or not result["preparedAt"]
                    or (result.get("state") == "rolled-back"
                        and (not isinstance(result.get("rolledBackAt"), str)
                             or not result["rolledBackAt"]))):
                raise DeploymentError("existing rollback record is not bound to this deployment")
        else:
            result = {
                **expected_binding,
                "state": "prepared",
                "preparedAt": datetime.now(timezone.utc).isoformat(),
                "rolledBackAt": None,
            }
            write_json_atomic(output_file, result)

        current = downloader(base_url, service_key, alias["bucket"], alias["path"])
        if current is None:
            raise DeploymentError("manifest alias is unavailable; rollback outcome remains recoverable")
        current_hash = digest(current)
        if result.get("state") == "rolled-back":
            if current_hash != alias["previousSha256"]:
                raise DeploymentError("rollback is recorded but the alias has since moved")
            return {**result, "rollbackRecord": str(output_file)}
        already_restored = current_hash == alias["previousSha256"]
        if not already_restored and current_hash != alias["newSha256"]:
            raise DeploymentError("manifest alias belongs to another deployment; refusing rollback")
        if not already_restored:
            try:
                uploader(base_url, service_key, alias["bucket"], alias["path"], previous, upsert=True)
            except Exception:
                result["state"] = "rollback-outcome-unknown"
                result["failedAt"] = datetime.now(timezone.utc).isoformat()
                write_json_atomic(output_file, result)
                raise
        verified = wait_for_hash(
            downloader, base_url, service_key, alias["bucket"], alias["path"],
            alias["previousSha256"],
        )
        if verified is None:
            result["state"] = "recovery-required"
            result["failedAt"] = datetime.now(timezone.utc).isoformat()
            write_json_atomic(output_file, result)
            raise DeploymentError("rollback alias verification failed; retry can recover the record")
        result["state"] = "rolled-back"
        result["rolledBackAt"] = datetime.now(timezone.utc).isoformat()
        result["alreadyRestored"] = already_restored
        result.pop("failedAt", None)
        write_json_atomic(output_file, result)
        return {**result, "rollbackRecord": str(output_file)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    deploy_parser = commands.add_parser("deploy")
    deploy_parser.add_argument("--plan", required=True, type=Path)
    deploy_parser.add_argument("--record", required=True, type=Path)
    deploy_parser.add_argument("--expected-previous-sha256", required=True)
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
