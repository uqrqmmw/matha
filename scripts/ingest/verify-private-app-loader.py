#!/usr/bin/env python3
"""Verify the private bank through the authenticated path used by the App.

This verifier deliberately does not use a browser or an AI API.  A real,
approved Supabase user JWT creates the fixed-alias signed URL and downloads all
question packs through Storage RLS, just as ``app.js`` does.  Every stem image
is downloaded through authenticated Storage RLS; a covering subset is also
cross-checked through signed URLs.  The service-role credential, when used, is
confined to request headers
while minting a short-lived magic-link session; it is never used for the
learner-facing Storage checks or written to output.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_RECORD_NAME = "private-app-loader-verification.json"
EXPECTED_ALIAS = "manifest-mistral-ocr4-verified-v1.json"
# Historical 217-question fixtures retained for test compatibility only.
# Production validation derives exact counts from the signed upload plan.
EXPECTED_QUESTIONS = 217
EXPECTED_PACKS = 191
EXPECTED_TOPICS = {
    "comb", "data", "exp", "line", "mat", "num", "poly", "prob",
    "seq", "splane", "svec", "trig1", "trig2", "vec",
}
EXPECTED_ROLES = {
    "example": 114,
    "chapter-end-easy": 56,
    "chapter-end-medium": 34,
    "chapter-end-hard": 13,
}
ALLOWED_ROLES = set(EXPECTED_ROLES) | {"comprehensive-review", "unclassified"}
EVIDENCE_DIGEST_FIELDS = (
    "kind", "version", "status", "verifiedAt",
    "releaseId", "uploadPlanSha256", "deploymentRecordSha256",
    "storageRuntimeRecordSha256", "storageRuntimeCurrentPointerSha256",
    "storageRuntimeImmutableRecord", "storageRuntimeImmutableRecordSha256",
    "storageRuntimeBindingSha256", "signedSourceSha256", "aliasSha256",
    "appVersion", "appJsSha256", "textbookCatalogSha256", "projectUrl",
    "appLoaderBindingSha256", "authentication", "signedSourceQuestionSet",
    "loader", "stemAssetReadback", "stemAssetSample",
)
EVIDENCE_CANONICALIZATION = "recursive-key-sorted-json-v1"
SAFE_ID = re.compile(r"^[\w.:-]+$")
SAFE_SHA = re.compile(r"^[0-9a-f]{64}$")
SAFE_ASSET_PATH = re.compile(r"^[\w./-]+\.(?:png|webp|jpe?g)$", re.I)
NON_HUMAN = re.compile(
    r"(?:claude|codex|chatgpt|gpt|gemini|agent|bot|automation|自動|模型|人工智慧|\bai\b)",
    re.I,
)


class AppLoaderVerificationError(RuntimeError):
    """The authenticated App loading path cannot be proven safe."""


def _load_storage_runtime_module():
    path = Path(__file__).with_name("verify-private-release-runtime.py")
    spec = importlib.util.spec_from_file_location("matha_storage_runtime", path)
    if spec is None or spec.loader is None:
        raise AppLoaderVerificationError("storage runtime verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORAGE_RUNTIME = _load_storage_runtime_module()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_sha(value: Any) -> str:
    return digest(json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8"))


def sha256(path: Path) -> str:
    return digest(path.read_bytes())


def load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise AppLoaderVerificationError(f"{label} does not exist: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AppLoaderVerificationError(f"{label} is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise AppLoaderVerificationError(f"{label} must be a JSON object")
    return value


def parse_json_bytes(data: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AppLoaderVerificationError(f"{label} is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise AppLoaderVerificationError(f"{label} must be a JSON object")
    return value


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


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise AppLoaderVerificationError(f"verification output must stay outside Git: {resolved}")


def safe_object_path(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or value.startswith("/"):
        raise AppLoaderVerificationError(f"unsafe {label} path")
    if any(part in {"", ".", ".."} for part in PurePosixPath(value).parts):
        raise AppLoaderVerificationError(f"unsafe {label} path")
    return value


def require_sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or SAFE_SHA.fullmatch(value) is None:
        raise AppLoaderVerificationError(f"{label} SHA-256 is missing or invalid")
    return value


def _plan_counts(plan: dict[str, Any]) -> tuple[int, int, int]:
    summary = plan.get("summary")
    questions = summary.get("questions") if isinstance(summary, dict) else None
    content_files = summary.get("contentFiles") if isinstance(summary, dict) else None
    stems = summary.get("stemAssets") if isinstance(summary, dict) else None
    if (
        not isinstance(questions, int) or isinstance(questions, bool) or questions < 1
        or not isinstance(content_files, int) or isinstance(content_files, bool)
        or content_files < 4 or stems != questions
    ):
        raise AppLoaderVerificationError("upload plan summary is invalid")
    return questions, content_files - 3, (content_files - 1) + questions


def _app_identity() -> dict[str, str]:
    source = (REPO_ROOT / "app.js").read_bytes()
    text = source.decode("utf-8")
    version = re.findall(r"\bconst\s+APP_VER\s*=\s*['\"]([^'\"]+)['\"]\s*;", text)
    project = re.findall(r"\bconst\s+SUPA_URL\s*=\s*['\"]([^'\"]+)['\"]\s*;", text)
    publishable = re.findall(r"\bconst\s+SUPA_KEY\s*=\s*['\"]([^'\"]+)['\"]\s*;", text)
    if len(version) != 1 or len(project) != 1 or len(publishable) != 1:
        raise AppLoaderVerificationError("app.js identity constants are missing or ambiguous")
    if not re.fullmatch(r"[0-9]{4}[a-z]", version[0]):
        raise AppLoaderVerificationError("app.js APP_VER is invalid")
    return {
        "appVersion": version[0],
        "appJsSha256": digest(source),
        "textbookCatalogSha256": sha256(REPO_ROOT / "textbook-catalog.js"),
        "projectUrl": project[0].rstrip("/"),
        "publishableKey": publishable[0],
    }


def _catalog_identity() -> tuple[dict[str, Any], dict[str, str]]:
    text = (REPO_ROOT / "textbook-catalog.js").read_text(encoding="utf-8")
    trusted_match = re.search(r"trustedCorpus\s*:\s*\{(?P<body>.*?)\n\s*\},", text, re.S)
    if trusted_match is None:
        raise AppLoaderVerificationError("trusted textbook corpus is missing")
    body = trusted_match.group("body")

    def string_field(name: str) -> str:
        match = re.search(rf"\b{re.escape(name)}\s*:\s*'([^']*)'", body)
        if match is None:
            raise AppLoaderVerificationError(f"trusted corpus field is missing: {name}")
        return match.group(1)

    def number_field(name: str) -> int:
        match = re.search(rf"\b{re.escape(name)}\s*:\s*(\d+)", body)
        if match is None:
            raise AppLoaderVerificationError(f"trusted corpus field is missing: {name}")
        return int(match.group(1))

    trusted = {
        "corpusGeneration": string_field("generation"),
        "manifestAlias": string_field("manifestAlias"),
        "sourceInventorySha256": string_field("sourceInventorySha256"),
        "sourceDocuments": number_field("sourceDocuments"),
        "sourcePages": number_field("sourcePages"),
        "ocrProvider": string_field("ocrProvider"),
        "ocrModel": string_field("ocrModel"),
        "verificationPolicy": string_field("verificationPolicy"),
    }
    books = dict(re.findall(
        r"\{\s*id:'([^']+)'[^\n{}]*?pdfSha256:'([0-9a-f]{64})'", text
    ))
    if len(books) != 25:
        raise AppLoaderVerificationError("textbook catalog must contain 25 hash-bound books")
    return trusted, books


def _quote_object(bucket: str, path: str) -> str:
    if not re.fullmatch(r"[a-z0-9-]+", bucket):
        raise AppLoaderVerificationError("unsafe Storage bucket")
    safe_object_path(path, "Storage object")
    parts = [bucket, *path.split("/")]
    return "/".join(urllib.parse.quote(part, safe="._-") for part in parts)


class HttpAppBackend:
    """Small REST client whose errors never echo response bodies or secrets."""

    @staticmethod
    def _request(
        method: str, url: str, headers: dict[str, str], label: str,
        body: dict[str, Any] | None = None,
    ) -> bytes:
        data = None
        request_headers = dict(headers)
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        attempts = 4 if method == "GET" and body is None else 1
        last_error: BaseException | None = None
        for attempt in range(attempts):
            request = urllib.request.Request(
                url, data=data, headers=request_headers, method=method,
            )
            try:
                with urllib.request.urlopen(request, timeout=120) as response:
                    return response.read()
            except urllib.error.HTTPError as error:
                if not (method == "GET" and STORAGE_RUNTIME.transient_http_status(error.code)):
                    raise AppLoaderVerificationError(
                        f"{label} rejected: HTTP {error.code}"
                    ) from error
                last_error = error
            except (TimeoutError, urllib.error.URLError) as error:
                if method != "GET":
                    raise AppLoaderVerificationError(
                        f"{label} failed without a safe response"
                    ) from error
                last_error = error
            if attempt + 1 < attempts:
                time.sleep(1 << attempt)
        raise AppLoaderVerificationError(
            f"{label} failed after {attempts} safe read retries"
        ) from last_error

    @classmethod
    def _json(
        cls, method: str, url: str, headers: dict[str, str], label: str,
        body: dict[str, Any] | None = None,
    ) -> Any:
        raw = cls._request(method, url, headers, label, body)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AppLoaderVerificationError(f"{label} returned invalid JSON") from error

    @staticmethod
    def _headers(key: str, bearer: str) -> dict[str, str]:
        if not key or not bearer:
            raise AppLoaderVerificationError("Supabase credential is missing")
        return {"apikey": key, "Authorization": f"Bearer {bearer}"}

    def session(
        self, base_url: str, publishable_key: str, access_token: str,
        service_key: str,
    ) -> tuple[str, str, str]:
        if access_token:
            token, mode = access_token, "provided-user-access-token"
        else:
            if not service_key:
                raise AppLoaderVerificationError(
                    "set SUPABASE_USER_ACCESS_TOKEN or SUPABASE_SERVICE_ROLE_KEY"
                )
            service_headers = self._headers(service_key, service_key)
            rows = self._json(
                "GET",
                f"{base_url}/rest/v1/app_users?select=user_id&enabled=eq.true&order=created_at.asc&limit=1",
                service_headers,
                "approved-user lookup",
            )
            if not isinstance(rows, list) or len(rows) != 1:
                raise AppLoaderVerificationError("no enabled app user is available")
            user_id = rows[0].get("user_id") if isinstance(rows[0], dict) else None
            try:
                uuid.UUID(str(user_id))
            except (ValueError, AttributeError) as error:
                raise AppLoaderVerificationError("approved user record is invalid") from error
            user = self._json(
                "GET", f"{base_url}/auth/v1/admin/users/{user_id}", service_headers,
                "approved auth-user lookup",
            )
            email = user.get("email") if isinstance(user, dict) else None
            if not isinstance(email, str) or "@" not in email:
                raise AppLoaderVerificationError("approved auth user has no usable email")
            link = self._json(
                "POST", f"{base_url}/auth/v1/admin/generate_link", service_headers,
                "temporary magic-link generation", {"type": "magiclink", "email": email},
            )
            properties = link.get("properties") if isinstance(link, dict) else None
            token_hash = (
                link.get("hashed_token") if isinstance(link, dict) else None
            ) or (properties.get("hashed_token") if isinstance(properties, dict) else None)
            if not isinstance(token_hash, str) or len(token_hash) < 20:
                raise AppLoaderVerificationError("temporary magic-link response has no token hash")
            verified = self._json(
                "POST", f"{base_url}/auth/v1/verify", {"apikey": publishable_key},
                "temporary magic-link verification",
                {"type": "magiclink", "token_hash": token_hash},
            )
            token = verified.get("access_token") if isinstance(verified, dict) else None
            verified_user = verified.get("user") if isinstance(verified, dict) else None
            if (
                not isinstance(token, str) or len(token) < 20
                or not isinstance(verified_user, dict)
                or verified_user.get("id") != user_id
            ):
                raise AppLoaderVerificationError("temporary user session was not issued safely")
            mode = "admin-generated-one-time-magiclink"

        user = self._json(
            "GET", f"{base_url}/auth/v1/user", self._headers(publishable_key, token),
            "authenticated user verification",
        )
        user_id = user.get("id") if isinstance(user, dict) else None
        try:
            uuid.UUID(str(user_id))
        except (ValueError, AttributeError) as error:
            raise AppLoaderVerificationError("authenticated session has no valid user") from error
        approved = self._json(
            "POST", f"{base_url}/rest/v1/rpc/is_matha_user",
            self._headers(publishable_key, token), "app-user approval check",
            {"candidate": user_id},
        )
        if approved is not True:
            raise AppLoaderVerificationError("authenticated user is not enabled for matha")
        return token, mode, digest(str(user_id).encode("utf-8"))

    def create_signed_url(
        self, base_url: str, publishable_key: str, token: str,
        bucket: str, path: str,
    ) -> str:
        result = self._json(
            "POST", f"{base_url}/storage/v1/object/sign/{_quote_object(bucket, path)}",
            self._headers(publishable_key, token), "Storage signed-URL creation",
            {"expiresIn": 60},
        )
        signed = None
        if isinstance(result, dict):
            signed = result.get("signedURL") or result.get("signedUrl")
        if not isinstance(signed, str) or not signed:
            raise AppLoaderVerificationError("Storage did not return a signed URL")
        if signed.startswith("http://") or signed.startswith("https://"):
            return signed
        if signed.startswith("/storage/v1/"):
            return base_url + signed
        if signed.startswith("/object/"):
            return base_url + "/storage/v1" + signed
        return base_url + "/storage/v1/" + signed.lstrip("/")

    def fetch_signed(self, signed_url: str) -> bytes:
        return self._request("GET", signed_url, {"Cache-Control": "no-store"}, "signed object download")

    def download_authenticated(
        self, base_url: str, publishable_key: str, token: str,
        bucket: str, path: str,
    ) -> bytes:
        return self._request(
            "GET",
            f"{base_url}/storage/v1/object/authenticated/{_quote_object(bucket, path)}",
            {**self._headers(publishable_key, token), "Cache-Control": "no-store"},
            "authenticated Storage download",
        )


def _valid_bbox(value: Any) -> bool:
    if not isinstance(value, list) or len(value) != 4:
        return False
    if any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in value):
        return False
    x, y, width, height = (float(item) for item in value)
    return (
        0 <= x <= 1 and 0 <= y <= 1 and 0.01 <= width <= 1
        and 0.01 <= height <= 1 and x + width <= 1.000001
        and y + height <= 1.000001
    )


def _validate_stem_asset(question: dict[str, Any], books: dict[str, str]) -> dict[str, Any]:
    question_id = question["id"]
    asset = question.get("stemAsset")
    if question.get("needsStemAsset") is not True or not isinstance(asset, dict):
        raise AppLoaderVerificationError(f"question stem asset is missing: {question_id}")
    path = safe_object_path(asset.get("path"), "stem asset")
    if len(path) > 240 or SAFE_ASSET_PATH.fullmatch(path) is None:
        raise AppLoaderVerificationError(f"stem asset path is unsafe: {question_id}")
    asset_sha = require_sha(asset.get("sha256"), f"stem asset {question_id}")
    source_sha = require_sha(asset.get("sourcePdfSha256"), f"stem source {question_id}")
    page = question.get("page")
    book_id = question.get("bookId")
    verifier = asset.get("verifier")
    valid_verifier = (
        isinstance(verifier, dict)
        and isinstance(verifier.get("reviewVersion"), (int, float))
        and not isinstance(verifier.get("reviewVersion"), bool)
        and verifier.get("reviewVersion") >= 1
        and isinstance(verifier.get("reviewer"), str)
        and len(verifier.get("reviewer")) >= 3
        and verifier.get("reviewer") != asset.get("producer")
        and verifier.get("questionRoleVerified") is True
        and verifier.get("safetyVerified") is True
        and verifier.get("assetHashVerified") is True
        and verifier.get("fullStemVerified") is True
        and isinstance(verifier.get("verifiedAt"), str)
        and bool(verifier.get("verifiedAt"))
    )
    selection_coverage = question.get("type") == "fill" or (
        asset.get("includesOptions") is True
        and isinstance(verifier, dict) and verifier.get("optionsVerified") is True
    )
    if not (
        asset.get("assetStatus") == "verified"
        and asset.get("role") == "question-stem"
        and asset.get("containsAnswer") is False
        and asset.get("containsSolution") is False
        and asset.get("containsHandwriting") is False
        and _valid_bbox(asset.get("bbox"))
        and asset.get("mime") in {"image/webp", "image/png", "image/jpeg"}
        and isinstance(asset.get("width"), int) and not isinstance(asset.get("width"), bool)
        and asset.get("width") >= 80
        and isinstance(asset.get("height"), int) and not isinstance(asset.get("height"), bool)
        and asset.get("height") >= 40
        and isinstance(asset.get("producer"), str) and len(asset.get("producer")) >= 3
        and valid_verifier and selection_coverage
        and isinstance(book_id, str) and books.get(book_id) == source_sha
        and asset.get("bookId") == book_id
        and isinstance(page, int) and not isinstance(page, bool) and page >= 1
        and asset.get("pageIndex") == page
        and isinstance(asset.get("questionIds"), list)
        and question_id in asset.get("questionIds")
    ):
        raise AppLoaderVerificationError(f"stem asset fails App-equivalent validation: {question_id}")
    return {"path": path, "sha256": asset_sha}


def _validate_question(question: Any, books: dict[str, str]) -> dict[str, Any]:
    if not isinstance(question, dict):
        raise AppLoaderVerificationError("question entry is not an object")
    question_id = question.get("id")
    if (
        not isinstance(question_id, str) or not question_id
        or SAFE_ID.fullmatch(question_id) is None
        or question_id in {"__proto__", "constructor", "prototype"}
    ):
        raise AppLoaderVerificationError("question id is missing or unsafe")
    if question.get("topic") not in EXPECTED_TOPICS:
        raise AppLoaderVerificationError(f"question topic is invalid: {question_id}")
    if question.get("role") not in ALLOWED_ROLES:
        raise AppLoaderVerificationError(f"question role is invalid: {question_id}")
    kind = question.get("type")
    if kind not in {"single", "multi", "fill"}:
        raise AppLoaderVerificationError(f"question type is invalid: {question_id}")
    if question.get("diff") not in {1, 2, 3}:
        raise AppLoaderVerificationError(f"question difficulty is invalid: {question_id}")
    prompt = question.get("q")
    if not isinstance(prompt, str) or not prompt:
        raise AppLoaderVerificationError(f"question prompt is missing: {question_id}")
    if len(prompt) > 12000 or len(str(question.get("stem") or "")) > 12000 or len(str(question.get("sol") or "")) > 40000:
        raise AppLoaderVerificationError(f"question text is too long: {question_id}")
    answers = question.get("ans")
    if not isinstance(answers, list) or not answers:
        raise AppLoaderVerificationError(f"question answer is missing: {question_id}")
    if kind == "fill":
        if any(not isinstance(item, (str, int, float)) or isinstance(item, bool) or len(str(item)) > 1000 for item in answers):
            raise AppLoaderVerificationError(f"fill answer is invalid: {question_id}")
    else:
        options = question.get("opts")
        if not isinstance(options, list) or len(options) < 2 or any(len(str(item)) > 6000 for item in options):
            raise AppLoaderVerificationError(f"question options are invalid: {question_id}")
        if any(not isinstance(item, int) or isinstance(item, bool) or item < 0 or item >= len(options) for item in answers):
            raise AppLoaderVerificationError(f"answer index is invalid: {question_id}")
    book_id = question.get("bookId")
    if not isinstance(book_id, str) or re.fullmatch(r"[\w.-]+", book_id) is None:
        raise AppLoaderVerificationError(f"book id is invalid: {question_id}")
    page = question.get("page")
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        raise AppLoaderVerificationError(f"source page is invalid: {question_id}")
    for key in ("skills", "methods", "prerequisites"):
        value = question.get(key)
        if value is not None and (
            not isinstance(value, list) or any(not isinstance(item, str) for item in value)
        ):
            raise AppLoaderVerificationError(f"question {key} is invalid: {question_id}")
    asset = _validate_stem_asset(question, books)
    return {
        "id": question_id,
        "topic": question["topic"],
        "role": question["role"],
        "asset": asset,
    }


def _validate_release_manifest(
    manifest: dict[str, Any], trusted: dict[str, Any], release_id: str,
    expected_packs: int,
) -> list[dict[str, Any]]:
    if manifest.get("schema") != 3 or manifest.get("visibility") != "authenticated":
        raise AppLoaderVerificationError("manifest schema or visibility is invalid")
    if manifest.get("releaseId") != release_id or manifest.get("releaseReady") is not True:
        raise AppLoaderVerificationError("manifest release binding is invalid")
    for key in (
        "corpusGeneration", "sourceInventorySha256", "sourceDocuments", "sourcePages",
        "ocrProvider", "ocrModel", "verificationPolicy",
    ):
        if manifest.get(key) != trusted[key]:
            raise AppLoaderVerificationError(f"manifest trust policy drift: {key}")
    if manifest.get("mathematicalCorrectnessVerified") is not True:
        raise AppLoaderVerificationError("manifest mathematical verification is missing")
    checks = manifest.get("releaseChecks")
    if not isinstance(checks, dict) or not checks or not all(value is True for value in checks.values()):
        raise AppLoaderVerificationError("manifest release checks are not all true")
    approved_by = manifest.get("releaseApprovedBy")
    if not isinstance(approved_by, str) or len(approved_by.strip()) < 3 or NON_HUMAN.search(approved_by):
        raise AppLoaderVerificationError("manifest release authorization is invalid")
    if manifest.get("reviewPolicy") == "owner-delegated-agent-direct-pixel-v1":
        approval = manifest.get("releaseApproval")
        if not isinstance(approval, dict):
            raise AppLoaderVerificationError("delegated approval chain is missing")
        version = approval.get("version")
        hashes = approval.get("delegatedReviewSha256")
        if not isinstance(hashes, list):
            hashes = [hashes]
        hashes_valid = (
            ((version == 1 and len(hashes) == 1) or (version == 2 and len(hashes) >= 2))
            and all(isinstance(value, str) and SAFE_SHA.fullmatch(value) for value in hashes)
        )
        if not (
            approval.get("kind") == "owner-delegated-agent-starter-private-release-signoff"
            and hashes_valid
            and approval.get("authorizedBy") == approved_by
            and isinstance(approval.get("performedBy"), str)
            and NON_HUMAN.search(approval.get("performedBy"))
            and approval.get("humanPixelReviewClaimed") is False
            and isinstance(approval.get("sampleQuestionIds"), list)
            and bool(approval.get("sampleQuestionIds"))
        ):
            raise AppLoaderVerificationError("delegated approval chain is invalid")
    packs = manifest.get("packs")
    if not isinstance(packs, list) or len(packs) != expected_packs:
        raise AppLoaderVerificationError(f"manifest must contain exactly {expected_packs} packs")
    pack_ids = set()
    for pack in packs:
        if not isinstance(pack, dict):
            raise AppLoaderVerificationError("manifest pack entry is invalid")
        pack_id = pack.get("id")
        if not isinstance(pack_id, str) or re.fullmatch(r"curated-[\w-]+", pack_id) is None or pack_id in pack_ids:
            raise AppLoaderVerificationError("manifest pack id is unsafe or duplicated")
        pack_ids.add(pack_id)
        safe_object_path(pack.get("file"), "question pack")
        require_sha(pack.get("sha256"), f"question pack {pack_id}")
        if not isinstance(pack.get("count"), int) or isinstance(pack.get("count"), bool) or pack.get("count") < 1:
            raise AppLoaderVerificationError(f"manifest pack count is invalid: {pack_id}")
    pending = manifest.get("pendingVisuals")
    if not isinstance(pending, dict) or pending.get("count") != 0:
        raise AppLoaderVerificationError("manifest must have zero pending visuals")
    safe_object_path(pending.get("file"), "pending visuals")
    require_sha(pending.get("sha256"), "pending visuals")
    return packs


def _resolve_runtime_evidence(
    runtime_file: Path, supplied: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve a v2 current pointer without allowing its evidence to drift."""
    pointer_fields = {"recordRole", "immutableRecord", "immutableRecordSha256"}
    if supplied.get("recordRole") == "current-pointer":
        name = supplied.get("immutableRecord")
        immutable_sha = require_sha(
            supplied.get("immutableRecordSha256"), "runtime immutable evidence"
        )
        if (
            not isinstance(name, str) or not name or Path(name).name != name
            or name in {".", "..", runtime_file.name}
        ):
            raise AppLoaderVerificationError("runtime immutable record name is unsafe")
        immutable_file = runtime_file.with_name(name)
        immutable = load_json(immutable_file, "runtime immutable evidence")
        if sha256(immutable_file) != immutable_sha:
            raise AppLoaderVerificationError("runtime immutable record hash drift")
        if any(key in immutable for key in pointer_fields):
            raise AppLoaderVerificationError("runtime immutable evidence contains pointer fields")
        expected_pointer = {
            **immutable,
            "recordRole": "current-pointer",
            "immutableRecord": name,
            "immutableRecordSha256": immutable_sha,
        }
        if supplied != expected_pointer:
            raise AppLoaderVerificationError("runtime current pointer differs from immutable evidence")
        return immutable, {
            "currentPointerSha256": sha256(runtime_file),
            "immutableRecord": name,
            "immutableRecordSha256": immutable_sha,
        }
    raise AppLoaderVerificationError(
        "runtime loader gate requires the current pointer bound to immutable evidence"
    )


def _validate_runtime_binding(
    record: dict[str, Any], plan_file: Path,
    deployment_file: Path, release_id: str, app: dict[str, str],
    alias_sha: str,
) -> None:
    if (
        record.get("kind") != "matha-private-release-runtime-verification"
        or record.get("version") != 2 or record.get("status") != "verified"
    ):
        raise AppLoaderVerificationError("storage runtime record is not verified v2 evidence")
    source_path = Path(str(load_json(plan_file, "upload plan").get("source") or ""))
    if not source_path.is_absolute():
        source_path = plan_file.resolve().parent / source_path
    if not source_path.is_file():
        raise AppLoaderVerificationError("signed source bound by the runtime evidence is missing")
    signed_source_sha = sha256(source_path)
    plan = load_json(plan_file, "upload plan")
    question_count, pack_count, versioned_count = _plan_counts(plan)
    if plan.get("sourceSha256") != signed_source_sha:
        raise AppLoaderVerificationError("upload plan signed-source hash drift")
    expected = {
        "releaseId": release_id,
        "uploadPlanSha256": sha256(plan_file),
        "deploymentRecordSha256": sha256(deployment_file),
        "signedSourceSha256": signed_source_sha,
        "aliasSha256": alias_sha,
        "appVersion": app["appVersion"],
        "appJsSha256": app["appJsSha256"],
        "textbookCatalogSha256": app["textbookCatalogSha256"],
    }
    for key, value in expected.items():
        if record.get(key) != value:
            raise AppLoaderVerificationError(f"storage runtime binding drift: {key}")
    if record.get("projectUrl") != app["projectUrl"]:
        raise AppLoaderVerificationError("storage runtime project URL drift")
    require_sha(record.get("versionedObjectSetSha256"), "storage runtime object set")
    try:
        STORAGE_RUNTIME.parse_aware_timestamp(
            record.get("verifiedAt"), "storage runtime verification"
        )
    except STORAGE_RUNTIME.RuntimeVerificationError as error:
        raise AppLoaderVerificationError(str(error)) from error
    content = record.get("content")
    readback = record.get("readback")
    roles = content.get("roles") if isinstance(content, dict) else None
    if (not isinstance(content, dict)
            or content.get("questions") != question_count
            or content.get("packs") != pack_count
            or not isinstance(roles, dict) or set(roles) != set(EXPECTED_ROLES)
            or any(not isinstance(value, int) or isinstance(value, bool) or value < 0
                   for value in roles.values())
            or sum(roles.values()) != question_count):
        raise AppLoaderVerificationError("storage runtime content summary is invalid")
    topics = content.get("topics")
    if (not isinstance(topics, dict) or set(topics) != EXPECTED_TOPICS
            or any(not isinstance(value, int) or isinstance(value, bool) or value < 1
                   for value in topics.values())
            or sum(topics.values()) != question_count):
        raise AppLoaderVerificationError("storage runtime topic summary is invalid")
    if not isinstance(readback, dict) or (
        readback.get("versionedObjects") != versioned_count
        or readback.get("hashMismatches") != 0
        or readback.get("missingObjects") != 0
    ):
        raise AppLoaderVerificationError("storage runtime readback summary is invalid")
    answer_modes = content.get("answerModes")
    if (
        not isinstance(answer_modes, dict) or not answer_modes
        or not set(answer_modes).issubset({"text", "single", "multi"})
        or any(not isinstance(value, int) or isinstance(value, bool) or value < 0
               for value in answer_modes.values())
        or sum(answer_modes.values()) != question_count
        or content.get("answersVerifiedAgainstSignedSource") != question_count
        or content.get("pendingVisuals") != 0
    ):
        raise AppLoaderVerificationError("storage runtime answer evidence summary is invalid")
    trust = record.get("trust")
    if not isinstance(trust, dict):
        raise AppLoaderVerificationError("storage runtime trust summary is missing")
    for key, value in STORAGE_RUNTIME.EXPECTED_CORPUS.items():
        if trust.get(key) != value:
            raise AppLoaderVerificationError(f"storage runtime trust drift: {key}")
    if trust.get("reviewPolicy") != STORAGE_RUNTIME.EXPECTED_REVIEW_POLICY:
        raise AppLoaderVerificationError("storage runtime review policy drift")
    owner = trust.get("releaseApprovedBy")
    if (
        owner != plan.get("releaseApprovedBy") or not isinstance(owner, str)
        or len(owner.strip()) < 3 or NON_HUMAN.search(owner)
    ):
        raise AppLoaderVerificationError("storage runtime release owner is invalid")
    for key in (
        "signedSourceQuestionSetSha256", "answerEvidenceSetSha256",
        "authorizationChainSha256",
    ):
        require_sha(trust.get(key), f"storage runtime {key}")
    chain = trust.get("authorizationChain")
    expected_chain_fields = {
        "owner", "reviewer", "delegations", "directReviewSha256",
        "dualReviewSha256", "selectionSha256", "unsignedSourceSha256",
        "assetManifestSha256", "providedDirectReviewFiles", "evidenceFiles",
    }
    if not isinstance(chain, dict) or set(chain) != expected_chain_fields:
        raise AppLoaderVerificationError("storage runtime authorization chain is invalid")
    direct = chain.get("directReviewSha256")
    dual = chain.get("dualReviewSha256")
    if not (
        chain.get("owner") == owner
        and isinstance(chain.get("reviewer"), str) and NON_HUMAN.search(chain["reviewer"])
        and isinstance(chain.get("delegations"), int) and chain["delegations"] >= 1
        and isinstance(direct, list) and direct
        and isinstance(dual, list) and len(dual) == len(direct)
        and all(isinstance(value, str) and SAFE_SHA.fullmatch(value)
                for value in [*direct, *dual])
        and isinstance(chain.get("providedDirectReviewFiles"), int)
        and chain["providedDirectReviewFiles"] == len(direct)
    ):
        raise AppLoaderVerificationError("storage runtime authorization chain is invalid")
    evidence_files = chain.get("evidenceFiles")
    if not isinstance(evidence_files, dict) or set(evidence_files) != {
        "directReviews", "dualReviews", "answerBindings",
    }:
        raise AppLoaderVerificationError("storage runtime evidence-file chain is invalid")
    direct_files = evidence_files.get("directReviews")
    dual_files = evidence_files.get("dualReviews")
    answer_files = evidence_files.get("answerBindings")
    delegations = chain["delegations"]
    if not (
        isinstance(direct_files, list) and len(direct_files) == delegations
        and isinstance(dual_files, list) and len(dual_files) == delegations
        and isinstance(answer_files, list) and len(answer_files) == delegations
    ):
        raise AppLoaderVerificationError("storage runtime evidence-file chain is invalid")

    def evidence_path(row: Any, expected_fields: set[str], label: str) -> Path:
        if not isinstance(row, dict) or set(row) != expected_fields:
            raise AppLoaderVerificationError(f"storage runtime {label} evidence is invalid")
        path = Path(str(row.get("path") or ""))
        if not path.is_absolute() or not path.is_file() or path.name != row.get("name"):
            raise AppLoaderVerificationError(f"storage runtime {label} evidence is invalid")
        try:
            path.resolve().relative_to(REPO_ROOT.resolve())
        except ValueError:
            pass
        else:
            raise AppLoaderVerificationError(f"storage runtime {label} evidence entered Git")
        if require_sha(row.get("sha256"), label) != sha256(path):
            raise AppLoaderVerificationError(f"storage runtime {label} evidence hash drift")
        return path

    review_fields = {"name", "path", "sha256"}
    for index, row in enumerate(direct_files):
        evidence_path(row, review_fields, "direct review")
        if row["sha256"] != direct[index]:
            raise AppLoaderVerificationError("storage runtime direct-review chain drift")
    for index, row in enumerate(dual_files):
        evidence_path(row, review_fields, "dual review")
        if row["sha256"] != dual[index]:
            raise AppLoaderVerificationError("storage runtime dual-review chain drift")
    answer_count = 0
    for row in answer_files:
        evidence_path(row, {
            "name", "path", "sha256", "answerAssetRoot",
            "answerAssetCount", "answerAssetSetSha256",
        }, "answer binding")
        asset_root = Path(str(row.get("answerAssetRoot") or ""))
        if not asset_root.is_absolute() or not asset_root.is_dir():
            raise AppLoaderVerificationError("storage runtime answer-asset root is invalid")
        try:
            asset_root.resolve().relative_to(REPO_ROOT.resolve())
        except ValueError:
            pass
        else:
            raise AppLoaderVerificationError("storage runtime answer assets entered Git")
        count = row.get("answerAssetCount")
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise AppLoaderVerificationError("storage runtime answer-asset count is invalid")
        require_sha(row.get("answerAssetSetSha256"), "answer-asset set")
        answer_count += count
    if answer_count != question_count:
        raise AppLoaderVerificationError(
            "storage runtime answer bindings do not cover every signed question"
        )
    for key in ("selectionSha256", "unsignedSourceSha256", "assetManifestSha256"):
        require_sha(chain.get(key), f"storage runtime authorization {key}")
    if trust["authorizationChainSha256"] != digest(json.dumps(
        chain, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")):
        raise AppLoaderVerificationError("storage runtime authorization-chain hash drift")
    binding = {
        key: record.get(key) for key in (
            "releaseId", "uploadPlanSha256", "deploymentRecordSha256",
            "signedSourceSha256", "aliasSha256", "versionedObjectSetSha256",
            "appVersion", "appJsSha256", "textbookCatalogSha256",
        )
    }
    expected_binding = digest(json.dumps(
        binding, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8"))
    if record.get("releaseAppBindingSha256") != expected_binding:
        raise AppLoaderVerificationError("storage runtime release/App binding is invalid")


def _signed_source_question_set(
    plan_file: Path, plan: dict[str, Any], release_id: str,
    runtime_record: dict[str, Any],
) -> dict[str, Any]:
    question_count, _pack_count, _versioned_count = _plan_counts(plan)
    source_path = Path(str(plan.get("source") or ""))
    if not source_path.is_absolute():
        source_path = plan_file.resolve().parent / source_path
    source = load_json(source_path, "signed question source")
    if (
        source.get("kind") != "private-question-source"
        or source.get("releaseId") != release_id
        or sha256(source_path) != plan.get("sourceSha256")
    ):
        raise AppLoaderVerificationError("signed question source binding is invalid")
    questions = source.get("questions")
    if not isinstance(questions, list) or len(questions) != question_count:
        raise AppLoaderVerificationError(
            f"signed question source must contain exactly {question_count} questions"
        )
    ids: list[str] = []
    for question in questions:
        question_id = question.get("id") if isinstance(question, dict) else None
        if (
            not isinstance(question_id, str) or not question_id
            or SAFE_ID.fullmatch(question_id) is None
            or question_id in {"__proto__", "constructor", "prototype"}
            or question_id in ids
        ):
            raise AppLoaderVerificationError(
                "signed question source contains an unsafe or duplicate question id"
            )
        ids.append(question_id)
    question_set_sha = canonical_sha(questions)
    trust = runtime_record.get("trust")
    if (
        not isinstance(trust, dict)
        or trust.get("signedSourceQuestionSetSha256") != question_set_sha
    ):
        raise AppLoaderVerificationError(
            "signed question source does not match storage runtime evidence"
        )
    ordered_ids = sorted(ids)
    return {
        "questions": question_count,
        "questionIds": ordered_ids,
        "questionIdsSha256": canonical_sha(ordered_ids),
        "sourceQuestionsSha256": question_set_sha,
        "loaderQuestionIdsMatched": True,
    }


def app_loader_evidence_sha(record: dict[str, Any]) -> str:
    missing = [field for field in EVIDENCE_DIGEST_FIELDS if field not in record]
    if missing:
        raise AppLoaderVerificationError(
            f"App-loader evidence is missing digest fields: {', '.join(missing)}"
        )
    return canonical_sha({field: record[field] for field in EVIDENCE_DIGEST_FIELDS})


def _validated_evidence_ids(value: Any, label: str, count: int) -> list[str]:
    if (
        not isinstance(value, list) or len(value) != count
        or value != sorted(value) or len(set(value)) != count
        or any(
            not isinstance(item, str) or SAFE_ID.fullmatch(item) is None
            or item in {"__proto__", "constructor", "prototype"}
            for item in value
        )
    ):
        raise AppLoaderVerificationError(f"{label} question ids are invalid")
    return value


def validate_app_loader_evidence(record: dict[str, Any]) -> None:
    """Recompute and semantically validate a saved App-loader evidence record."""
    if (
        not isinstance(record, dict)
        or record.get("kind") != "matha-private-app-loader-verification"
        or record.get("version") != 1
        or record.get("status") != "verified"
    ):
        raise AppLoaderVerificationError("App-loader evidence header is invalid")
    meta = record.get("evidenceDigest")
    if (
        not isinstance(meta, dict)
        or set(meta) != {"algorithm", "canonicalization", "fields", "sha256"}
        or meta.get("algorithm") != "SHA-256"
        or meta.get("canonicalization") != EVIDENCE_CANONICALIZATION
        or meta.get("fields") != list(EVIDENCE_DIGEST_FIELDS)
        or meta.get("sha256") != app_loader_evidence_sha(record)
    ):
        raise AppLoaderVerificationError("App-loader evidence digest drift")

    authentication = record.get("authentication")
    if (
        not isinstance(authentication, dict)
        or set(authentication) != {
            "mode", "realUserSession", "appUserEnabled", "userIdSha256",
            "serviceRoleUsedForSession", "serviceRoleUsedForStorage",
            "credentialsSerialized",
        }
        or authentication.get("mode") not in {
            "provided-user-access-token", "admin-generated-one-time-magiclink",
        }
        or authentication.get("realUserSession") is not True
        or authentication.get("appUserEnabled") is not True
        or require_sha(authentication.get("userIdSha256"), "authenticated user")
        != authentication.get("userIdSha256")
        or authentication.get("serviceRoleUsedForSession")
        is not (authentication.get("mode") == "admin-generated-one-time-magiclink")
        or authentication.get("serviceRoleUsedForStorage") is not False
        or authentication.get("credentialsSerialized") is not False
    ):
        raise AppLoaderVerificationError("App-loader authentication evidence is invalid")

    source = record.get("signedSourceQuestionSet")
    if not isinstance(source, dict) or set(source) != {
        "questions", "questionIds", "questionIdsSha256",
        "sourceQuestionsSha256", "loaderQuestionIdsMatched",
    }:
        raise AppLoaderVerificationError("signed-source question-set evidence is invalid")
    question_count = source.get("questions")
    if (not isinstance(question_count, int) or isinstance(question_count, bool)
            or question_count < 1):
        raise AppLoaderVerificationError("signed-source question count is invalid")
    source_ids = _validated_evidence_ids(
        source.get("questionIds"), "signed-source", question_count,
    )
    if (
        source.get("questionIdsSha256") != canonical_sha(source_ids)
        or require_sha(source.get("sourceQuestionsSha256"), "signed-source questions")
        != source.get("sourceQuestionsSha256")
        or source.get("loaderQuestionIdsMatched") is not True
    ):
        raise AppLoaderVerificationError("signed-source question-set evidence is invalid")

    loader = record.get("loader")
    if not isinstance(loader, dict):
        raise AppLoaderVerificationError("App-loader result is missing")
    pack_count = loader.get("packs")
    if (not isinstance(pack_count, int) or isinstance(pack_count, bool)
            or pack_count < 1):
        raise AppLoaderVerificationError("App-loader pack count is invalid")
    loaded_ids = _validated_evidence_ids(
        loader.get("questionIds"), "App-loaded", question_count,
    )
    packs = loader.get("packObjects")
    if not isinstance(packs, list) or len(packs) != pack_count:
        raise AppLoaderVerificationError("App-loader pack readback evidence is invalid")
    pack_ids: set[str] = set()
    pack_paths: set[str] = set()
    loaded_count = 0
    for row in packs:
        if not isinstance(row, dict) or set(row) != {
            "id", "path", "sha256", "bytes", "questionCount",
        }:
            raise AppLoaderVerificationError("App-loader pack readback evidence is invalid")
        pack_id = row.get("id")
        path = row.get("path")
        if (
            not isinstance(pack_id, str) or pack_id in pack_ids
            or not isinstance(path, str) or path in pack_paths
            or safe_object_path(path, "question pack") != path
            or require_sha(row.get("sha256"), f"question pack {pack_id}")
            != row.get("sha256")
            or not isinstance(row.get("bytes"), int) or isinstance(row.get("bytes"), bool)
            or row.get("bytes") < 1
            or not isinstance(row.get("questionCount"), int)
            or isinstance(row.get("questionCount"), bool) or row.get("questionCount") < 1
        ):
            raise AppLoaderVerificationError("App-loader pack readback evidence is invalid")
        pack_ids.add(pack_id)
        pack_paths.add(path)
        loaded_count += row["questionCount"]
    topics = loader.get("topics")
    if (
        loader.get("alias") != EXPECTED_ALIAS
        or loader.get("aliasRoute") != "authenticated-jwt-signed-url"
        or loader.get("packRoute") != "authenticated-jwt-storage-rls"
        or loader.get("packHashMismatches") != 0
        or loader.get("questions") != question_count
        or loader.get("questionSchemaFailures") != 0
        or loader.get("quarantinedQuestions") != 0
        or loader.get("questionIdsSha256") != canonical_sha(loaded_ids)
        or loader.get("signedSourceQuestionIdsMatched") is not True
        or loaded_ids != source_ids
        or loaded_count != question_count
        or loader.get("packObjectSetSha256") != canonical_sha(packs)
        or not isinstance(topics, dict) or set(topics) != EXPECTED_TOPICS
        or any(not isinstance(value, int) or isinstance(value, bool) or value < 1
               for value in topics.values())
        or sum(topics.values()) != question_count
        or not isinstance(loader.get("roles"), dict)
        or set(loader["roles"]) != set(EXPECTED_ROLES)
        or any(not isinstance(value, int) or isinstance(value, bool) or value < 0
               for value in loader["roles"].values())
        or sum(loader["roles"].values()) != question_count
    ):
        raise AppLoaderVerificationError("App-loader result is invalid")

    readback = record.get("stemAssetReadback")
    if not isinstance(readback, dict):
        raise AppLoaderVerificationError("full stem-asset RLS evidence is missing")
    readback_ids = _validated_evidence_ids(
        readback.get("questionIds"), "full stem-asset RLS", question_count,
    )
    objects = readback.get("objects")
    if not isinstance(objects, list) or len(objects) != question_count:
        raise AppLoaderVerificationError("full stem-asset RLS evidence is invalid")
    object_ids: list[str] = []
    object_paths: set[str] = set()
    for row in objects:
        if not isinstance(row, dict) or set(row) != {
            "questionId", "path", "sha256", "bytes",
        }:
            raise AppLoaderVerificationError("full stem-asset RLS evidence is invalid")
        question_id = row.get("questionId")
        path = row.get("path")
        if (
            not isinstance(question_id, str) or question_id in object_ids
            or not isinstance(path, str) or path in object_paths
            or safe_object_path(path, "stem asset") != path
            or require_sha(row.get("sha256"), f"stem asset {question_id}")
            != row.get("sha256")
            or not isinstance(row.get("bytes"), int) or isinstance(row.get("bytes"), bool)
            or row.get("bytes") < 1
        ):
            raise AppLoaderVerificationError("full stem-asset RLS evidence is invalid")
        object_ids.append(question_id)
        object_paths.add(path)
    if (
        readback.get("route") != "authenticated-jwt-storage-rls"
        or readback.get("count") != question_count
        or readback.get("authenticatedRlsDownloads") != question_count
        or readback.get("missingObjects") != 0
        or readback.get("hashMismatches") != 0
        or readback.get("questionIdsSha256") != canonical_sha(readback_ids)
        or readback.get("questionIdsBoundToSignedSource") is not True
        or readback_ids != source_ids or sorted(object_ids) != source_ids
        or readback.get("objectSetSha256") != canonical_sha(objects)
    ):
        raise AppLoaderVerificationError("full stem-asset RLS evidence is invalid")

    sample = record.get("stemAssetSample")
    if not isinstance(sample, dict):
        raise AppLoaderVerificationError("signed stem-asset sample evidence is missing")
    count = sample.get("count")
    if not isinstance(count, int) or isinstance(count, bool) or count < len(EXPECTED_TOPICS):
        raise AppLoaderVerificationError("signed stem-asset sample evidence is invalid")
    sample_ids = _validated_evidence_ids(sample.get("questionIds"), "stem sample", count)
    sample_objects = sample.get("objects")
    if not isinstance(sample_objects, list) or len(sample_objects) != count:
        raise AppLoaderVerificationError("signed stem-asset sample evidence is invalid")
    full_by_id = {row["questionId"]: row for row in objects}
    for row in sample_objects:
        if (
            not isinstance(row, dict) or set(row) != {
                "questionId", "path", "sha256", "bytes",
            }
            or row.get("questionId") not in full_by_id
            or row != full_by_id[row["questionId"]]
        ):
            raise AppLoaderVerificationError(
                "signed stem-asset sample is not bound to full RLS readback"
            )
    if (
        [row["questionId"] for row in sample_objects] != sample_ids
        or any(question_id not in source_ids for question_id in sample_ids)
        or sample.get("questionIdsSha256") != canonical_sha(sample_ids)
        or sample.get("questionIdsBoundToSignedSource") is not True
        or sample.get("coveredTopics") != sorted(EXPECTED_TOPICS)
        or sample.get("coveredRoles") != sorted(loader["roles"])
        or sample.get("authenticatedRlsDownloads") != count
        or sample.get("signedUrlRoute") != "authenticated-jwt-signed-url"
        or sample.get("signedUrlCrossChecks") != count
        or sample.get("hashMismatches") != 0
        or sample.get("objectSetSha256") != canonical_sha(sample_objects)
    ):
        raise AppLoaderVerificationError("signed stem-asset sample evidence is invalid")


def _sample_covering_assets(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    missing_topics = set(EXPECTED_TOPICS)
    missing_roles = set(EXPECTED_ROLES)
    selected: list[dict[str, Any]] = []
    for question in questions:
        if question["topic"] in missing_topics or question["role"] in missing_roles:
            selected.append(question)
            missing_topics.discard(question["topic"])
            missing_roles.discard(question["role"])
        if not missing_topics and not missing_roles:
            break
    if missing_topics or missing_roles:
        raise AppLoaderVerificationError("stem sample cannot cover every topic and role")
    return selected


def verify_app_loader(
    plan_file: Path, deployment_file: Path, runtime_file: Path, output_file: Path,
    base_url: str = "", publishable_key: str = "", access_token: str = "",
    service_key: str = "", backend: Any | None = None,
) -> dict[str, Any]:
    """Run a fail-closed authenticated loader smoke test and write its attestation."""
    output_file = outside_repo(output_file)
    app = _app_identity()
    base_url = (base_url or app["projectUrl"]).rstrip("/")
    publishable_key = publishable_key or app["publishableKey"]
    if base_url != app["projectUrl"]:
        raise AppLoaderVerificationError("Supabase URL does not match app.js")
    if not publishable_key:
        raise AppLoaderVerificationError("Supabase publishable key is missing")
    plan = load_json(plan_file, "upload plan")
    question_count, pack_count, _versioned_count = _plan_counts(plan)
    deployment = load_json(deployment_file, "deployment record")
    runtime_pointer = load_json(runtime_file, "storage runtime record")
    runtime_record, runtime_artifact = _resolve_runtime_evidence(
        runtime_file, runtime_pointer
    )
    try:
        release_id, alias_path, versioned, alias_row = STORAGE_RUNTIME._plan_rows(plan)
        STORAGE_RUNTIME._validate_deployment(
            deployment, plan_file, release_id, base_url, versioned, alias_row
        )
    except STORAGE_RUNTIME.RuntimeVerificationError as error:
        raise AppLoaderVerificationError(str(error)) from error
    _validate_runtime_binding(
        runtime_record, plan_file, deployment_file,
        release_id, app, alias_row["sha256"],
    )
    signed_source_questions = _signed_source_question_set(
        plan_file, plan, release_id, runtime_record,
    )
    signed_source_ids = set(signed_source_questions["questionIds"])
    trusted, books = _catalog_identity()
    if trusted["manifestAlias"] != EXPECTED_ALIAS or alias_path != EXPECTED_ALIAS:
        raise AppLoaderVerificationError("App and release do not share the fixed alias")
    backend = backend or HttpAppBackend()
    token, auth_mode, user_id_sha = backend.session(
        base_url, publishable_key, access_token, service_key
    )
    require_sha(user_id_sha, "authenticated user")

    alias_url = backend.create_signed_url(
        base_url, publishable_key, token, "matha-content", alias_path
    )
    alias_bytes = backend.fetch_signed(alias_url)
    if len(alias_bytes) != alias_row["bytes"] or digest(alias_bytes) != alias_row["sha256"]:
        raise AppLoaderVerificationError("signed manifest alias drift")
    manifest = parse_json_bytes(alias_bytes, "signed manifest alias")
    packs = _validate_release_manifest(manifest, trusted, release_id, pack_count)

    row_map = {(row["bucket"], row["path"]): row for row in versioned}
    expected_pack_paths = {
        row["path"] for row in versioned
        if row["bucket"] == "matha-content" and "/content/" in row["path"]
        and not row["path"].endswith("/pending-visuals.json")
    }
    manifest_pack_paths = {pack["file"] for pack in packs}
    if manifest_pack_paths != expected_pack_paths:
        raise AppLoaderVerificationError("manifest pack set does not match the upload plan")

    questions: list[dict[str, Any]] = []
    question_ids: set[str] = set()
    topic_counts: Counter[str] = Counter()
    role_counts: Counter[str] = Counter()
    figure_paths: set[str] = set()
    pack_readbacks: list[dict[str, Any]] = []
    for pack in packs:
        path = pack["file"]
        row = row_map.get(("matha-content", path))
        if row is None or row["sha256"] != pack["sha256"] or row["bytes"] < 1:
            raise AppLoaderVerificationError(f"question pack plan binding is invalid: {path}")
        data = backend.download_authenticated(
            base_url, publishable_key, token, "matha-content", path
        )
        if len(data) != row["bytes"] or digest(data) != row["sha256"]:
            raise AppLoaderVerificationError(f"question pack drift: {path}")
        payload = parse_json_bytes(data, f"question pack {path}")
        items = payload.get("items")
        if payload.get("kind") != "qpack" or payload.get("version") != 2 or not isinstance(items, list):
            raise AppLoaderVerificationError(f"question pack structure is invalid: {path}")
        if len(items) != pack["count"]:
            raise AppLoaderVerificationError(f"question pack count drift: {path}")
        pack_readbacks.append({
            "id": pack["id"],
            "path": path,
            "sha256": row["sha256"],
            "bytes": len(data),
            "questionCount": len(items),
        })
        for item in items:
            validated = _validate_question(item, books)
            if validated["id"] in question_ids:
                raise AppLoaderVerificationError(f"duplicate question id: {validated['id']}")
            question_ids.add(validated["id"])
            topic_counts[validated["topic"]] += 1
            role_counts[validated["role"]] += 1
            figure_path = validated["asset"]["path"]
            figure_row = row_map.get(("matha-figures", figure_path))
            if (
                figure_path in figure_paths or figure_row is None
                or figure_row["sha256"] != validated["asset"]["sha256"]
                or figure_row.get("questionId") != validated["id"]
            ):
                raise AppLoaderVerificationError(
                    f"stem asset plan binding is invalid: {validated['id']}"
                )
            figure_paths.add(figure_path)
            questions.append(validated)

    if (len(questions) != question_count
            or sum(pack["count"] for pack in packs) != question_count):
        raise AppLoaderVerificationError(
            f"release must contain exactly {question_count} questions"
        )
    if question_ids != signed_source_ids:
        raise AppLoaderVerificationError(
            "App-loaded question ids do not match the signed question source"
        )
    if set(topic_counts) != EXPECTED_TOPICS:
        raise AppLoaderVerificationError("14-topic distribution is invalid")
    if dict(sorted(topic_counts.items())) != runtime_record["content"]["topics"]:
        raise AppLoaderVerificationError("App-loaded topics differ from storage runtime evidence")
    if dict(role_counts) != runtime_record["content"]["roles"]:
        raise AppLoaderVerificationError("App-loaded roles differ from storage runtime evidence")
    expected_figures = {
        row["path"] for row in versioned if row["bucket"] == "matha-figures"
    }
    if figure_paths != expected_figures:
        raise AppLoaderVerificationError("question set does not reference every released stem asset exactly once")

    stem_readbacks: list[dict[str, Any]] = []
    for question in sorted(questions, key=lambda item: item["id"]):
        path = question["asset"]["path"]
        expected_sha = question["asset"]["sha256"]
        row = row_map[("matha-figures", path)]
        direct = backend.download_authenticated(
            base_url, publishable_key, token, "matha-figures", path
        )
        if len(direct) != row["bytes"] or digest(direct) != expected_sha:
            raise AppLoaderVerificationError(
                f"authenticated stem asset drift: {question['id']}"
            )
        stem_readbacks.append({
            "questionId": question["id"],
            "path": path,
            "sha256": expected_sha,
            "bytes": len(direct),
        })

    samples = sorted(_sample_covering_assets(questions), key=lambda item: item["id"])
    readback_by_id = {row["questionId"]: row for row in stem_readbacks}
    sample_readbacks: list[dict[str, Any]] = []
    for question in samples:
        path = question["asset"]["path"]
        expected_sha = question["asset"]["sha256"]
        signed_url = backend.create_signed_url(
            base_url, publishable_key, token, "matha-figures", path
        )
        signed = backend.fetch_signed(signed_url)
        direct_result = readback_by_id[question["id"]]
        if len(signed) != direct_result["bytes"] or digest(signed) != expected_sha:
            raise AppLoaderVerificationError(f"signed stem asset drift: {question['id']}")
        sample_readbacks.append(dict(direct_result))

    runtime_sha = sha256(runtime_file)
    binding = {
        "releaseId": release_id,
        "uploadPlanSha256": sha256(plan_file),
        "deploymentRecordSha256": sha256(deployment_file),
        "storageRuntimeRecordSha256": runtime_sha,
        "storageRuntimeCurrentPointerSha256": runtime_artifact["currentPointerSha256"],
        "storageRuntimeImmutableRecord": runtime_artifact["immutableRecord"],
        "storageRuntimeImmutableRecordSha256": runtime_artifact["immutableRecordSha256"],
        "storageRuntimeBindingSha256": runtime_record["releaseAppBindingSha256"],
        "signedSourceSha256": runtime_record["signedSourceSha256"],
        "aliasSha256": alias_row["sha256"],
        "appVersion": app["appVersion"],
        "appJsSha256": app["appJsSha256"],
        "textbookCatalogSha256": app["textbookCatalogSha256"],
        "projectUrl": base_url,
    }
    result = {
        "kind": "matha-private-app-loader-verification",
        "version": 1,
        "status": "verified",
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        **binding,
        "appLoaderBindingSha256": canonical_sha(binding),
        "authentication": {
            "mode": auth_mode,
            "realUserSession": True,
            "appUserEnabled": True,
            "userIdSha256": user_id_sha,
            "serviceRoleUsedForSession": (
                auth_mode == "admin-generated-one-time-magiclink"
            ),
            "serviceRoleUsedForStorage": False,
            "credentialsSerialized": False,
        },
        "signedSourceQuestionSet": signed_source_questions,
        "loader": {
            "alias": alias_path,
            "aliasRoute": "authenticated-jwt-signed-url",
            "packs": pack_count,
            "packRoute": "authenticated-jwt-storage-rls",
            "packHashMismatches": 0,
            "packObjects": pack_readbacks,
            "packObjectSetSha256": canonical_sha(pack_readbacks),
            "questions": question_count,
            "questionIds": sorted(question_ids),
            "questionIdsSha256": canonical_sha(sorted(question_ids)),
            "signedSourceQuestionIdsMatched": True,
            "questionSchemaFailures": 0,
            "quarantinedQuestions": 0,
            "topics": dict(sorted(topic_counts.items())),
            "roles": dict(role_counts),
        },
        "stemAssetReadback": {
            "route": "authenticated-jwt-storage-rls",
            "count": question_count,
            "questionIds": sorted(question_ids),
            "questionIdsSha256": canonical_sha(sorted(question_ids)),
            "questionIdsBoundToSignedSource": True,
            "authenticatedRlsDownloads": question_count,
            "missingObjects": 0,
            "hashMismatches": 0,
            "objects": stem_readbacks,
            "objectSetSha256": canonical_sha(stem_readbacks),
        },
        "stemAssetSample": {
            "count": len(samples),
            "questionIds": [question["id"] for question in samples],
            "questionIdsSha256": canonical_sha(
                [question["id"] for question in samples]
            ),
            "questionIdsBoundToSignedSource": True,
            "coveredTopics": sorted({question["topic"] for question in samples}),
            "coveredRoles": sorted({question["role"] for question in samples}),
            "authenticatedRlsDownloads": len(samples),
            "signedUrlRoute": "authenticated-jwt-signed-url",
            "signedUrlCrossChecks": len(samples),
            "hashMismatches": 0,
            "objects": sample_readbacks,
            "objectSetSha256": canonical_sha(sample_readbacks),
        },
    }
    result["evidenceDigest"] = {
        "algorithm": "SHA-256",
        "canonicalization": EVIDENCE_CANONICALIZATION,
        "fields": list(EVIDENCE_DIGEST_FIELDS),
        "sha256": app_loader_evidence_sha(result),
    }
    validate_app_loader_evidence(result)
    serialized = json.dumps(result, ensure_ascii=False).encode("utf-8")
    for secret in (access_token, service_key, token, publishable_key):
        if secret and secret.encode("utf-8") in serialized:
            raise AppLoaderVerificationError("refusing to serialize a credential")
    write_json_atomic(output_file, result)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--deployment-record", required=True, type=Path)
    parser.add_argument("--runtime-record", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--supabase-url", default=os.environ.get("SUPABASE_URL", ""))
    args = parser.parse_args(argv)
    output = args.output or args.runtime_record.with_name(DEFAULT_RECORD_NAME)
    try:
        result = verify_app_loader(
            args.plan, args.deployment_record, args.runtime_record, output,
            base_url=args.supabase_url,
            access_token=os.environ.get("SUPABASE_USER_ACCESS_TOKEN", ""),
            service_key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        )
    except (AppLoaderVerificationError, OSError, ValueError) as error:
        print(f"verify-private-app-loader: {error}", file=sys.stderr)
        return 2
    print(json.dumps({
        "status": result["status"],
        "releaseId": result["releaseId"],
        "questions": result["loader"]["questions"],
        "packs": result["loader"]["packs"],
        "sampledStemAssets": result["stemAssetSample"]["count"],
        "appVersion": result["appVersion"],
        "verificationRecord": str(output.resolve()),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
