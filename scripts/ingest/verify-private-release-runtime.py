#!/usr/bin/env python3
"""Fail-closed online readback verification for the private starter release.

This command only performs authenticated Supabase Storage reads.  It does not
open a browser, call an AI service, or make any paid OCR/cleanup request.  The
fixed manifest alias and every immutable object in the signed upload plan are
downloaded again and checked before a private, atomic verification record is
written outside the repository.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECORD_NAME = "private-release-runtime-verification.json"
EXPECTED_ALIAS = "manifest-mistral-ocr4-verified-v1.json"
# Compatibility fixtures for the historical 217-question release.  Runtime
# validation no longer uses these counts; every deployed release is bound to
# its signed source and upload-plan summary instead.
EXPECTED_QUESTIONS = 217
EXPECTED_PACKS = 191
EXPECTED_VERSIONED_OBJECTS = 410
EXPECTED_TOPICS = {
    "comb", "data", "exp", "line", "mat", "num", "poly", "prob",
    "seq", "splane", "svec", "trig1", "trig2", "vec",
}
EXPECTED_ROLE_NAMES = {
    "example", "chapter-end-easy", "chapter-end-medium", "chapter-end-hard",
}
EXPECTED_ROLES = {
    "example": 114,
    "chapter-end-easy": 56,
    "chapter-end-medium": 34,
    "chapter-end-hard": 13,
}
EXPECTED_SUPABASE_URL = "https://rrihysbxhsbxjteqmtdu.supabase.co"
EXPECTED_CORPUS = {
    "corpusGeneration": "mistral-ocr4-verified-v1",
    "sourceInventorySha256": "c0cedf6b71917211fce887f002978b1180ee661e86f16885e1625c34e5f9fc96",
    "sourceDocuments": 25,
    "sourcePages": 6720,
    "ocrProvider": "mistral",
    "ocrModel": "mistral-ocr-latest",
    "verificationPolicy": "pdf-crop-and-answer-review-v1",
}
EXPECTED_REVIEW_POLICY = "owner-delegated-agent-direct-pixel-v1"
EXPECTED_RELEASE_CHECKS = {
    "corpusGeneration", "sourceInventory", "sourceDocuments", "sourcePages",
    "ocrProvider", "ocrModel", "verificationPolicy", "originalPdfVerified",
    "answerKeyVerified", "mathematicalCorrectnessVerified",
    "questionProvenance", "originalStemAssets", "noPendingVisuals",
    "reviewAudit", "releaseAuthorization",
}
EXPECTED_ANSWER_SOURCES = {"answer-key", "inline", "next-page-solution"}
PIXEL_REVIEW_CHECKS = {
    "printedContentIntact", "allHandwritingRemoved", "noAnswerOrSolutionLeak",
    "fullQuestionAndOptions", "figuresAndGreyLinesIntact", "chineseTextIntact",
    "mathSymbolsAndFormulasIntact",
}
ANSWER_REVIEW_CHECKS = {
    "questionAnswerIdentityVerified", "allSubpartsCovered", "answerLegible",
    "noAdjacentAnswerConfusion", "figureConditionsHandled", "mathematicallyCorrect",
    "printedOfficialAnswerPresent",
}
DIRECT_REVIEW_FIELDS = {
    "kind", "version", "reviewPolicy", "releaseAuthority", "reviewedBy",
    "reviewedAt", "delegation", "exactInputs", "passAttestation", "questions",
}
DUAL_REVIEW_FIELDS = {
    "kind", "version", "releaseAuthority", "reviewPolicy", "humanReviewClaimed",
    "ownerDelegation", "directReviewSha256", "reviewedBy", "reviewedAt",
    "pixelReviewer", "pixelReviewedAt", "answerReviewer", "answerReviewedAt",
    "ownerReleaseAuthorizationRecorded", "privateAssetDeploymentStillRequired",
    "uploadPerformed", "candidateManifestSha256", "pixelReviewTemplateSha256",
    "answerBindingSha256", "answerReviewTemplateSha256", "counts", "quarantine",
    "items", "nextGate",
}
DUAL_ITEM_FIELDS = {
    "id", "bookId", "chapter", "role", "questionType", "pdfPage", "stemRegion",
    "cropDpi", "cleaned", "cleanedSha256", "answerPath", "answerPdfPage",
    "answerRegion", "answerSource", "answerSha256", "sourcePdfSha256",
    "figureCount", "figureSha256", "structuredAnswer",
}
ANSWER_BINDING_ITEM_FIELDS = {
    "id", "bookId", "chapter", "role", "questionType", "pdfPage",
    "answerPdfPage", "answerRegion", "answerSource", "sourcePdfSha256",
    "sourceSha256", "cleanedSha256", "answerSha256", "figureCount",
    "figureSha256",
}
ANSWER_BINDING_FIELDS = {
    "kind", "version", "releaseAuthority", "total", "reviewableCount",
    "quarantinedCount", "candidateManifestSha256", "catalogSha256",
    "handwritingPixelReviewAlsoRequired", "humanAnswerReviewRequired",
    "quarantined", "items",
}
SOURCE_QUESTION_FIELDS = {
    "id", "topic", "type", "diff", "q", "opts", "ans", "sol", "src",
    "bookId", "bookTitle", "page", "role", "displayTruth",
    "needsStemAsset", "stemAsset", "answerVerification",
}
NON_HUMAN_RE = re.compile(
    r"(?:claude|codex|chatgpt|gpt|gemini|agent|bot|automation|"
    r"\u81ea\u52d5|\u6a21\u578b|\u4eba\u5de5\u667a\u6167|\bai\b)", re.I,
)
APP_VERSION_PATTERN = re.compile(
    rb"\bconst\s+APP_VER\s*=\s*(['\"])([0-9]{4}[a-z])\1\s*;"
)


class RuntimeVerificationError(RuntimeError):
    """The deployed private release cannot be proven safe."""


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256(path: Path) -> str:
    return digest(path.read_bytes())


def load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise RuntimeVerificationError(f"{label} does not exist: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeVerificationError(f"{label} is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise RuntimeVerificationError(f"{label} must be a JSON object")
    return value


def parse_json_bytes(data: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeVerificationError(f"{label} is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise RuntimeVerificationError(f"{label} must be a JSON object")
    return value


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")


def pretty_json_bytes(value: dict[str, Any]) -> bytes:
    return (json.dumps(
        value, ensure_ascii=False, indent=1, sort_keys=True,
    ) + "\n").encode("utf-8")


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=1, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json_exclusive(path: Path, value: dict[str, Any]) -> str:
    """Create immutable evidence without replacing any existing file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{time.time_ns()}")
    data = pretty_json_bytes(value)
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError as error:
            raise RuntimeVerificationError(
                f"immutable verification record already exists: {path}"
            ) from error
    finally:
        temporary.unlink(missing_ok=True)
    return digest(data)


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise RuntimeVerificationError(f"verification output must stay outside Git: {resolved}")


def parse_aware_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeVerificationError(f"{label} timestamp is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeVerificationError(f"{label} timestamp is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeVerificationError(f"{label} timestamp must include a timezone")
    return parsed


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require_nonempty_text(value: Any, label: str, *, maximum: int = 10000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise RuntimeVerificationError(f"{label} is missing or invalid")
    return value.strip()


def safe_object_path(path: Any, label: str) -> str:
    if not isinstance(path, str) or not path or "\\" in path or path.startswith("/"):
        raise RuntimeVerificationError(f"unsafe {label} object path")
    parts = PurePosixPath(path).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise RuntimeVerificationError(f"unsafe {label} object path")
    return path


def object_url(base_url: str, bucket: str, path: str) -> str:
    if not isinstance(bucket, str) or not bucket or "/" in bucket or "\\" in bucket:
        raise RuntimeVerificationError("unsafe Storage bucket")
    safe_object_path(path, "Storage")
    quoted = "/".join(urllib.parse.quote(part, safe="._-") for part in path.split("/"))
    return f"{base_url.rstrip('/')}/storage/v1/object/{bucket}/{quoted}"


def service_headers(service_key: str) -> dict[str, str]:
    if not isinstance(service_key, str) or len(service_key.strip()) < 20:
        raise RuntimeVerificationError("SUPABASE_SERVICE_ROLE_KEY is missing or invalid")
    return {"Authorization": f"Bearer {service_key}", "apikey": service_key}


def transient_http_status(status: int) -> bool:
    return status in {408, 429, 500, 502, 503, 504} or 520 <= status <= 599


def download_object(base_url: str, service_key: str, bucket: str, path: str) -> bytes | None:
    """Download one private object without ever placing the credential in output."""
    last_error: BaseException | None = None
    for attempt in range(4):
        url = f"{object_url(base_url, bucket, path)}?_matha_readback={time.time_ns()}"
        request = urllib.request.Request(
            url,
            headers={
                **service_headers(service_key),
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code in {400, 404}:
                return None
            if not transient_http_status(error.code):
                raise RuntimeVerificationError(
                    f"Storage read failed for {bucket}/{path}: HTTP {error.code}"
                ) from error
            last_error = error
        except (TimeoutError, urllib.error.URLError) as error:
            last_error = error
        if attempt < 3:
            time.sleep(1 << attempt)
    raise RuntimeVerificationError(
        f"Storage read repeatedly failed for {bucket}/{path}"
    ) from last_error


def _require_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise RuntimeVerificationError(f"{label} SHA-256 is missing or invalid")
    return value


def _plan_rows(plan: dict[str, Any]) -> tuple[str, str, list[dict[str, Any]], dict[str, Any]]:
    if (
        plan.get("kind") != "matha-private-storage-upload-plan"
        or plan.get("version") != 1
        or plan.get("releaseReady") is not True
        or plan.get("uploadPerformed") is not False
    ):
        raise RuntimeVerificationError("upload plan is not a ready private release")
    release_id = plan.get("releaseId")
    if not isinstance(release_id, str) or re.fullmatch(r"[a-z0-9][a-z0-9-]{7,63}", release_id) is None:
        raise RuntimeVerificationError("upload plan releaseId is missing or unsafe")
    alias_path = safe_object_path(plan.get("manifestAlias"), "alias")
    if alias_path != EXPECTED_ALIAS:
        raise RuntimeVerificationError("upload plan does not target the formal private alias")
    expected_manifest = safe_object_path(
        plan.get("versionedManifest"), "versioned manifest",
    )
    legacy_manifest = f"releases/{release_id}/manifest.json"
    addressed_manifest = re.fullmatch(
        rf"releases/{re.escape(release_id)}/manifests/manifest-([a-f0-9]{{16}})\.json",
        expected_manifest,
    )
    if expected_manifest != legacy_manifest and addressed_manifest is None:
        raise RuntimeVerificationError("upload plan versioned manifest path is invalid")
    summary = plan.get("summary")
    question_count = summary.get("questions") if isinstance(summary, dict) else None
    content_file_count = summary.get("contentFiles") if isinstance(summary, dict) else None
    stem_asset_count = summary.get("stemAssets") if isinstance(summary, dict) else None
    if (not _is_int(question_count) or question_count < 1
            or not _is_int(content_file_count) or content_file_count < 4
            or stem_asset_count != question_count):
        raise RuntimeVerificationError("upload plan summary is inconsistent")
    pack_count = content_file_count - 3
    versioned_object_count = (content_file_count - 1) + question_count
    _require_sha(plan.get("sourceSha256"), "upload plan signed source")
    _require_nonempty_text(plan.get("source"), "upload plan signed source path")
    _require_nonempty_text(plan.get("releaseApprovedBy"), "upload plan release approver")
    versioned_prefix = f"releases/{release_id}/"
    buckets = plan.get("buckets")
    if not isinstance(buckets, dict) or set(buckets) != {"matha-content", "matha-figures"}:
        raise RuntimeVerificationError("upload plan must contain only the two private buckets")

    rows: list[dict[str, Any]] = []
    alias_row: dict[str, Any] | None = None
    seen: set[tuple[str, str]] = set()
    for bucket in ("matha-content", "matha-figures"):
        payload = buckets.get(bucket)
        files = payload.get("files") if isinstance(payload, dict) else None
        if not isinstance(files, list):
            raise RuntimeVerificationError(f"upload plan bucket is invalid: {bucket}")
        for raw in files:
            if not isinstance(raw, dict):
                raise RuntimeVerificationError(f"upload plan row is invalid: {bucket}")
            path = safe_object_path(raw.get("path"), bucket)
            key = (bucket, path)
            if key in seen:
                raise RuntimeVerificationError(f"duplicate upload object: {bucket}/{path}")
            seen.add(key)
            expected_sha = _require_sha(raw.get("sha256"), f"{bucket}/{path}")
            size = raw.get("bytes")
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                raise RuntimeVerificationError(f"invalid byte count: {bucket}/{path}")
            row = {
                "bucket": bucket,
                "path": path,
                "sha256": expected_sha,
                "bytes": size,
            }
            if "questionId" in raw:
                question_id = raw.get("questionId")
                if not isinstance(question_id, str) or not question_id:
                    raise RuntimeVerificationError(
                        f"invalid questionId binding: {bucket}/{path}"
                    )
                row["questionId"] = question_id
            if bucket == "matha-content" and path == alias_path:
                if alias_row is not None:
                    raise RuntimeVerificationError("duplicate manifest alias in upload plan")
                alias_row = row
            else:
                if not path.startswith(versioned_prefix):
                    raise RuntimeVerificationError(
                        f"non-versioned release object: {bucket}/{path}"
                    )
                rows.append(row)
    if alias_row is None:
        raise RuntimeVerificationError("manifest alias is missing from upload plan")
    if len(rows) != versioned_object_count:
        raise RuntimeVerificationError("upload plan versioned object count is invalid")
    content_paths = {
        row["path"] for row in rows if row["bucket"] == "matha-content"
    }
    figure_rows = [row for row in rows if row["bucket"] == "matha-figures"]
    pending_rows = [
        row for row in rows
        if row["bucket"] == "matha-content" and re.fullmatch(
            rf"releases/{re.escape(release_id)}/content/pending-visuals(?:-([a-f0-9]{{16}}))?\.json",
            row["path"],
        )
    ]
    pack_paths = {
        path for path in content_paths
        if path.startswith(f"releases/{release_id}/content/")
        and not any(row["path"] == path for row in pending_rows)
    }
    if (
        len(content_paths) != content_file_count - 1
        or expected_manifest not in content_paths
        or len(pending_rows) != 1
        or len(pack_paths) != pack_count
        or any(not path.endswith(".json") for path in pack_paths)
        or len(figure_rows) != question_count
        or any(not row["path"].startswith(f"releases/{release_id}/stems/")
               or not row["path"].endswith(".png")
               or "questionId" not in row for row in figure_rows)
        or len({row["questionId"] for row in figure_rows}) != question_count
    ):
        raise RuntimeVerificationError("upload plan versioned object counts are invalid")
    pending_match = re.fullmatch(
        rf"releases/{re.escape(release_id)}/content/pending-visuals(?:-([a-f0-9]{{16}}))?\.json",
        pending_rows[0]["path"],
    )
    if pending_match and pending_match.group(1) is not None \
            and pending_match.group(1) != pending_rows[0]["sha256"][:16]:
        raise RuntimeVerificationError(
            "content-addressed pending queue path does not match its bytes"
        )
    manifest_row = next(
        row for row in rows
        if row["bucket"] == "matha-content" and row["path"] == expected_manifest
    )
    if (alias_row["sha256"], alias_row["bytes"]) != (
        manifest_row["sha256"], manifest_row["bytes"],
    ):
        raise RuntimeVerificationError(
            "upload plan alias does not equal the versioned manifest"
        )
    if addressed_manifest is not None and addressed_manifest.group(1) != alias_row["sha256"][:16]:
        raise RuntimeVerificationError(
            "content-addressed manifest path does not match its bytes"
        )
    return release_id, alias_path, rows, alias_row


def _validate_deployment(
    record: dict[str, Any], plan_file: Path, release_id: str, base_url: str,
    versioned: list[dict[str, Any]], alias_row: dict[str, Any],
) -> None:
    if (
        record.get("kind") != "matha-private-storage-deployment"
        or record.get("version") != 1
        or record.get("state") != "deployed"
        or record.get("rollbackAvailable") is not True
        or not isinstance(record.get("deployedAt"), str)
        or not record.get("deployedAt")
    ):
        raise RuntimeVerificationError("deployment record is not a successful deployment")
    parse_aware_timestamp(record.get("deployedAt"), "deployment")
    if record.get("releaseId") != release_id:
        raise RuntimeVerificationError("deployment releaseId does not match the upload plan")
    if str(record.get("projectUrl") or "").rstrip("/") != base_url.rstrip("/"):
        raise RuntimeVerificationError("deployment project URL does not match --supabase-url")
    if base_url.rstrip("/") != EXPECTED_SUPABASE_URL:
        raise RuntimeVerificationError("deployment targets the wrong Supabase project")
    if record.get("uploadPlanSha256") != sha256(plan_file):
        raise RuntimeVerificationError("deployment record is not bound to this upload plan")
    alias = record.get("alias")
    if not isinstance(alias, dict) or (
        alias.get("bucket"), alias.get("path"), alias.get("newSha256")
    ) != (alias_row["bucket"], alias_row["path"], alias_row["sha256"]):
        raise RuntimeVerificationError("deployment alias binding does not match the upload plan")
    _require_sha(alias.get("previousSha256"), "deployment previous alias")

    expected = {
        (row["bucket"], row["path"]): (row["sha256"], row["bytes"])
        for row in versioned
    }
    uploaded = record.get("uploaded")
    if not isinstance(uploaded, list):
        raise RuntimeVerificationError("deployment record uploaded set is missing")
    actual: dict[tuple[str, str], tuple[Any, Any]] = {}
    for row in uploaded:
        if not isinstance(row, dict):
            raise RuntimeVerificationError("deployment record uploaded row is invalid")
        key = (row.get("bucket"), row.get("path"))
        if key in actual:
            raise RuntimeVerificationError("deployment record contains duplicate objects")
        actual[key] = (row.get("sha256"), row.get("bytes"))
    if actual != expected:
        raise RuntimeVerificationError("deployment object set does not match the upload plan")


def _normalized_hashes(value: Any, label: str) -> list[str]:
    values = value if isinstance(value, list) else [value]
    if not values:
        raise RuntimeVerificationError(f"{label} hash chain is empty")
    return [_require_sha(item, f"{label} item") for item in values]


def _external_evidence_file(path: Path, label: str) -> Path:
    resolved = Path(path).resolve()
    if not resolved.is_file():
        raise RuntimeVerificationError(f"{label} does not exist: {resolved}")
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise RuntimeVerificationError(f"{label} must be an existing file outside Git: {resolved}")


def _load_hash_bound_evidence(
    files: list[Path] | None, expected_hashes: list[str], label: str,
) -> tuple[list[Path], list[dict[str, Any]]]:
    if not isinstance(files, list) or not files or len(files) != len(expected_hashes):
        raise RuntimeVerificationError(
            f"complete {label} evidence files are required in signed hash-chain order"
        )
    paths = [_external_evidence_file(path, label) for path in files]
    actual_hashes = [sha256(path) for path in paths]
    if actual_hashes != expected_hashes:
        raise RuntimeVerificationError(f"{label} files do not match the signed hash chain")
    return paths, [load_json(path, label) for path in paths]


def _review_checks(value: Any, expected: set[str], label: str) -> None:
    if (
        not isinstance(value, dict) or set(value) != expected
        or any(value.get(key) is not True for key in expected)
    ):
        raise RuntimeVerificationError(f"{label} is incomplete")


def _unique_rows(value: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise RuntimeVerificationError(f"{label} is empty or invalid")
    rows: dict[str, dict[str, Any]] = {}
    for row in value:
        if not isinstance(row, dict):
            raise RuntimeVerificationError(f"{label} row is invalid")
        question_id = row.get("id")
        if not isinstance(question_id, str) or not question_id or question_id in rows:
            raise RuntimeVerificationError(f"{label} question IDs are invalid")
        rows[question_id] = row
    return rows


def _validate_review_evidence(
    question_map: dict[str, dict[str, Any]], reviewer: str,
    delegations: list[dict[str, Any]], direct_hashes: list[str], dual_hashes: list[str],
    delegated_review_files: list[Path] | None,
    dual_review_files: list[Path] | None,
    answer_binding_files: list[Path] | None,
) -> dict[str, list[dict[str, Any]]]:
    if len(direct_hashes) != len(delegations) or len(dual_hashes) != len(delegations):
        raise RuntimeVerificationError("delegated review/delegation inventory is inconsistent")
    direct_paths, direct_reviews = _load_hash_bound_evidence(
        delegated_review_files, direct_hashes, "delegated direct review",
    )
    dual_paths, dual_reviews = _load_hash_bound_evidence(
        dual_review_files, dual_hashes, "delegated dual review",
    )
    if not isinstance(answer_binding_files, list) or not answer_binding_files \
            or len(answer_binding_files) != len(dual_reviews):
        raise RuntimeVerificationError(
            "complete official answer binding source files are required in dual-review order"
        )
    binding_paths = [
        _external_evidence_file(path, "official answer binding source")
        for path in answer_binding_files
    ]

    all_direct_pass: dict[str, dict[str, Any]] = {}
    all_direct_ids: set[str] = set()
    direct_groups: list[tuple[set[str], set[str], dict[str, Any]]] = []
    for index, (path, review, delegation) in enumerate(zip(
        direct_paths, direct_reviews, delegations, strict=True,
    )):
        if (
            set(review) != DIRECT_REVIEW_FIELDS
            or review.get("kind") != "matha-owner-delegated-starter-direct-review"
            or review.get("version") != 1
            or review.get("releaseAuthority") is not False
            or review.get("reviewPolicy") != EXPECTED_REVIEW_POLICY
            or review.get("reviewedBy") != reviewer
            or review.get("delegation") != delegation
        ):
            raise RuntimeVerificationError(f"delegated direct review contract is invalid: {path}")
        parse_aware_timestamp(review.get("reviewedAt"), f"direct review {index + 1}")
        exact_inputs = review.get("exactInputs")
        if not isinstance(exact_inputs, dict) or set(exact_inputs) != {
            "candidateManifestSha256", "pixelTemplateSha256",
            "answerBindingSha256", "answerTemplateSha256",
        }:
            raise RuntimeVerificationError(f"delegated direct review inputs are invalid: {path}")
        for key, value in exact_inputs.items():
            _require_sha(value, f"direct review {key}")
        attestation = review.get("passAttestation")
        if (
            not isinstance(attestation, dict)
            or set(attestation) != {
                "appliesToEveryPassedQuestion", "pixelChecks", "answerChecks",
            }
            or attestation.get("appliesToEveryPassedQuestion") is not True
        ):
            raise RuntimeVerificationError(f"delegated direct review attestation is invalid: {path}")
        _review_checks(
            attestation.get("pixelChecks"), PIXEL_REVIEW_CHECKS,
            f"direct pixel attestation {index + 1}",
        )
        _review_checks(
            attestation.get("answerChecks"), ANSWER_REVIEW_CHECKS,
            f"direct answer attestation {index + 1}",
        )
        rows = _unique_rows(review.get("questions"), f"direct review {index + 1}")
        passed: set[str] = set()
        rejected: set[str] = set()
        for question_id, row in rows.items():
            if question_id in all_direct_ids:
                raise RuntimeVerificationError(
                    f"question appears in multiple direct reviews: {question_id}"
                )
            all_direct_ids.add(question_id)
            pixel = row.get("pixelDecision")
            answer = row.get("answerDecision")
            if pixel not in {"pass", "reject"} or answer not in {"pass", "reject"}:
                raise RuntimeVerificationError(f"direct review decision is invalid: {question_id}")
            if pixel == answer == "pass":
                if (
                    not set(row).issubset({
                        "id", "pixelDecision", "answerDecision", "structuredAnswer",
                        "pixelChecks", "answerChecks",
                    })
                    or not isinstance(row.get("structuredAnswer"), dict)
                ):
                    raise RuntimeVerificationError(
                        f"direct review structured answer is missing: {question_id}"
                    )
                if "pixelChecks" in row:
                    _review_checks(
                        row["pixelChecks"], PIXEL_REVIEW_CHECKS,
                        f"direct pixel checks {question_id}",
                    )
                if "answerChecks" in row:
                    _review_checks(
                        row["answerChecks"], ANSWER_REVIEW_CHECKS,
                        f"direct answer checks {question_id}",
                    )
                all_direct_pass[question_id] = row
                passed.add(question_id)
            else:
                reasons = row.get("reasons")
                if (
                    not isinstance(reasons, list) or not reasons
                    or any(not isinstance(reason, str) or not reason.strip() for reason in reasons)
                ):
                    raise RuntimeVerificationError(
                        f"rejected direct review needs reasons: {question_id}"
                    )
                rejected.add(question_id)
        direct_groups.append((passed, rejected, exact_inputs))
    if set(all_direct_pass) != set(question_map):
        raise RuntimeVerificationError(
            "signed source is not the exact complete passed direct-review question set"
        )

    all_dual_items: dict[str, dict[str, Any]] = {}
    answer_asset_count = 0
    binding_evidence: list[dict[str, Any]] = []
    binding_match_fields = {
        "bookId", "chapter", "role", "questionType", "pdfPage",
        "answerPdfPage", "answerRegion", "answerSource", "sourcePdfSha256",
        "cleanedSha256", "answerSha256", "figureCount", "figureSha256",
    }
    for index, (dual_path, dual, binding_path, delegation) in enumerate(zip(
        dual_paths, dual_reviews, binding_paths, delegations, strict=True,
    )):
        direct_pass, direct_reject, exact_inputs = direct_groups[index]
        if (
            set(dual) != DUAL_REVIEW_FIELDS
            or dual.get("kind") != "matha-private-cleaned-owner-delegated-review-candidates"
            or dual.get("version") != 1
            or dual.get("releaseAuthority") is not False
            or dual.get("reviewPolicy") != EXPECTED_REVIEW_POLICY
            or dual.get("humanReviewClaimed") is not False
            or dual.get("ownerDelegation") != delegation
            or dual.get("directReviewSha256") != direct_hashes[index]
            or dual.get("reviewedBy") != reviewer
            or dual.get("pixelReviewer") != reviewer
            or dual.get("answerReviewer") != reviewer
            or dual.get("ownerReleaseAuthorizationRecorded") is not True
            or dual.get("privateAssetDeploymentStillRequired") is not True
            or dual.get("uploadPerformed") is not False
        ):
            raise RuntimeVerificationError(f"delegated dual review contract is invalid: {dual_path}")
        for field in ("reviewedAt", "pixelReviewedAt", "answerReviewedAt"):
            parse_aware_timestamp(dual.get(field), f"dual review {index + 1} {field}")
        cross_inputs = {
            "candidateManifestSha256": "candidateManifestSha256",
            "pixelReviewTemplateSha256": "pixelTemplateSha256",
            "answerBindingSha256": "answerBindingSha256",
            "answerReviewTemplateSha256": "answerTemplateSha256",
        }
        for dual_key, direct_key in cross_inputs.items():
            value = _require_sha(dual.get(dual_key), f"dual review {dual_key}")
            if value != exact_inputs[direct_key]:
                raise RuntimeVerificationError(
                    f"direct/dual review input binding drifted: {dual_key}"
                )
        if sha256(binding_path) != dual["answerBindingSha256"]:
            raise RuntimeVerificationError(
                "official answer binding source does not match the delegated review"
            )
        binding = load_json(binding_path, "official answer binding source")
        if (
            set(binding) != ANSWER_BINDING_FIELDS
            or binding.get("kind") != "cleaned-answer-binding-candidates"
            or binding.get("version") != 1
            or binding.get("releaseAuthority") is not False
        ):
            raise RuntimeVerificationError(
                f"official answer binding source contract is invalid: {binding_path}"
            )
        binding_rows = _unique_rows(
            binding.get("items"), f"official answer binding source {index + 1}",
        )
        group_answer_assets: list[dict[str, str]] = []
        items = _unique_rows(dual.get("items"), f"dual review items {index + 1}")
        quarantine_rows = dual.get("quarantine")
        if not isinstance(quarantine_rows, list):
            raise RuntimeVerificationError(f"dual review quarantine is invalid: {dual_path}")
        quarantine: set[str] = set()
        for row in quarantine_rows:
            if not isinstance(row, dict) or set(row) != {"id", "reasons"}:
                raise RuntimeVerificationError(f"dual review quarantine row is invalid: {dual_path}")
            question_id = row.get("id")
            reasons = row.get("reasons")
            if (
                not isinstance(question_id, str) or not question_id
                or question_id in quarantine or question_id in items
                or not isinstance(reasons, list) or not reasons
                or any(not isinstance(reason, str) or not reason.strip() for reason in reasons)
            ):
                raise RuntimeVerificationError(f"dual review quarantine entry is invalid: {dual_path}")
            quarantine.add(question_id)
        counts = dual.get("counts")
        if (
            not isinstance(counts, dict)
            or set(counts) != {"totalCandidates", "eligible", "quarantined"}
            or any(not _is_int(counts.get(key)) for key in counts)
            or counts.get("totalCandidates") != len(items) + len(quarantine)
            or counts.get("eligible") != len(items)
            or counts.get("quarantined") != len(quarantine)
            or set(items) != direct_pass
            or quarantine != direct_reject
        ):
            raise RuntimeVerificationError(
                f"direct/dual complete-batch decision sets differ: {dual_path}"
            )
        for question_id, item in items.items():
            if set(item) != DUAL_ITEM_FIELDS or question_id in all_dual_items:
                raise RuntimeVerificationError(f"delegated dual review item is invalid: {question_id}")
            question = question_map.get(question_id)
            binding_row = binding_rows.get(question_id)
            if question is None or binding_row is None or set(binding_row) != ANSWER_BINDING_ITEM_FIELDS:
                raise RuntimeVerificationError(
                    f"official answer binding source omits a released question: {question_id}"
                )
            for field in binding_match_fields:
                if item.get(field) != binding_row.get(field):
                    raise RuntimeVerificationError(
                        f"official answer binding source drifted for {question_id}: {field}"
                    )
            for field in ("cleanedSha256", "answerSha256", "sourcePdfSha256"):
                _require_sha(item.get(field), f"dual review {question_id} {field}")
            answer_asset = _external_evidence_file(
                binding_path.parent / "assets" / question_id / "answer.png",
                f"official answer crop {question_id}",
            )
            answer_asset_sha = sha256(answer_asset)
            if answer_asset_sha != item["answerSha256"]:
                raise RuntimeVerificationError(
                    f"official answer crop hash drifted: {question_id}"
                )
            answer_asset_count += 1
            group_answer_assets.append({
                "id": question_id,
                "path": str(answer_asset),
                "sha256": answer_asset_sha,
            })
            answer = question["answerVerification"]
            stem = question["stemAsset"]
            if (
                item.get("bookId") != question.get("bookId")
                or item.get("role") != question.get("role")
                or item.get("pdfPage") != question.get("page")
                or item.get("cleanedSha256") != stem.get("sha256")
                or item.get("sourcePdfSha256") != stem.get("sourcePdfSha256")
                or item.get("answerSha256") != answer.get("officialAnswerSha256")
                or item.get("answerSource") != answer.get("answerSource")
                or item.get("answerPdfPage") != answer.get("answerPdfPage")
                or item.get("structuredAnswer") != answer.get("structuredAnswer")
                or item.get("structuredAnswer")
                   != all_direct_pass[question_id].get("structuredAnswer")
            ):
                raise RuntimeVerificationError(
                    f"released question trust evidence binding drifted: {question_id}"
                )
            all_dual_items[question_id] = item
        binding_evidence.append({
            "name": binding_path.name,
            "path": str(binding_path),
            "sha256": sha256(binding_path),
            "answerAssetRoot": str((binding_path.parent / "assets").resolve()),
            "answerAssetCount": len(group_answer_assets),
            "answerAssetSetSha256": digest(canonical_bytes(sorted(
                group_answer_assets, key=lambda row: row["id"],
            ))),
        })
    if set(all_dual_items) != set(question_map) or answer_asset_count != len(question_map):
        raise RuntimeVerificationError(
            "signed source is not the exact complete dual-reviewed answer-crop set"
        )
    return {
        "directReviews": [
            {"name": path.name, "path": str(path), "sha256": hash_value}
            for path, hash_value in zip(direct_paths, direct_hashes, strict=True)
        ],
        "dualReviews": [
            {"name": path.name, "path": str(path), "sha256": hash_value}
            for path, hash_value in zip(dual_paths, dual_hashes, strict=True)
        ],
        "answerBindings": binding_evidence,
    }


def _validate_stem_asset(question: dict[str, Any], reviewer: str) -> None:
    question_id = question["id"]
    asset = question.get("stemAsset")
    if question.get("needsStemAsset") is not True or not isinstance(asset, dict):
        raise RuntimeVerificationError(f"signed source stem asset is missing: {question_id}")
    required = {
        "path", "sha256", "sourcePdfSha256", "pageIndex", "bbox", "role",
        "assetStatus", "mime", "width", "height", "containsAnswer",
        "containsSolution", "containsHandwriting", "includesOptions",
        "questionIds", "bookId", "producer", "verifier",
    }
    if set(asset) != required:
        raise RuntimeVerificationError(f"stem asset schema is invalid: {question_id}")
    path = safe_object_path(asset.get("path"), f"stem asset {question_id}")
    bbox = asset.get("bbox")
    verifier = asset.get("verifier")
    if (
        not path.endswith(".png")
        or _require_sha(asset.get("sha256"), f"stem asset {question_id}") is None
        or _require_sha(asset.get("sourcePdfSha256"), f"source PDF {question_id}") is None
        or asset.get("role") != "question-stem"
        or asset.get("assetStatus") != "verified"
        or asset.get("mime") != "image/png"
        or not _is_int(asset.get("width")) or asset["width"] < 80
        or not _is_int(asset.get("height")) or asset["height"] < 80
        or asset.get("containsAnswer") is not False
        or asset.get("containsSolution") is not False
        or asset.get("containsHandwriting") is not False
        or asset.get("questionIds") != [question_id]
        or asset.get("bookId") != question.get("bookId")
        or asset.get("pageIndex") != question.get("page")
        or not isinstance(bbox, list) or len(bbox) != 4
        or any(not isinstance(value, (int, float)) or isinstance(value, bool)
               or value < 0 or value > 1 for value in bbox)
        # The signed source encodes [x, y, width, height], not two corners.
        or bbox[2] <= 0 or bbox[3] <= 0
        or bbox[0] + bbox[2] > 1.000001
        or bbox[1] + bbox[3] > 1.000001
        or not isinstance(asset.get("producer"), str) or not asset["producer"].strip()
        or not isinstance(verifier, dict)
    ):
        raise RuntimeVerificationError(f"stem asset safety binding is invalid: {question_id}")
    expected_verifier = {
        "reviewer", "reviewVersion", "questionRoleVerified", "safetyVerified",
        "assetHashVerified", "fullStemVerified", "optionsVerified", "verifiedAt",
    }
    if (
        set(verifier) != expected_verifier
        or verifier.get("reviewer") != reviewer
        or not _is_int(verifier.get("reviewVersion"))
        or verifier["reviewVersion"] < 1
        or any(verifier.get(key) is not True for key in (
            "questionRoleVerified", "safetyVerified", "assetHashVerified",
            "fullStemVerified", "optionsVerified",
        ))
        or asset["producer"].strip() == reviewer
    ):
        raise RuntimeVerificationError(f"stem asset reviewer binding is invalid: {question_id}")
    parse_aware_timestamp(verifier.get("verifiedAt"), f"stem review {question_id}")
    if question.get("type") in {"single", "multi"} and asset.get("includesOptions") is not True:
        raise RuntimeVerificationError(f"choice stem omits printed options: {question_id}")
    if not isinstance(asset.get("includesOptions"), bool):
        raise RuntimeVerificationError(f"stem option coverage flag is invalid: {question_id}")


def _validate_answer(question: dict[str, Any], reviewer: str) -> str:
    question_id = question["id"]
    answer = question.get("answerVerification")
    if not isinstance(answer, dict) or set(answer) != {
        "reviewer", "reviewedAt", "officialAnswerSha256", "answerSource",
        "answerPdfPage", "structuredAnswer",
    }:
        raise RuntimeVerificationError(f"answerVerification schema is invalid: {question_id}")
    if answer.get("reviewer") != reviewer:
        raise RuntimeVerificationError(f"answer reviewer is not the signed reviewer: {question_id}")
    parse_aware_timestamp(answer.get("reviewedAt"), f"answer review {question_id}")
    _require_sha(answer.get("officialAnswerSha256"), f"official answer {question_id}")
    if answer.get("answerSource") not in EXPECTED_ANSWER_SOURCES:
        raise RuntimeVerificationError(f"official answer source is invalid: {question_id}")
    if not _is_int(answer.get("answerPdfPage")) or answer["answerPdfPage"] < 1:
        raise RuntimeVerificationError(f"official answer page is invalid: {question_id}")
    structured = answer.get("structuredAnswer")
    if not isinstance(structured, dict) or structured.get("schema") != 1:
        raise RuntimeVerificationError(f"structured answer is invalid: {question_id}")
    mode = structured.get("mode")
    answers = question.get("ans")
    options = question.get("opts")
    if not isinstance(answers, list) or not isinstance(options, list):
        raise RuntimeVerificationError(f"question answer fields are invalid: {question_id}")
    if mode == "text":
        if set(structured) != {"schema", "mode", "officialAnswerText"}:
            raise RuntimeVerificationError(f"text answer schema is invalid: {question_id}")
        text = _require_nonempty_text(
            structured.get("officialAnswerText"), f"official answer text {question_id}",
            maximum=4000,
        )
        if (
            question.get("type") != "fill" or options != [] or answers != [text]
            or question.get("sol") != f"\u5b98\u65b9\u7b54\u6848\uff1a{text}"
        ):
            raise RuntimeVerificationError(
                f"ans/sol do not match the official text answer: {question_id}"
            )
        return mode
    if mode not in {"single", "multi"} or set(structured) != {
        "schema", "mode", "optionCount", "correctOptionNumbers",
    }:
        raise RuntimeVerificationError(f"option answer schema is invalid: {question_id}")
    option_count = structured.get("optionCount")
    correct = structured.get("correctOptionNumbers")
    if (
        not _is_int(option_count) or not 2 <= option_count <= 12
        or not isinstance(correct, list) or not correct
        or any(not _is_int(number) or not 1 <= number <= option_count for number in correct)
        or len(correct) != len(set(correct))
        or (mode == "single" and len(correct) != 1)
        or question.get("type") != mode
        or options != [f"\u539f\u984c\u9078\u9805 {number}" for number in range(1, option_count + 1)]
        or answers != [number - 1 for number in correct]
        or question.get("sol") != "\u5b98\u65b9\u7b54\u6848\uff1a" + "\u3001".join(map(str, correct))
    ):
        raise RuntimeVerificationError(
            f"ans/sol do not match the official option answer: {question_id}"
        )
    return mode


def _validate_source_question(question: Any, reviewer: str) -> str:
    if not isinstance(question, dict) or set(question) != SOURCE_QUESTION_FIELDS:
        raise RuntimeVerificationError("signed source question schema is invalid")
    question_id = question.get("id")
    if not isinstance(question_id, str) or not question_id:
        raise RuntimeVerificationError("signed source question ID is invalid")
    if (
        question.get("topic") not in EXPECTED_TOPICS
        or question.get("role") not in EXPECTED_ROLE_NAMES
        or question.get("type") not in {"single", "multi", "fill"}
        or not _is_int(question.get("diff")) or not 1 <= question["diff"] <= 3
        or not _is_int(question.get("page")) or question["page"] < 1
        or question.get("displayTruth") != "original-pdf-crop"
        or any(not isinstance(question.get(key), str) or not question[key].strip()
               for key in ("q", "sol", "src", "bookId", "bookTitle"))
    ):
        raise RuntimeVerificationError(f"signed source question metadata is invalid: {question_id}")
    _validate_stem_asset(question, reviewer)
    return _validate_answer(question, reviewer)


def _validate_signed_source(
    source_file: Path, plan: dict[str, Any], release_id: str,
    delegated_review_files: list[Path] | None,
    dual_review_files: list[Path] | None,
    answer_binding_files: list[Path] | None,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], dict[str, int], dict[str, Any]]:
    source = load_json(source_file, "signed private question source")
    summary = plan.get("summary")
    expected_questions = summary.get("questions") if isinstance(summary, dict) else None
    if not _is_int(expected_questions) or expected_questions < 1:
        raise RuntimeVerificationError("upload plan question count is invalid")
    source_sha = sha256(source_file)
    if plan.get("sourceSha256") != source_sha:
        raise RuntimeVerificationError("upload plan is not bound to the provided signed source")
    if (
        source.get("schema") != 3
        or source.get("kind") != "private-question-source"
        or source.get("releaseId") != release_id
        or source.get("reviewPolicy") != EXPECTED_REVIEW_POLICY
        or source.get("releaseApprovedBy") != plan.get("releaseApprovedBy")
        or any(source.get(key) != value for key, value in EXPECTED_CORPUS.items())
        or source.get("originalPdfVerified") is not True
        or source.get("answerKeyVerified") is not True
        or source.get("mathematicalCorrectnessVerified") is not True
    ):
        raise RuntimeVerificationError("signed source corpus trust contract is invalid")

    owner = _require_nonempty_text(source.get("releaseApprovedBy"), "release approver")
    reviewer = _require_nonempty_text(source.get("reviewedBy"), "delegated reviewer")
    if NON_HUMAN_RE.search(owner) or not NON_HUMAN_RE.search(reviewer):
        raise RuntimeVerificationError("delegated source owner/reviewer identities are invalid")
    delegations = source.get("ownerDelegations")
    delegation_set = source.get("ownerDelegation")
    if not isinstance(delegations, list) or not delegations or not isinstance(delegation_set, dict):
        raise RuntimeVerificationError("owner delegation chain is missing")
    if delegation_set != {
        "kind": "owner-delegated-agent-content-review-set",
        "authorizedBy": owner,
        "delegationCount": len(delegations),
    }:
        raise RuntimeVerificationError("owner delegation set is invalid")
    for index, delegation in enumerate(delegations):
        if (
            not isinstance(delegation, dict)
            or set(delegation) != {"kind", "authorizedBy", "authorizedAt", "scope", "basis"}
            or delegation.get("kind") != "owner-delegated-agent-content-review"
            or delegation.get("authorizedBy") != owner
        ):
            raise RuntimeVerificationError("owner delegation entry is invalid")
        parse_aware_timestamp(delegation.get("authorizedAt"), f"owner delegation {index + 1}")
        _require_nonempty_text(delegation.get("scope"), "owner delegation scope")
        _require_nonempty_text(delegation.get("basis"), "owner delegation basis")

    audit = source.get("reviewAudit")
    approval = source.get("releaseApproval")
    if not isinstance(audit, dict) or not isinstance(approval, dict):
        raise RuntimeVerificationError("delegated review audit or approval is missing")
    direct_hashes = _normalized_hashes(audit.get("directReviewSha256"), "direct review")
    dual_hashes = _normalized_hashes(audit.get("dualReviewSha256"), "dual review")
    approval_hashes = _normalized_hashes(
        approval.get("delegatedReviewSha256"), "release approval review",
    )
    version = approval.get("version")
    expected_version = 1 if len(direct_hashes) == 1 else 2
    if (
        approval.get("kind") != "owner-delegated-agent-starter-private-release-signoff"
        or version != expected_version
        or approval_hashes != direct_hashes
        or len(dual_hashes) != len(direct_hashes)
        or approval.get("authorizedBy") != owner
        or approval.get("authorizedAt") != delegations[0]["authorizedAt"]
        or approval.get("authorizations") != delegations
        or approval.get("performedBy") != reviewer
        or approval.get("humanPixelReviewClaimed") is not False
    ):
        raise RuntimeVerificationError("delegated release authorization chain is invalid")
    parse_aware_timestamp(approval.get("performedAt"), "delegated release performance")
    parse_aware_timestamp(audit.get("completedAt"), "review audit completion")
    _require_sha(audit.get("selectionSha256"), "review selection")
    unsigned_file = source_file.with_name("unsigned-private-question-source.json")
    asset_file = source_file.with_name("asset-manifest.json")
    unsigned_sha = _require_sha(
        approval.get("unsignedSourceSha256"), "approval unsigned source",
    )
    asset_sha = _require_sha(approval.get("assetManifestSha256"), "approval asset manifest")
    if sha256(unsigned_file) != unsigned_sha or sha256(asset_file) != asset_sha:
        raise RuntimeVerificationError("signed source predecessor or asset manifest hash drifted")
    unsigned = load_json(unsigned_file, "unsigned private question source")
    expected_unsigned = copy.deepcopy(source)
    expected_unsigned.pop("releaseApproval", None)
    expected_unsigned["releaseApprovedBy"] = None
    if unsigned != expected_unsigned:
        raise RuntimeVerificationError("signed source is not an exact approved unsigned source")

    questions = source.get("questions")
    if not isinstance(questions, list) or len(questions) != expected_questions:
        raise RuntimeVerificationError("signed source question count is invalid")
    question_map: dict[str, dict[str, Any]] = {}
    answer_modes: Counter[str] = Counter()
    for question in questions:
        mode = _validate_source_question(question, reviewer)
        question_id = question["id"]
        if question_id in question_map:
            raise RuntimeVerificationError(f"duplicate signed source question: {question_id}")
        question_map[question_id] = question
        answer_modes[mode] += 1

    evidence_files = _validate_review_evidence(
        question_map, reviewer, delegations, direct_hashes, dual_hashes,
        delegated_review_files, dual_review_files, answer_binding_files,
    )

    samples = source.get("releaseReviewSampleQuestionIds")
    if (
        not isinstance(samples, list) or not samples
        or len(samples) != len(set(samples))
        or approval.get("sampleQuestionIds") != samples
        or any(question_id not in question_map for question_id in samples)
    ):
        raise RuntimeVerificationError("delegated release sample binding is invalid")
    if (
        audit.get("sourceQuestionCount") != expected_questions
        or audit.get("approvedQuestionCount") != expected_questions
    ):
        raise RuntimeVerificationError("delegated review inventory count is invalid")

    assets = load_json(asset_file, "signed source asset manifest")
    asset_rows = assets.get("questions")
    if (
        assets.get("kind") != "matha-starter-private-asset-manifest"
        or assets.get("version") != 1
        or assets.get("releaseAuthority") is not False
        or assets.get("releaseId") != release_id
        or not isinstance(asset_rows, list)
        or len(asset_rows) != expected_questions
    ):
        raise RuntimeVerificationError("signed source asset manifest is invalid")
    asset_map: dict[str, dict[str, Any]] = {}
    for row in asset_rows:
        if not isinstance(row, dict) or set(row) != {"id", "path", "sha256", "bookId"}:
            raise RuntimeVerificationError("signed source asset row is invalid")
        question_id = row.get("id")
        if not isinstance(question_id, str) or question_id in asset_map:
            raise RuntimeVerificationError("signed source asset IDs are invalid")
        asset_map[question_id] = row
    if set(asset_map) != set(question_map):
        raise RuntimeVerificationError("signed source and asset question sets differ")
    for question_id, question in question_map.items():
        stem = question["stemAsset"]
        if asset_map[question_id] != {
            "id": question_id, "path": stem["path"], "sha256": stem["sha256"],
            "bookId": question["bookId"],
        }:
            raise RuntimeVerificationError(f"asset manifest binding drifted: {question_id}")

    chain = {
        "owner": owner,
        "reviewer": reviewer,
        "delegations": len(delegations),
        "directReviewSha256": direct_hashes,
        "dualReviewSha256": dual_hashes,
        "selectionSha256": audit["selectionSha256"],
        "unsignedSourceSha256": unsigned_sha,
        "assetManifestSha256": asset_sha,
        "providedDirectReviewFiles": len(delegated_review_files or []),
        "evidenceFiles": evidence_files,
    }
    return source, question_map, dict(sorted(answer_modes.items())), chain


def _readback(
    rows: list[dict[str, Any]], base_url: str, service_key: str,
    downloader: Callable[[str, str, str, str], bytes | None],
) -> dict[tuple[str, str], bytes]:
    values: dict[tuple[str, str], bytes] = {}
    for row in rows:
        bucket, path = row["bucket"], row["path"]
        data = downloader(base_url, service_key, bucket, path)
        if data is None:
            raise RuntimeVerificationError(f"remote object is missing: {bucket}/{path}")
        if len(data) != row["bytes"] or digest(data) != row["sha256"]:
            raise RuntimeVerificationError(f"remote object drift: {bucket}/{path}")
        values[(bucket, path)] = data
    return values


def _validate_manifest(
    manifest: dict[str, Any], plan: dict[str, Any], release_id: str,
    values: dict[tuple[str, str], bytes], versioned: list[dict[str, Any]],
    source: dict[str, Any], source_file: Path, source_questions: dict[str, dict[str, Any]],
) -> tuple[dict[str, int], dict[str, int], dict[str, int]]:
    question_count = len(source_questions)
    summary = plan.get("summary")
    content_file_count = summary.get("contentFiles") if isinstance(summary, dict) else None
    if not _is_int(content_file_count) or content_file_count < 4:
        raise RuntimeVerificationError("upload plan content-file count is invalid")
    pack_count = content_file_count - 3
    expected_topic_counts = Counter(
        question["topic"] for question in source_questions.values()
    )
    expected_role_counts = Counter(
        question["role"] for question in source_questions.values()
    )
    if (
        manifest.get("schema") != 3
        or manifest.get("releaseId") != release_id
        or manifest.get("releaseReady") is not True
        or manifest.get("visibility") != "authenticated"
    ):
        raise RuntimeVerificationError("manifest release structure is invalid")
    parse_aware_timestamp(manifest.get("generatedAt"), "manifest generation")
    if (
        any(manifest.get(key) != value for key, value in EXPECTED_CORPUS.items())
        or any(manifest.get(key) != source.get(key) for key in EXPECTED_CORPUS)
        or manifest.get("reviewPolicy") != EXPECTED_REVIEW_POLICY
        or manifest.get("reviewPolicy") != source.get("reviewPolicy")
        or manifest.get("mathematicalCorrectnessVerified") is not True
        or manifest.get("releaseApprovedBy") != source.get("releaseApprovedBy")
        or manifest.get("releaseApproval") != source.get("releaseApproval")
        or manifest.get("sourceFile") != source_file.name
        or manifest.get("sourceSha256") != sha256(source_file)
    ):
        raise RuntimeVerificationError("manifest does not mirror the signed corpus trust contract")
    checks = manifest.get("releaseChecks")
    if (
        not isinstance(checks, dict)
        or set(checks) != EXPECTED_RELEASE_CHECKS
        or not all(value is True for value in checks.values())
    ):
        raise RuntimeVerificationError("manifest release checks are not all true")

    report = manifest.get("report")
    skipped = report.get("skipped") if isinstance(report, dict) else None
    visual = report.get("visual") if isinstance(report, dict) else None
    if (
        not isinstance(report, dict)
        or report.get("sourceTotal") != question_count
        or report.get("accepted") != question_count
        or not isinstance(skipped, dict) or not skipped
        or any(not _is_int(value) or value != 0 for value in skipped.values())
        or not isinstance(visual, dict) or visual.get("pending") != 0
    ):
        raise RuntimeVerificationError("manifest release inventory report is invalid")
    library = manifest.get("library")
    if (
        not isinstance(library, dict) or library.get("schema") != 1
        or any(not _is_int(library.get(key)) or library[key] < 0
               for key in ("verifiedBooks", "readyBooks", "pendingBooks"))
        or library["readyBooks"] + library["pendingBooks"] != 24
    ):
        raise RuntimeVerificationError("manifest textbook inventory is invalid")

    versioned_manifest = plan.get("versionedManifest")
    expected_manifest_path = safe_object_path(
        versioned_manifest, "versioned manifest",
    )
    legacy_manifest_path = f"releases/{release_id}/manifest.json"
    addressed_manifest = re.fullmatch(
        rf"releases/{re.escape(release_id)}/manifests/manifest-([a-f0-9]{{16}})\.json",
        expected_manifest_path,
    )
    if expected_manifest_path != legacy_manifest_path and addressed_manifest is None:
        raise RuntimeVerificationError("upload plan versioned manifest path is invalid")
    manifest_bytes = values.get(("matha-content", expected_manifest_path))
    if manifest_bytes is None:
        raise RuntimeVerificationError("versioned manifest was not read back")
    if addressed_manifest is not None and addressed_manifest.group(1) != hashlib.sha256(manifest_bytes).hexdigest()[:16]:
        raise RuntimeVerificationError(
            "content-addressed manifest path does not match readback bytes"
        )

    row_map = {(row["bucket"], row["path"]): row for row in versioned}
    packs = manifest.get("packs")
    if not isinstance(packs, list) or len(packs) != pack_count:
        raise RuntimeVerificationError(f"manifest must contain exactly {pack_count} packs")
    if len({pack.get("id") for pack in packs if isinstance(pack, dict)}) != pack_count:
        raise RuntimeVerificationError("manifest pack IDs must be unique")

    question_ids: set[str] = set()
    referenced_packs: set[str] = set()
    referenced_figures: set[str] = set()
    topic_counts: Counter[str] = Counter()
    role_counts: Counter[str] = Counter()
    answer_modes: Counter[str] = Counter()
    for pack in packs:
        if not isinstance(pack, dict):
            raise RuntimeVerificationError("manifest pack row is invalid")
        if (
            not isinstance(pack.get("id"), str)
            or re.fullmatch(r"curated-[0-9a-f]{16}", pack["id"]) is None
            or not isinstance(pack.get("name"), str) or not pack["name"].strip()
            or set(pack) != {"id", "name", "file", "count", "sha256"}
        ):
            raise RuntimeVerificationError("manifest pack metadata is invalid")
        path = safe_object_path(pack.get("file"), "pack")
        if path in referenced_packs:
            raise RuntimeVerificationError(f"duplicate manifest pack path: {path}")
        referenced_packs.add(path)
        row = row_map.get(("matha-content", path))
        data = values.get(("matha-content", path))
        if row is None or data is None or pack.get("sha256") != row["sha256"]:
            raise RuntimeVerificationError(f"manifest pack hash/reference mismatch: {path}")
        payload = parse_json_bytes(data, f"question pack {path}")
        items = payload.get("items")
        if (
            payload.get("kind") != "qpack" or payload.get("version") != 2
            or set(payload) != {"kind", "name", "version", "items"}
            or payload.get("name") != pack.get("name") or not isinstance(items, list)
        ):
            raise RuntimeVerificationError(f"question pack structure is invalid: {path}")
        if pack.get("count") != len(items) or not items:
            raise RuntimeVerificationError(f"question pack count is invalid: {path}")
        for item in items:
            if not isinstance(item, dict):
                raise RuntimeVerificationError(f"question entry is invalid: {path}")
            question_id = item.get("id")
            topic = item.get("topic")
            role = item.get("role")
            if not isinstance(question_id, str) or not question_id or question_id in question_ids:
                raise RuntimeVerificationError("question IDs must be non-empty and unique")
            if topic not in EXPECTED_TOPICS or role not in EXPECTED_ROLE_NAMES:
                raise RuntimeVerificationError(f"question classification is invalid: {question_id}")
            source_question = source_questions.get(question_id)
            if source_question is None or any(
                field not in item or item[field] != source_question[field]
                for field in SOURCE_QUESTION_FIELDS
            ):
                raise RuntimeVerificationError(
                    f"remote question does not match the signed source: {question_id}"
                )
            answer_modes[_validate_answer(item, source["reviewedBy"])] += 1
            question_ids.add(question_id)
            topic_counts[topic] += 1
            role_counts[role] += 1

            asset = item.get("stemAsset")
            if item.get("needsStemAsset") is not True or not isinstance(asset, dict):
                raise RuntimeVerificationError(f"question stem asset is missing: {question_id}")
            asset_path = safe_object_path(asset.get("path"), "stem asset")
            asset_sha = _require_sha(asset.get("sha256"), f"stem asset {question_id}")
            asset_row = row_map.get(("matha-figures", asset_path))
            asset_data = values.get(("matha-figures", asset_path))
            if (
                asset_path in referenced_figures
                or asset_row is None
                or asset_data is None
                or asset_row["sha256"] != asset_sha
                or asset_row.get("questionId") != question_id
                or digest(asset_data) != asset_sha
                or asset.get("questionIds") != [question_id]
            ):
                raise RuntimeVerificationError(
                    f"question stem asset hash/reference mismatch: {question_id}"
                )
            referenced_figures.add(asset_path)

    if len(question_ids) != question_count:
        raise RuntimeVerificationError(
            f"release must contain exactly {question_count} unique questions"
        )
    if set(topic_counts) != EXPECTED_TOPICS or topic_counts != expected_topic_counts:
        raise RuntimeVerificationError("14-unit distribution differs from the signed source")
    if set(role_counts) != EXPECTED_ROLE_NAMES or role_counts != expected_role_counts:
        raise RuntimeVerificationError("question role distribution differs from the signed source")
    if question_ids != set(source_questions):
        raise RuntimeVerificationError("remote and signed-source question sets differ")

    expected_pack_paths = {
        row["path"] for row in versioned
        if row["bucket"] == "matha-content" and "/content/" in row["path"]
        and re.fullmatch(
            rf"releases/{re.escape(release_id)}/content/pending-visuals(?:-[a-f0-9]{{16}})?\.json",
            row["path"],
        ) is None
    }
    expected_figure_paths = {
        row["path"] for row in versioned if row["bucket"] == "matha-figures"
    }
    if referenced_packs != expected_pack_paths:
        raise RuntimeVerificationError("manifest does not reference the exact question-pack set")
    if referenced_figures != expected_figure_paths:
        raise RuntimeVerificationError("questions do not reference the exact stem-asset set")

    pending = manifest.get("pendingVisuals")
    if not isinstance(pending, dict) or pending.get("count") != 0:
        raise RuntimeVerificationError("manifest pending visuals must be zero")
    pending_path = pending.get("file")
    pending_row = row_map.get(("matha-content", pending_path))
    pending_data = values.get(("matha-content", pending_path))
    if (
        pending_row is None or pending_data is None
        or pending.get("sha256") != pending_row["sha256"]
    ):
        raise RuntimeVerificationError("pending-visuals hash/reference mismatch")
    pending_payload = parse_json_bytes(pending_data, "pending visuals")
    if (
        pending_payload.get("kind") != "pending-visual-queue"
        or pending_payload.get("version") != 1
        or pending_payload.get("count") != 0
        or pending_payload.get("items") != []
    ):
        raise RuntimeVerificationError("pending-visuals payload is not an empty safe queue")

    return (
        dict(sorted(topic_counts.items())), dict(role_counts),
        dict(sorted(answer_modes.items())),
    )


def _app_identity() -> tuple[str, str, str]:
    app_path = REPO_ROOT / "app.js"
    catalog_path = REPO_ROOT / "textbook-catalog.js"
    if not app_path.is_file() or not catalog_path.is_file():
        raise RuntimeVerificationError("repository app trust files are missing")
    data = app_path.read_bytes()
    matches = APP_VERSION_PATTERN.findall(data)
    if len(matches) != 1:
        raise RuntimeVerificationError("app.js must contain exactly one valid APP_VER")
    app_text = data.decode("utf-8")
    project_matches = re.findall(
        r"\bconst\s+SUPA_URL\s*=\s*(['\"])(https://[^'\"]+)\1\s*;",
        app_text,
    )
    if len(project_matches) != 1 or project_matches[0][1] != EXPECTED_SUPABASE_URL:
        raise RuntimeVerificationError("app.js does not target the expected Supabase project")
    catalog_data = catalog_path.read_bytes()
    catalog_text = catalog_data.decode("utf-8")
    required_catalog_patterns = {
        "manifestAlias": EXPECTED_ALIAS,
        "generation": EXPECTED_CORPUS["corpusGeneration"],
        "sourceInventorySha256": EXPECTED_CORPUS["sourceInventorySha256"],
        "ocrProvider": EXPECTED_CORPUS["ocrProvider"],
        "ocrModel": EXPECTED_CORPUS["ocrModel"],
        "verificationPolicy": EXPECTED_CORPUS["verificationPolicy"],
    }
    for key, value in required_catalog_patterns.items():
        if re.search(
            rf"\b{re.escape(key)}\s*:\s*['\"]{re.escape(str(value))}['\"]",
            catalog_text,
        ) is None:
            raise RuntimeVerificationError(f"textbook catalog trust field drifted: {key}")
    for key in ("sourceDocuments", "sourcePages"):
        if re.search(
            rf"\b{key}\s*:\s*{EXPECTED_CORPUS[key]}\b", catalog_text,
        ) is None:
            raise RuntimeVerificationError(f"textbook catalog trust field drifted: {key}")
    return matches[0][1].decode("ascii"), digest(data), digest(catalog_data)


def verify_runtime(
    plan_file: Path, deployment_file: Path, output_file: Path,
    base_url: str, service_key: str,
    downloader: Callable[[str, str, str, str], bytes | None] = download_object,
    signed_source_file: Path | None = None,
    delegated_review_files: list[Path] | None = None,
    dual_review_files: list[Path] | None = None,
    answer_binding_files: list[Path] | None = None,
) -> dict[str, Any]:
    """Verify one live release and atomically persist its private attestation."""
    output_file = outside_repo(output_file)
    service_headers(service_key)
    if not isinstance(base_url, str) or not re.fullmatch(r"https://[^\s/]+(?:/)?", base_url):
        raise RuntimeVerificationError("SUPABASE_URL must be an HTTPS project URL")
    if base_url.rstrip("/") != EXPECTED_SUPABASE_URL:
        raise RuntimeVerificationError("SUPABASE_URL does not match the project used by app.js")
    plan = load_json(plan_file, "upload plan")
    deployment = load_json(deployment_file, "deployment record")
    release_id, alias_path, versioned, alias_row = _plan_rows(plan)
    plan_source = plan.get("source")
    if signed_source_file is None:
        source_path = Path(str(plan_source))
        if not source_path.is_absolute():
            source_path = plan_file.resolve().parent / source_path
    else:
        source_path = Path(signed_source_file)
    source_path = source_path.resolve()
    source, source_questions, source_answer_modes, authorization_chain = (
        _validate_signed_source(
            source_path, plan, release_id, delegated_review_files,
            dual_review_files, answer_binding_files,
        )
    )
    question_count = len(source_questions)
    pack_count = plan["summary"]["contentFiles"] - 3
    _validate_deployment(
        deployment, plan_file, release_id, base_url, versioned, alias_row
    )

    alias_values = _readback([alias_row], base_url, service_key, downloader)
    alias_bytes = alias_values[(alias_row["bucket"], alias_row["path"])]
    values = _readback(versioned, base_url, service_key, downloader)
    versioned_manifest_path = plan.get("versionedManifest")
    versioned_manifest_bytes = values.get(("matha-content", versioned_manifest_path))
    if versioned_manifest_bytes is None or alias_bytes != versioned_manifest_bytes:
        raise RuntimeVerificationError("manifest alias does not equal the versioned manifest")
    manifest = parse_json_bytes(alias_bytes, "manifest alias")
    topics, roles, remote_answer_modes = _validate_manifest(
        manifest, plan, release_id, values, versioned,
        source, source_path, source_questions,
    )
    if remote_answer_modes != source_answer_modes:
        raise RuntimeVerificationError("remote answer-mode inventory differs from signed source")

    app_version, app_js_sha, catalog_sha = _app_identity()
    plan_sha = sha256(plan_file)
    deployment_sha = sha256(deployment_file)
    object_rows = sorted(
        ({key: row[key] for key in ("bucket", "path", "sha256", "bytes")}
         for row in versioned),
        key=lambda row: (row["bucket"], row["path"]),
    )
    object_set_sha = digest(json.dumps(
        object_rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8"))
    binding = {
        "releaseId": release_id,
        "uploadPlanSha256": plan_sha,
        "deploymentRecordSha256": deployment_sha,
        "signedSourceSha256": sha256(source_path),
        "aliasSha256": alias_row["sha256"],
        "versionedObjectSetSha256": object_set_sha,
        "appVersion": app_version,
        "appJsSha256": app_js_sha,
        "textbookCatalogSha256": catalog_sha,
    }
    binding_sha = digest(json.dumps(
        binding, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8"))
    verified_at = datetime.now(timezone.utc)
    evidence = {
        "kind": "matha-private-release-runtime-verification",
        "version": 2,
        "status": "verified",
        "verifiedAt": verified_at.isoformat(),
        "projectUrl": base_url.rstrip("/"),
        **binding,
        "releaseAppBindingSha256": binding_sha,
        "alias": {
            "bucket": alias_row["bucket"],
            "path": alias_path,
            "sha256": alias_row["sha256"],
            "bytes": alias_row["bytes"],
        },
        "readback": {
            "aliasObjects": 1,
            "versionedObjects": len(versioned),
            "contentObjects": sum(row["bucket"] == "matha-content" for row in versioned),
            "stemAssets": sum(row["bucket"] == "matha-figures" for row in versioned),
            "hashMismatches": 0,
            "missingObjects": 0,
        },
        "content": {
            "questions": question_count,
            "packs": pack_count,
            "topics": topics,
            "roles": roles,
            "answerModes": remote_answer_modes,
            "answersVerifiedAgainstSignedSource": question_count,
            "pendingVisuals": 0,
        },
        "trust": {
            **EXPECTED_CORPUS,
            "reviewPolicy": EXPECTED_REVIEW_POLICY,
            "releaseApprovedBy": source["releaseApprovedBy"],
            "signedSourceQuestionSetSha256": digest(canonical_bytes(source["questions"])),
            "answerEvidenceSetSha256": digest(canonical_bytes([
                {
                    "id": question["id"], "ans": question["ans"],
                    "sol": question["sol"],
                    "answerVerification": question["answerVerification"],
                }
                for question in source["questions"]
            ])),
            "authorizationChainSha256": digest(canonical_bytes(authorization_chain)),
            "authorizationChain": authorization_chain,
        },
    }
    # The credential is used only in request headers and is never serialized.
    if service_key.encode("utf-8") in pretty_json_bytes(evidence):
        raise RuntimeVerificationError("refusing to serialize a credential")
    if output_file.exists():
        current = load_json(output_file, "runtime verification current pointer")
        if (
            current.get("kind") != "matha-private-release-runtime-verification"
            or current.get("recordRole") != "current-pointer"
        ):
            raise RuntimeVerificationError(
                "refusing to overwrite a non-pointer verification record"
            )
    evidence_sha = digest(pretty_json_bytes(evidence))
    stamp = verified_at.strftime("%Y%m%dT%H%M%S%fZ")
    immutable_file = output_file.with_name(
        f"{output_file.stem}-{stamp}-{evidence_sha[:16]}{output_file.suffix or '.json'}"
    )
    immutable_file = outside_repo(immutable_file)
    immutable_sha = write_json_exclusive(immutable_file, evidence)
    if immutable_sha != evidence_sha:
        raise RuntimeVerificationError("immutable verification record hash changed while writing")

    result = {
        **evidence,
        "recordRole": "current-pointer",
        "immutableRecord": immutable_file.name,
        "immutableRecordSha256": immutable_sha,
    }
    if service_key.encode("utf-8") in pretty_json_bytes(result):
        raise RuntimeVerificationError("refusing to serialize a credential")
    write_json_atomic(output_file, result)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--deployment-record", required=True, type=Path)
    parser.add_argument(
        "--signed-source", type=Path,
        help="exact signed-private-question-source.json (defaults to upload plan source)",
    )
    parser.add_argument(
        "--delegated-review", action="append", type=Path, required=True,
        help="exact delegated direct review file; repeat in signed hash-chain order",
    )
    parser.add_argument(
        "--dual-review", action="append", type=Path, required=True,
        help="exact delegated dual/intersection review file; repeat in signed hash-chain order",
    )
    parser.add_argument(
        "--answer-binding-source", action="append", type=Path, required=True,
        help=("exact answer-binding-candidates.json; repeat in dual-review order; "
              "the sibling assets/<question-id>/answer.png files are hash-verified"),
    )
    parser.add_argument(
        "--output", type=Path,
        help=("private record path outside Git (default: next to the deployment "
              f"record as {DEFAULT_RECORD_NAME})"),
    )
    parser.add_argument("--supabase-url", default=os.environ.get("SUPABASE_URL", ""))
    args = parser.parse_args(argv)
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    output = args.output or args.deployment_record.with_name(DEFAULT_RECORD_NAME)
    try:
        result = verify_runtime(
            args.plan, args.deployment_record, output,
            args.supabase_url, service_key,
            signed_source_file=args.signed_source,
            delegated_review_files=args.delegated_review,
            dual_review_files=args.dual_review,
            answer_binding_files=args.answer_binding_source,
        )
    except (RuntimeVerificationError, OSError, ValueError) as error:
        print(f"verify-private-release-runtime: {error}", file=sys.stderr)
        return 2
    print(json.dumps({
        "status": result["status"],
        "releaseId": result["releaseId"],
        "questions": result["content"]["questions"],
        "packs": result["content"]["packs"],
        "appVersion": result["appVersion"],
        "appJsSha256": result["appJsSha256"],
        "immutableRecord": result["immutableRecord"],
        "verificationRecord": str(output.resolve()),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
