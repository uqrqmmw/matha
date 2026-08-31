#!/usr/bin/env python3
"""Produce a fail-closed completion audit for the MathA construction blueprint.

The report never calls a browser, OCR, OpenAI, or another paid service. Most
checks are offline. Device/capability completion can pass only after a read-only
private Storage readback, so a locally edited JSON file cannot certify itself.
Missing human/device/source evidence remains blocked instead of being inferred.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from collections import Counter
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
REQUIRED_DETAIL_NOS = {3, 4, 11, 12, 13, 14, 16}
NON_HUMAN = re.compile(r"(?:^|\b)(?:ai|bot|agent|codex|claude|chatgpt|openai)(?:\b|$)", re.I)
DEVICE_MODEL = "Samsung Galaxy Tab S10 Ultra"
DEVICE_PAPER_LAYOUT_VERSION = 2
DEVICE_ACCEPTANCE_PAGE_COUNTS = {"paper-mock-3": 4}
EXPECTED_SUPABASE_URL = "https://rrihysbxhsbxjteqmtdu.supabase.co"
PRIVATE_AUDIT_BUCKET = "matha-audit-private"
MAX_PRIVATE_AUDIT_BYTES = 15_000_000
EXPECTED_MANIFEST_ALIAS = "manifest-mistral-ocr4-verified-v1.json"
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
EXPECTED_EDGE_FUNCTION_VERSION = 37
EXPECTED_MIGRATIONS = [f"2026083000{number:02d}" for number in range(1, 12)]
STARTER_CAPACITY_MINIMUM = 1200
_RUNTIME_VERIFIER: Any | None = None
_APP_LOADER_VERIFIER: Any | None = None
_GITHUB_DELIVERY_VERIFIER: Any | None = None


class ReadinessError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise ReadinessError(f"{label}不存在：{path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReadinessError(f"{label}不是有效 JSON：{path}") from error
    if not isinstance(value, dict):
        raise ReadinessError(f"{label}必須是 JSON object：{path}")
    return value


def private_storage_fetcher_from_env() -> Any | None:
    """Return a read-only private Storage fetcher without exposing its key."""
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not key:
        return None

    def fetch(bucket: str, object_path: str) -> bytes:
        if bucket != PRIVATE_AUDIT_BUCKET:
            raise ReadinessError("私有驗收回讀 bucket 不在允許清單")
        normalized = str(object_path or "").replace("\\", "/").lstrip("/")
        if not normalized or ".." in normalized.split("/"):
            raise ReadinessError("私有驗收回讀路徑不合法")
        encoded = "/".join(urllib.parse.quote(part, safe="") for part in normalized.split("/"))
        request = urllib.request.Request(
            f"{EXPECTED_SUPABASE_URL}/storage/v1/object/{bucket}/{encoded}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read(MAX_PRIVATE_AUDIT_BYTES + 1)
        except OSError as error:
            raise ReadinessError(f"私有 Storage 即時回讀失敗：{error}") from error
        if len(payload) > MAX_PRIVATE_AUDIT_BYTES:
            raise ReadinessError("私有驗收物件超過允許大小")
        return payload

    return fetch


def parse_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ReadinessError(f"{label}缺少時間")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ReadinessError(f"{label}時間格式不合法") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ReadinessError(f"{label}時間缺少時區")
    return parsed.astimezone(timezone.utc)


def canonical_sha(value: Any) -> str:
    payload = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def runtime_verifier() -> Any:
    """Load the authoritative offline release validator without network access."""
    global _RUNTIME_VERIFIER
    if _RUNTIME_VERIFIER is not None:
        return _RUNTIME_VERIFIER
    path = REPO_ROOT / "scripts" / "ingest" / "verify-private-release-runtime.py"
    spec = importlib.util.spec_from_file_location("matha_private_runtime_audit", path)
    if spec is None or spec.loader is None:
        raise ReadinessError("無法載入正式題庫 runtime 驗證器")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _RUNTIME_VERIFIER = module
    return module


def app_loader_verifier() -> Any:
    """Load the authoritative authenticated App-loader evidence validator."""
    global _APP_LOADER_VERIFIER
    if _APP_LOADER_VERIFIER is not None:
        return _APP_LOADER_VERIFIER
    path = REPO_ROOT / "scripts" / "ingest" / "verify-private-app-loader.py"
    spec = importlib.util.spec_from_file_location("matha_private_app_loader_audit", path)
    if spec is None or spec.loader is None:
        raise ReadinessError("無法載入登入 App loader 驗證器")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _APP_LOADER_VERIFIER = module
    return module


def github_delivery_verifier() -> Any:
    """Load the authoritative live GitHub/Pages verifier once."""
    global _GITHUB_DELIVERY_VERIFIER
    if _GITHUB_DELIVERY_VERIFIER is None:
        path = REPO_ROOT / "scripts" / "verify-github-delivery.py"
        spec = importlib.util.spec_from_file_location("matha_github_delivery_verifier", path)
        if spec is None or spec.loader is None:
            raise ReadinessError("無法載入 GitHub delivery verifier")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _GITHUB_DELIVERY_VERIFIER = module
    return _GITHUB_DELIVERY_VERIFIER


def gate(identifier: str, label: str, status: str, summary: str,
         *, evidence: list[str] | None = None,
         blockers: list[str] | None = None,
         phase: str = "engineering",
         required_for_delivery: bool = True) -> dict[str, Any]:
    if status not in {"pass", "blocked", "fail"}:
        raise ValueError(f"invalid gate status: {status}")
    if phase not in {"engineering", "post-delivery"}:
        raise ValueError(f"invalid gate phase: {phase}")
    return {
        "id": identifier,
        "label": label,
        "phase": phase,
        "status": status,
        "summary": summary,
        "evidence": evidence or [],
        "blockers": blockers or [],
        "requiredForDelivery": required_for_delivery,
    }


def current_app_version() -> str:
    source = (REPO_ROOT / "app.js").read_text(encoding="utf-8")
    match = re.search(r"const APP_VER\s*=\s*['\"]([^'\"]+)['\"]", source)
    if not match:
        raise ReadinessError("app.js 找不到 APP_VER")
    return match.group(1)


def source_index(private_root: Path) -> dict[str, list[Path]]:
    index: dict[str, list[Path]] = {}
    if private_root.is_dir():
        for path in private_root.rglob("*"):
            if path.is_file():
                index.setdefault(path.name.casefold(), []).append(path)
    return index


def resolve_source(row: dict[str, Any], private_root: Path,
                   files: dict[str, list[Path]]) -> Path | None:
    hint = str(row.get("pathHint") or "")
    if hint:
        expanded = hint.replace("%DESKTOP%/數學檔案", private_root.as_posix())
        path = Path(expanded)
        if path.is_file():
            return path.resolve()
    expected = str(row.get("sha256") or "").lower()
    for path in files.get(str(row.get("fileName") or "").casefold(), []):
        if sha256(path) == expected:
            return path.resolve()
    return None


def resolve_private_hint(hint: str, private_root: Path) -> Path:
    expanded = hint.replace("%DESKTOP%/數學檔案", private_root.as_posix())
    return Path(expanded).resolve()


def validate_local_discovery(row: dict[str, Any], private_root: Path) -> list[str]:
    report_path = resolve_private_hint(str(row.get("reportPathHint") or ""), private_root)
    review_path = resolve_private_hint(str(row.get("visualReviewPathHint") or ""), private_root)
    expected_report = str(row.get("reportSha256") or "").lower()
    expected_review = str(row.get("visualReviewSha256") or "").lower()
    if (not report_path.is_file() or sha256(report_path) != expected_report
            or not review_path.is_file() or sha256(review_path) != expected_review):
        raise ReadinessError("本機完整卷盤點報告或視覺複核雜湊漂移")
    report = load_json(report_path, "本機完整卷盤點")
    review = load_json(review_path, "本機完整卷視覺複核")
    if (report.get("kind") != "matha-local-full-paper-discovery-v1"
            or report.get("releaseAuthority") is not False
            or review.get("kind") != "matha-local-full-paper-discovery-visual-review-v1"
            or review.get("releaseAuthority") is not False):
        raise ReadinessError("本機完整卷盤點 kind 或安全邊界不合法")
    if (int(report.get("scannedPdfCount") or 0) != int(row.get("scannedPdfCount", -1))
            or len(report.get("candidates") or []) != int(row.get("candidateRows", -1))
            or len({item.get("sha256") for item in report.get("candidates") or []})
               != int(row.get("candidateUniqueHashes", -1))):
        raise ReadinessError("本機完整卷盤點計數與清冊不一致")
    review_report = review.get("discoveryReport") or {}
    image_review = review.get("imageOnlyReview") or {}
    named_review = review.get("namedCandidateReview") or {}
    if (str(review_report.get("sha256") or "").lower() != expected_report
            or int(review_report.get("mathOrExamPathReadErrors", -1))
               != int(row.get("mathOrExamPathReadErrors", -2))
            or image_review.get("allFirstPagesReviewed") is not True
            or int(image_review.get("uniqueHashes") or 0)
               != int(row.get("imageOnlyUniqueHashesVisuallyReviewed", -1))
            or image_review.get("mathPaperHashesFound") != []
            or named_review.get("newCompleteMathAPaperHashesFound") != []
            or int(row.get("newCompleteMathAPapersFound", -1)) != 0):
        raise ReadinessError("本機完整卷視覺複核尚未完成或結果與清冊不一致")
    return [
        f"localDiscoveryReport:{expected_report}",
        f"localDiscoveryVisualReview:{expected_review}",
        f"localPdfScan:{report.get('scannedPdfCount')}:newCompleteMathA=0",
    ]


def validate_private_app_integration(
    row: dict[str, Any],
    private_root: Path,
    verified_source_documents: dict[str, dict[str, Any]] | None = None,
    inventory_papers: list[dict[str, Any]] | None = None,
) -> list[str]:
    if not isinstance(row, dict):
        raise ReadinessError("完整卷缺少私有 App 整合證據")
    if not verified_source_documents:
        raise ReadinessError("完整卷缺少與原始 PDF 實體雜湊綁定的來源證據")
    expected_version = current_app_version()
    expected_values = {
        "status": "deployed-and-hash-verified",
        "supabaseProjectRef": "rrihysbxhsbxjteqmtdu",
        "bucket": "matha-papers",
        "remoteHashMismatches": 0,
        "officialDetailedSolutionPapers": 1,
        "officialSolutionPages": 8,
        "solutionStorageHashMismatches": 0,
        "freshnessStillRequiresUserConfirmation": True,
    }
    for key, expected in expected_values.items():
        if row.get(key) != expected:
            raise ReadinessError(f"私有 App 整合證據不符：{key}")
    evidence_version = str(row.get("appVersion") or "")
    if evidence_version != expected_version:
        raise ReadinessError(
            f"完整卷證據版本過期：evidence={evidence_version or 'missing'}, current={expected_version}"
        )
    paper_count = int(row.get("integratedPapers") or row.get("officialPapers") or 0)
    page_count = int(row.get("integratedPages") or row.get("officialPages") or 0)
    official_count = int(row.get("officialPapers") or 0)
    regional_count = int(row.get("regionalMockPapers") or 0)
    answer_key_count = int(row.get("answerKeyPapersBehindPostSubmitGate") or 0)
    if (paper_count < 6 or page_count < paper_count
            or official_count < 6 or official_count + regional_count != paper_count
            or answer_key_count < paper_count):
        raise ReadinessError("私有 App 題本、頁面或伺服器答案鍵計數不合法")
    if int(row.get("edgeFunctionVersion") or 0) != EXPECTED_EDGE_FUNCTION_VERSION:
        raise ReadinessError("完整卷清冊未綁定目前正式 Edge Function 版本")

    paths = {
        "assets": resolve_private_hint(str(row.get("assetManifestPathHint") or ""), private_root),
        "visual": resolve_private_hint(str(row.get("visualReviewPathHint") or ""), private_root),
        "storage": resolve_private_hint(str(row.get("storageVerificationPathHint") or ""), private_root),
        "solutions": resolve_private_hint(str(row.get("solutionManifestPathHint") or ""), private_root),
        "officialSolutionStorage": resolve_private_hint(
            str(row.get("officialSolutionStorageVerificationPathHint") or ""), private_root,
        ),
    }
    hashes = {
        "assets": str(row.get("assetManifestSha256") or "").lower(),
        "visual": str(row.get("visualReviewSha256") or "").lower(),
        "storage": str(row.get("storageVerificationSha256") or "").lower(),
        "solutions": str(row.get("solutionManifestSha256") or "").lower(),
        "officialSolutionStorage": str(
            row.get("officialSolutionStorageVerificationSha256") or ""
        ).lower(),
    }
    regional_fields = {
        "regionalSolutions": ("regionalSolutionManifestPathHint", "regionalSolutionManifestSha256"),
        "regionalVisual": ("regionalSolutionVisualReviewPathHint", "regionalSolutionVisualReviewSha256"),
        "regionalStorage": (
            "regionalSolutionStorageVerificationPathHint",
            "regionalSolutionStorageVerificationSha256",
        ),
    }
    present_regional_fields = [
        bool(row.get(path_key) or row.get(hash_key))
        for path_key, hash_key in regional_fields.values()
    ]
    if any(present_regional_fields) and not all(present_regional_fields):
        raise ReadinessError("地區模考詳解證據必須 manifest、視覺複核與回讀驗證成套存在")
    if regional_count and not all(present_regional_fields):
        raise ReadinessError("地區模考已接入但缺少詳解安全證據")
    if all(present_regional_fields):
        for key, (path_key, hash_key) in regional_fields.items():
            paths[key] = resolve_private_hint(str(row[path_key]), private_root)
            hashes[key] = str(row[hash_key]).lower()
    for key, path in paths.items():
        if not path.is_file() or sha256(path) != hashes[key]:
            raise ReadinessError(f"私有 App {key} 證據不存在或雜湊漂移")

    assets = load_json(paths["assets"], "官方卷 App 資產 manifest")
    visual = load_json(paths["visual"], "官方卷 App 視覺複核")
    storage = load_json(paths["storage"], "官方卷 Storage 回讀驗證")
    solutions = load_json(paths["solutions"], "官方完整詳解 Storage 回讀驗證")
    official_solution_storage = load_json(
        paths["officialSolutionStorage"], "官方完整詳解即時 Storage 回讀驗證",
    )
    if (assets.get("kind") != "matha-official-paper-assets-v1"
            or assets.get("releaseAuthority") is not False
            or int(assets.get("paperCount") or 0) != paper_count
            or int(assets.get("assetCount") or 0) != page_count):
        raise ReadinessError("完整卷 App 資產 manifest 不合法")
    checks = visual.get("checks") or {}
    if (visual.get("schema") != 1 or visual.get("releaseAuthority") is not False
            or int(visual.get("papersReviewed") or 0) != paper_count
            or int(visual.get("pagesReviewed") or 0) != page_count
            or any(checks.get(key) != "pass" for key in (
                "pageOrder", "cropCompleteness", "chineseReadability",
                "formulaReadability", "diagramPreservation", "grayscalePreservation",
            ))
            or checks.get("handwritingPresent") is not False
            or checks.get("answerLeakageInQuestionPages") is not False):
        raise ReadinessError("完整卷 App 視覺複核不完整")
    if (storage.get("kind") != "matha-official-paper-storage-verification-v1"
            or storage.get("releaseAuthority") is not False
            or storage.get("readOnlyVerification") is not True
            or storage.get("readbackMode") != "live-authenticated-download"
            or storage.get("credentialsSerialized") is not False
            or storage.get("projectRef") != row["supabaseProjectRef"]
            or storage.get("bucket") != row["bucket"]
            or storage.get("sourceManifestSha256") != hashes["assets"]
            or int(storage.get("paperCount") or 0) != paper_count
            or int(storage.get("assetCount") or 0) != page_count
            or int(storage.get("remoteHashMismatches", -1)) != 0):
        raise ReadinessError("完整卷 Storage 回讀驗證不合法")

    solution_rows = solutions.get("assets") or []
    if (solutions.get("kind") != "matha-official-solution-assets-v1"
            or solutions.get("releaseAuthority") is not False
            or solutions.get("projectRef") != row["supabaseProjectRef"]
            or solutions.get("bucket") != "matha-solutions"
            or solutions.get("appSourceId") != "paper-official-110-trial"
            or int(solutions.get("sourcePages") or 0) != 8
            or len(solutions.get("questionPageMap") or []) != 20
            or int(solutions.get("question20ContinuationPage") or 0) != 8
            or solutions.get("remoteListingExact") is not True
            or int(solutions.get("readbackHashMismatches", -1)) != 0
            or len(solution_rows) != 8):
        raise ReadinessError("官方完整詳解 Storage 回讀驗證不合法")
    if (official_solution_storage.get("kind")
            != "matha-private-paper-solution-storage-verification-v1"
            or official_solution_storage.get("releaseAuthority") is not False
            or official_solution_storage.get("readOnlyVerification") is not True
            or official_solution_storage.get("readbackMode") != "live-authenticated-download"
            or official_solution_storage.get("credentialsSerialized") is not False
            or official_solution_storage.get("projectRef") != row["supabaseProjectRef"]
            or official_solution_storage.get("bucket") != "matha-solutions"
            or official_solution_storage.get("sourceManifestSha256") != hashes["solutions"]
            or int(official_solution_storage.get("paperCount") or 0) != 1
            or int(official_solution_storage.get("assetCount") or 0) != 8
            or int(official_solution_storage.get("remoteHashMismatches", -1)) != 0):
        raise ReadinessError("官方完整詳解未通過本次即時 Storage 全量下載驗證")
    edge_source = "\n".join(
        (REPO_ROOT / path).read_text(encoding="utf-8")
        for path in (
            "supabase/functions/openai-proxy/lib.ts",
            "supabase/functions/openai-proxy/paper-solutions.ts",
        )
    )
    for asset in solution_rows:
        relative = str(asset.get("file") or "").replace("\\", "/")
        path = paths["solutions"].parent / Path(relative)
        if (not relative.startswith("paper-official-110-trial/")
                or not path.is_file()
                or sha256(path) != str(asset.get("sha256") or "").lower()
                or path.stat().st_size != int(asset.get("bytes") or -1)
                or relative not in edge_source):
            raise ReadinessError(f"官方完整詳解雜湊或 Edge 引用不符：{relative}")
    official_remote_rows = {
        str(asset.get("file") or ""): asset
        for asset in official_solution_storage.get("assets") or [] if isinstance(asset, dict)
    }
    official_local_rows = {
        str(asset.get("file") or ""): asset for asset in solution_rows if isinstance(asset, dict)
    }
    if (set(official_remote_rows) != set(official_local_rows)
            or any(official_remote_rows[path].get("sha256")
                   != official_local_rows[path].get("sha256") for path in official_local_rows)):
        raise ReadinessError("官方完整詳解即時回讀未與來源 manifest 全數綁定")

    regional_solution_count = 0
    regional_solution_pages = 0
    if "regionalSolutions" in paths:
        regional_solutions = load_json(paths["regionalSolutions"], "地區模考完整詳解 manifest")
        regional_visual = load_json(paths["regionalVisual"], "地區模考詳解視覺複核")
        regional_storage = load_json(paths["regionalStorage"], "地區模考詳解 Storage 回讀驗證")
        regional_solution_count = int(row.get("regionalDetailedSolutionPapers") or 0)
        regional_solution_pages = int(row.get("regionalSolutionPages") or 0)
        if (regional_solution_count != regional_count or regional_solution_pages < regional_count
                or regional_solutions.get("kind") != "matha-private-paper-solution-assets-v1"
                or regional_solutions.get("releaseAuthority") is not False
                or int(regional_solutions.get("paperCount") or 0) != regional_solution_count
                or int(regional_solutions.get("assetCount") or 0) != regional_solution_pages
                or int(regional_solutions.get("questionBindingCount") or 0) != regional_count * 20):
            raise ReadinessError("地區模考完整詳解 manifest 不合法")
        regional_checks = regional_visual.get("checks") or {}
        if (regional_visual.get("kind") != "matha-private-solution-visual-review-v1"
                or regional_visual.get("releaseAuthority") is not False
                or regional_visual.get("assetManifestSha256") != hashes["regionalSolutions"]
                or int(regional_visual.get("paperCount") or 0) != regional_solution_count
                or int(regional_visual.get("pageCount") or 0) != regional_solution_pages
                or any(regional_checks.get(key) is not True for key in (
                    "allExpectedPagesPresent", "pageOrderPlausible",
                    "traditionalChineseReadable", "formulaGlyphsReadable",
                    "figuresAndTablesPreserved", "grayscaleContentPreserved",
                    "noHandwritingObserved", "noBlankOrTruncatedPageObserved",
                ))):
            raise ReadinessError("地區模考詳解視覺複核不完整")
        if (regional_storage.get("kind") != "matha-private-paper-solution-storage-verification-v1"
                or regional_storage.get("releaseAuthority") is not False
                or regional_storage.get("readOnlyVerification") is not True
                or regional_storage.get("readbackMode") != "live-authenticated-download"
                or regional_storage.get("credentialsSerialized") is not False
                or regional_storage.get("projectRef") != row["supabaseProjectRef"]
                or regional_storage.get("bucket") != "matha-solutions"
                or regional_storage.get("sourceManifestSha256") != hashes["regionalSolutions"]
                or int(regional_storage.get("paperCount") or 0) != regional_solution_count
                or int(regional_storage.get("assetCount") or 0) != regional_solution_pages
                or int(regional_storage.get("remoteHashMismatches", -1)) != 0):
            raise ReadinessError("地區模考詳解 Storage 回讀驗證不合法")
        regional_asset_rows: dict[str, dict[str, Any]] = {}
        regional_source_ids: set[str] = set()
        for paper in regional_solutions.get("papers") or []:
            source_id = str(paper.get("appSourceId") or "")
            mappings = paper.get("questionSolutionFiles") or []
            if (not source_id.startswith("paper-regional-") or source_id in regional_source_ids
                    or len(mappings) != 20 or any(not files for files in mappings)):
                raise ReadinessError("地區模考詳解題號綁定不完整")
            regional_source_ids.add(source_id)
            for asset in paper.get("assets") or []:
                relative = str(asset.get("file") or "").replace("\\", "/")
                path = paths["regionalSolutions"].parent / Path(relative)
                if (not relative.startswith(f"{source_id}/") or relative in regional_asset_rows
                        or not path.is_file()
                        or sha256(path) != str(asset.get("sha256") or "").lower()
                        or path.stat().st_size != int(asset.get("bytes") or -1)
                        or source_id not in edge_source
                        or Path(relative).name not in edge_source):
                    raise ReadinessError(f"地區模考詳解雜湊或 Edge 引用不符：{relative}")
                regional_asset_rows[relative] = asset
        remote_solution_rows = {
            str(asset.get("file") or ""): asset
            for asset in regional_storage.get("assets") or [] if isinstance(asset, dict)
        }
        if (len(regional_source_ids) != regional_count
                or len(regional_asset_rows) != regional_solution_pages
                or set(remote_solution_rows) != set(regional_asset_rows)
                or any(remote_solution_rows[path].get("sha256")
                       != regional_asset_rows[path].get("sha256") for path in regional_asset_rows)):
            raise ReadinessError("地區模考詳解回讀資產未與 manifest 全數綁定")

    app_source = (REPO_ROOT / "app.js").read_text(encoding="utf-8")
    inventory_identity: dict[str, str] = {}
    inventory_ids: set[str] = set()
    for paper in inventory_papers or []:
        source_id = str(paper.get("appSourceId") or "").strip()
        if not source_id:
            continue
        paper_id = str(paper.get("id") or "").strip()
        if (not paper_id or paper_id in inventory_ids
                or source_id in inventory_identity):
            raise ReadinessError("完整卷清冊 paperId 或 appSourceId 空白、不完整或重複")
        inventory_ids.add(paper_id)
        inventory_identity[source_id] = paper_id

    asset_rows: dict[str, dict[str, Any]] = {}
    manifest_papers: set[str] = set()
    manifest_source_ids: set[str] = set()
    source_pdf_ids: set[str] = set()
    source_pdf_hashes: set[str] = set()
    whole_paper_digests: dict[str, str] = {}
    for paper in assets.get("papers") or []:
        paper_id = str(paper.get("paperId") or "").strip()
        source_id = str(paper.get("appSourceId") or "").strip()
        if (not paper_id or paper_id in manifest_papers
                or not source_id or source_id in manifest_source_ids):
            raise ReadinessError("完整卷 App 資產 paperId 或 appSourceId 空白、不完整或重複")
        manifest_papers.add(paper_id)
        manifest_source_ids.add(source_id)
        if inventory_identity and inventory_identity.get(source_id) != paper_id:
            raise ReadinessError(f"完整卷 {paper_id} 未與清冊 appSourceId 唯一綁定")

        source_pdf_id = str(paper.get("sourceId") or "").strip()
        source_file_name = str(paper.get("sourceFileName") or "").strip()
        source_pdf_sha = str(paper.get("sourceSha256") or "").lower()
        source_pdf = verified_source_documents.get(source_pdf_id)
        if (not source_pdf_id or source_pdf_id in source_pdf_ids
                or not re.fullmatch(r"[0-9a-f]{64}", source_pdf_sha)
                or source_pdf_sha in source_pdf_hashes
                or not isinstance(source_pdf, dict)
                or source_pdf.get("sha256") != source_pdf_sha
                or source_pdf.get("fileName") != source_file_name
                or int(source_pdf.get("pages") or 0) != int(paper.get("sourcePages") or -1)):
            raise ReadinessError(f"完整卷 {paper_id} 未與唯一原始 PDF 實體雜湊綁定")
        source_pdf_ids.add(source_pdf_id)
        source_pdf_hashes.add(source_pdf_sha)

        paper_class = str(paper.get("paperClass") or "official-exam")
        rows = paper.get("assets") or []
        page_map = paper.get("questionPageMap") or []
        pdf_pages = paper.get("questionPdfPages") or []
        ordered_app_pages = [asset.get("appPage") for asset in rows]
        ordered_pdf_pages = [asset.get("pdfPage") for asset in rows]
        page_hashes = [str(asset.get("sha256") or "").lower() for asset in rows]
        if (not rows or len(page_map) != 20
                or any(not isinstance(page, int) or page < 1 or page > len(rows) for page in page_map)):
            raise ReadinessError(f"完整卷 {paper_id} 頁面或題號綁定不完整")
        if (ordered_app_pages != list(range(1, len(rows) + 1))
                or ordered_pdf_pages != pdf_pages
                or len(pdf_pages) != len(rows)
                or len(set(pdf_pages)) != len(pdf_pages)
                or any(not isinstance(page, int) or page < 1
                       or page > int(paper.get("sourcePages") or 0) for page in pdf_pages)
                or any(not re.fullmatch(r"[0-9a-f]{64}", digest) for digest in page_hashes)
                or len(set(page_hashes)) != len(page_hashes)):
            raise ReadinessError(f"完整卷 {paper_id} 頁序、PDF 頁碼或逐頁雜湊不完整")
        whole_digest = canonical_sha({
            "canonicalization": "ordered-page-sha256-v1",
            "pageSha256": page_hashes,
        })
        previous_paper = whole_paper_digests.get(whole_digest)
        if previous_paper:
            raise ReadinessError(
                f"完整卷 {paper_id} 與 {previous_paper} 整卷逐頁內容雜湊重複"
            )
        whole_paper_digests[whole_digest] = paper_id
        if source_id and source_id.startswith("paper-regional-"):
            if source_id not in app_source:
                raise ReadinessError(f"完整卷 {source_id} 未接入 App")
        elif source_id and source_id.startswith("paper-official-"):
            year = paper_id.split("-")[1]
            if f"privatePaperSource({year}" not in app_source:
                raise ReadinessError(f"官方卷 {year} 未接入 App")
        elif paper_id.startswith("official-"):
            year = paper_id.split("-")[1]
            if f"privatePaperSource({year}" not in app_source:
                raise ReadinessError(f"官方卷 {year} 未接入 App")
        else:
            raise ReadinessError(f"完整卷 {paper_id} 缺少 App source ID")
        if paper_class == "regional-mock" and not source_id.startswith("paper-regional-"):
            raise ReadinessError(f"地區模考 {paper_id} 類別或 App ID 不一致")
        for asset in rows:
            relative = str(asset.get("file") or "").replace("\\", "/")
            path = paths["assets"].parent / Path(relative)
            if (not relative.startswith(f"{paper_id}/") or relative in asset_rows
                    or not path.is_file()
                    or sha256(path) != str(asset.get("sha256") or "").lower()
                    or path.stat().st_size != int(asset.get("bytes") or -1)
                    or relative not in app_source):
                raise ReadinessError(f"完整卷 App 頁面雜湊或引用不符：{relative}")
            asset_rows[relative] = asset
    if (len(manifest_papers) != paper_count
            or len(manifest_source_ids) != paper_count
            or len(whole_paper_digests) != paper_count):
        raise ReadinessError("完整卷 App 資產題本身分或整卷內容 digest 不完整")
    if inventory_identity and inventory_identity != {
        str(paper.get("appSourceId")): str(paper.get("paperId"))
        for paper in assets.get("papers") or []
    }:
        raise ReadinessError("完整卷清冊與 App 資產 manifest 的題本身分集合不一致")

    remote_rows = {
        str(asset.get("file") or ""): asset for asset in storage.get("assets") or []
        if isinstance(asset, dict)
    }
    if (set(remote_rows) != set(asset_rows)
            or any(remote_rows[path].get("sha256") != asset_rows[path].get("sha256")
                   for path in asset_rows)):
        raise ReadinessError("Storage 回讀資產未與 App manifest 全數綁定")
    return [
        f"privatePaperAppAssets:{hashes['assets']}:{page_count}",
        f"privatePaperVisualReview:{hashes['visual']}:{page_count}",
        f"privatePaperStorageReadback:{hashes['storage']}:{page_count}:mismatch=0",
        f"privatePaperSourceProvenance:{len(source_pdf_ids)}:unique=1",
        f"privatePaperWholeDigests:{len(whole_paper_digests)}:unique=1",
        f"officialDetailedSolutions:{hashes['solutions']}:8:mismatch=0",
        f"officialSolutionLiveReadback:{hashes['officialSolutionStorage']}:8:mismatch=0",
        *(
            [f"regionalDetailedSolutions:{hashes['regionalSolutions']}:{regional_solution_pages}:mismatch=0"]
            if regional_solution_pages else []
        ),
        f"privatePaperAppVersion:evidence={evidence_version}:current={expected_version}:edge={row['edgeFunctionVersion']}:serverKeys={answer_key_count}",
    ]


def audit_full_papers(
    inventory_path: Path,
    private_root: Path,
    evidence_roots: list[Path] | None = None,
    capability_evidence: list[Path] | None = None,
    private_fetcher: Any | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        inventory = load_json(inventory_path, "完整卷清冊")
        if inventory.get("schema") != 1 or not isinstance(inventory.get("papers"), list):
            raise ReadinessError("完整卷清冊 schema 不合法")
        files = source_index(private_root)
        verified = []
        verified_source_documents: dict[str, dict[str, Any]] = {}
        source_document_count = 0
        for row in inventory.get("sourceDocuments") or []:
            source_id = str(row.get("id") or "").strip()
            if not source_id or source_id in verified_source_documents:
                raise ReadinessError("完整卷來源文件 ID 空白或重複")
            path = resolve_source(row, private_root, files)
            if path is None:
                raise ReadinessError(f"完整卷來源不存在或雜湊不符：{row.get('fileName')}")
            actual_sha = sha256(path)
            verified.append(f"{source_id}:{actual_sha}")
            verified_source_documents[source_id] = {
                "sha256": actual_sha,
                "fileName": str(row.get("fileName") or ""),
                "pages": int(row.get("pages") or 0),
                "path": str(path),
            }
            source_document_count += 1
        discovery = inventory.get("localDiscoveryAudit")
        if isinstance(discovery, dict):
            verified.extend(validate_local_discovery(discovery, private_root))
        verified.extend(validate_private_app_integration(
            inventory.get("privateAppIntegration"), private_root,
            verified_source_documents, inventory.get("papers") or [],
        ))
        integration = inventory.get("privateAppIntegration") or {}
        integrated_paper_count = int(
            integration.get("integratedPapers") or integration.get("officialPapers") or 0
        )
        potential = [row for row in inventory["papers"] if
                     int(row.get("questions") or 0) == 20
                     and int(row.get("minutes") or 0) == 100
                     and str(row.get("freshness") or "") != "seen"
                     and not str(row.get("calibrationStatus") or "").startswith("ineligible-")]
        integrated = [row for row in potential if
                      row.get("id") == "paper-mock-3" or bool(row.get("appSourceId"))]
        if len(integrated) != len(potential):
            raise ReadinessError(
                f"既有合格結構候選只有 {len(integrated)} / {len(potential)} 回接入 App"
            )
        if integrated_paper_count < 6 or len(integrated) < 6:
            raise ReadinessError("接入 App 且通過私有資產驗證的 20 題／100 分鐘完整卷少於 6 回")
        engineering = gate(
            "full-paper-engineering", "完整卷工程庫存", "pass",
            f"已驗證 {source_document_count} 份題本／答案來源；{integrated_paper_count} 回已接入 App 且私有資產回讀雜湊一致",
            evidence=verified,
        )
        calibration = audit_fresh_calibration(
            evidence_roots or [private_root], capability_evidence, private_fetcher,
        )
        return engineering, calibration
    except ReadinessError as error:
        return (
            gate("full-paper-engineering", "完整卷工程庫存", "fail", str(error)),
            gate("fresh-calibration", "正式新鮮校準證據", "blocked",
                 "完整卷工程關卡尚未通過，暫不能驗證新鮮校準證據",
                 blockers=["先修復完整卷工程庫存"], phase="post-delivery"),
        )


def find_json_files(roots: list[Path], patterns: list[str]) -> list[Path]:
    found: dict[Path, None] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for pattern in patterns:
            for path in root.rglob(pattern):
                if path.is_file():
                    found[path.resolve()] = None
    return sorted(found, key=lambda path: path.stat().st_mtime_ns, reverse=True)


CAPABILITY_RUN_DIGEST_FIELDS = [
    "runId", "sourceId", "submittedAt", "gradedAt", "score", "total",
    "freshnessConfirmedAt", "appVersion", "sourceContentDigest",
    "submitAttemptDigest", "gradeReceiptDigest",
    "submissionContentBindingSha256", "modelInputBindingSha256",
    "ownerVisualAttestationDigest", "gradeSummary",
]
CAPABILITY_GOAL = {
    "requiredRuns": 3, "distinctRuns": True, "distinctSources": True,
    "questionsPerRun": 20, "minutesPerRun": 100,
    "totalPoints": 100, "minimumScore": 72,
}
FRESH_CALIBRATION_FIXED = {
    "requiredRuns": 6, "distinctRuns": True, "distinctSources": True,
    "questionsPerRun": 20, "minutesPerRun": 100, "totalPoints": 100,
}


def _validate_capability_runs(
    rows: Any,
    *,
    baseline: float,
    generated_ms: float,
    label: str,
    minimum_score: float = 0,
) -> list[float]:
    if not isinstance(rows, list):
        raise ReadinessError(f"{label}不是正式卷陣列")
    run_ids: set[str] = set()
    source_ids: set[str] = set()
    source_content_digests: set[str] = set()
    submitted_times: list[float] = []
    allowed_status = {"correct", "incorrect", "uncertain", "unanswered"}
    for row in rows:
        if not isinstance(row, dict):
            raise ReadinessError(f"{label}含非物件正式卷")
        run_id, source_id = row.get("runId"), row.get("sourceId")
        submitted, graded, fresh = (
            row.get("submittedAt"), row.get("gradedAt"), row.get("freshnessConfirmedAt"),
        )
        score, total = row.get("score"), row.get("total")
        binding_digests = (
            row.get("sourceContentDigest"),
            row.get("submitAttemptDigest"),
            row.get("gradeReceiptDigest"),
            row.get("submissionContentBindingSha256"),
            row.get("modelInputBindingSha256"),
            row.get("ownerVisualAttestationDigest"),
        )
        if (not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", run_id)
                or not isinstance(source_id, str)
                or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", source_id)
                or run_id in run_ids or source_id in source_ids
                or row.get("sourceContentDigest") in source_content_digests
                or not all(isinstance(item, (int, float)) and not isinstance(item, bool)
                           for item in (submitted, graded, fresh, score, total))
                or submitted <= 0 or graded < submitted or fresh <= 0 or fresh > submitted
                or submitted > generated_ms or graded > generated_ms or fresh > generated_ms
                or submitted < baseline or fresh < baseline
                or score < minimum_score or score > 100 or total != 100
                or any(not isinstance(item, str)
                       or not re.fullmatch(r"[a-f0-9]{64}", item)
                       for item in binding_digests)
                or row.get("appVersion") != current_app_version()):
            raise ReadinessError(f"{label}資格、分數、新鮮度或唯一性不符")
        summary = row.get("gradeSummary") or {}
        questions = summary.get("questions")
        status_counts = summary.get("statusCounts")
        if (summary.get("questionCount") != 20 or summary.get("maxPoints") != 100
                or summary.get("awardedPoints") != score
                or not isinstance(questions, list) or len(questions) != 20
                or not isinstance(status_counts, dict)
                or set(status_counts) != allowed_status
                or any(not isinstance(count, int) or isinstance(count, bool) or count < 0
                       for count in status_counts.values())
                or sum(status_counts.values()) != 20):
            raise ReadinessError(f"{label}的 20 題分數摘要不可重算")
        awarded = 0.0
        maximum = 0.0
        recomputed_counts = {key: 0 for key in allowed_status}
        for index, item in enumerate(questions, start=1):
            if not isinstance(item, dict):
                raise ReadinessError(f"{label}題分摘要含非物件")
            points, max_points, status = item.get("points"), item.get("maxPoints"), item.get("status")
            if (item.get("no") != index or status not in allowed_status
                    or not isinstance(points, (int, float)) or isinstance(points, bool)
                    or not isinstance(max_points, (int, float)) or isinstance(max_points, bool)
                    or max_points <= 0 or points < 0 or points > max_points
                    or (status in {"uncertain", "unanswered"} and points != 0)
                    or (status == "correct" and points != max_points)):
                raise ReadinessError(f"{label}含不合法題號、狀態或配分")
            awarded += float(points)
            maximum += float(max_points)
            recomputed_counts[status] += 1
        if (round(awarded, 2) != score or round(maximum, 2) != 100
                or recomputed_counts != status_counts):
            raise ReadinessError(f"{label}題分或狀態計數無法重算")
        digest_value = {key: row.get(key) for key in CAPABILITY_RUN_DIGEST_FIELDS}
        if row.get("canonicalDigest") != canonical_sha(digest_value):
            raise ReadinessError(f"{label}單回 canonical digest 不符")
        run_ids.add(run_id)
        source_ids.add(source_id)
        source_content_digests.add(row["sourceContentDigest"])
        submitted_times.append(float(submitted))
    if submitted_times != sorted(submitted_times):
        raise ReadinessError(f"{label}不是依交卷時間排序")
    return submitted_times


def _load_capability_goal_evidence(path: Path) -> tuple[dict[str, Any], datetime, list[float], list[float]]:
    value = load_json(path, "能力目標證據")
    generated_at = parse_timestamp(value.get("generatedAt"), "能力目標證據")
    now = datetime.now(timezone.utc)
    if generated_at > now + timedelta(minutes=10) or now - generated_at > timedelta(days=7):
        raise ReadinessError("能力證據不是本週由目前 App 匯出的最新快照")
    generated_ms = generated_at.timestamp() * 1000
    kind, schema = value.get("kind"), value.get("schemaVersion")
    if (kind, schema) not in {
        ("matha-capability-goal-evidence-v1", 1),
        ("matha-capability-goal-evidence-v2", 2),
    }:
        raise ReadinessError("能力證據 kind 或 schemaVersion 不支援")
    baseline = value.get("baselineResetAt")
    digest_meta = value.get("digest") or {}
    if (value.get("appVersion") != current_app_version()
            or value.get("goal") != CAPABILITY_GOAL
            or not isinstance(baseline, (int, float)) or isinstance(baseline, bool)
            or baseline < 0
            or digest_meta.get("algorithm") != "SHA-256"
            or digest_meta.get("canonicalization") != "recursive-key-sorted-json-v1"
            or digest_meta.get("runDigestFields") != CAPABILITY_RUN_DIGEST_FIELDS):
        raise ReadinessError("能力證據版本、目標、baseline 或 canonical digest 規格不符")
    runs = value.get("runs")
    run_times = _validate_capability_runs(
        runs, baseline=float(baseline), generated_ms=generated_ms,
        label="能力證據正式卷",
    )
    calibration = value.get("calibration") or {}
    passes = sum(float(row.get("score") or 0) >= 72 for row in runs)
    calibration_stable = len(runs) == 3 and passes == 3
    evidence_stable = value.get("stable")
    if (len(runs) > 3
            or calibration.get("source") != "external"
            or calibration.get("count") != len(runs)
            or calibration.get("passes") != passes
            or calibration.get("stable") is not calibration_stable
            or not isinstance(evidence_stable, bool)
            or (evidence_stable and not calibration_stable)
            or value.get("status") != ("stable" if evidence_stable else "blocked")
            or not isinstance(value.get("blockers"), list)
            or (evidence_stable and value.get("blockers") != [])
            or (not evidence_stable and not value.get("blockers"))):
        raise ReadinessError("能力證據校準狀態與正式卷內容不一致")
    fresh_times: list[float] = []
    canonical_fields = (
        "kind", "schemaVersion", "generatedAt", "appVersion", "baselineResetAt",
        "status", "stable", "blockers", "goal", "calibration", "digest", "runs",
    )
    if schema == 2:
        fresh = value.get("freshCalibration") or {}
        fresh_runs = value.get("freshRuns")
        count = fresh.get("count")
        complete = fresh.get("complete")
        fixed = {key: fresh.get(key) for key in FRESH_CALIBRATION_FIXED}
        if (fixed != FRESH_CALIBRATION_FIXED
                or not isinstance(count, int) or isinstance(count, bool)
                or count < 0 or count > 6
                or complete is not (count == 6)
                or not isinstance(fresh_runs, list) or len(fresh_runs) != count):
            raise ReadinessError("六回新鮮校準摘要與 freshRuns 不一致")
        fresh_times = _validate_capability_runs(
            fresh_runs, baseline=float(baseline), generated_ms=generated_ms,
            label="六回新鮮校準正式卷",
        )
        if len(fresh_runs) >= 3 and runs != fresh_runs[-3:]:
            raise ReadinessError("最近三回必須是同一組 freshRuns 依交卷時間排序後的最後三回")
        canonical_fields = (*canonical_fields, "freshCalibration", "freshRuns")
    canonical_payload = {key: value.get(key) for key in canonical_fields}
    if value.get("canonicalDigest") != canonical_sha(canonical_payload):
        raise ReadinessError("能力證據總 canonical digest 不符")
    return value, generated_at, run_times, fresh_times


def validate_capability_server_archive(value: dict[str, Any],
                                       private_fetcher: Any | None) -> list[str]:
    if value.get("kind") != "matha-capability-goal-evidence-v2":
        raise ReadinessError("正式能力證據只接受 Edge 私有封存的 v2")
    archive = value.get("serverArchive") or {}
    archive_hash = str(archive.get("sha256") or "").lower()
    archive_path = str(archive.get("path") or "").replace("\\", "/")
    pattern = re.compile(
        rf"capability-evidence/matha_[a-f0-9]{{32}}/matha-capability-goal-([a-f0-9]{{16}})\.json"
    )
    match = pattern.fullmatch(archive_path)
    if (archive.get("authority") != "supabase-service-role-storage-readback"
            or archive.get("bucket") != PRIVATE_AUDIT_BUCKET
            or not re.fullmatch(r"[a-f0-9]{64}", archive_hash)
            or not match or match.group(1) != archive_hash[:16]
            or not isinstance(archive.get("bytes"), int) or isinstance(archive.get("bytes"), bool)
            or archive.get("bytes") <= 0 or archive.get("bytes") > MAX_PRIVATE_AUDIT_BYTES
            or archive.get("evidenceCanonicalDigest") != value.get("canonicalDigest")):
        raise ReadinessError("能力證據缺少合法的私有伺服器封存指標")
    parse_timestamp(archive.get("readbackVerifiedAt"), "能力證據私有回讀")
    if private_fetcher is None:
        raise ReadinessError("缺少私有 Storage 即時回讀；本機能力 JSON／SHA 不能自行證明六回成績")
    try:
        remote_bytes = private_fetcher(PRIVATE_AUDIT_BUCKET, archive_path)
    except ReadinessError:
        raise
    except Exception as error:
        raise ReadinessError(f"能力證據私有 Storage 即時回讀失敗：{error}") from error
    if (not isinstance(remote_bytes, bytes) or len(remote_bytes) != archive.get("bytes")
            or hashlib.sha256(remote_bytes).hexdigest() != archive_hash):
        raise ReadinessError("私有能力證據實際位元與 serverArchive 不一致")
    try:
        remote = json.loads(remote_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReadinessError("私有能力證據不是有效 JSON") from error
    local_core = {key: item for key, item in value.items() if key != "serverArchive"}
    if remote != local_core:
        raise ReadinessError("私有能力證據與本機匯出內容不一致")
    return [f"privateCapabilityArchive:{archive_path}:{archive_hash}"]


def validate_capability_goal_evidence(path: Path,
                                      private_fetcher: Any | None = None) -> list[str]:
    value, generated_at, submitted_times, _ = _load_capability_goal_evidence(path)
    if (value.get("status") != "stable" or value.get("stable") is not True
            or value.get("blockers") != [] or len(value.get("runs") or []) != 3
            or any(float(row.get("score") or 0) < 72 for row in value.get("runs") or [])):
        raise ReadinessError("能力證據未證明最近三回正式新鮮卷皆達 72 分")
    generated_ms = generated_at.timestamp() * 1000
    if (generated_ms - submitted_times[-1] > 90 * 86400000
            or generated_ms - submitted_times[0] > 180 * 86400000):
        raise ReadinessError("最近三回距能力證據產生時間過久，不能代表目前程度")
    server_evidence = validate_capability_server_archive(value, private_fetcher)
    return [
        f"capability:{sha256(path)}", "formalRuns:3", "minimumScore:72",
        "freshness:confirmed", "gradePoints:recomputed",
        *server_evidence,
    ]


def validate_fresh_calibration_evidence(path: Path,
                                        private_fetcher: Any | None = None) -> list[str]:
    value, _, _, fresh_times = _load_capability_goal_evidence(path)
    if value.get("kind") != "matha-capability-goal-evidence-v2":
        raise ReadinessError("六回新鮮校準只接受 App 匯出的 v2 真實證據")
    fresh = value.get("freshCalibration") or {}
    if (fresh.get("complete") is not True or fresh.get("count") != 6
            or len(fresh_times) != 6):
        raise ReadinessError(f"本人正式新鮮校準證據為 {len(fresh_times)} / 6 回")
    server_evidence = validate_capability_server_archive(value, private_fetcher)
    return [
        f"freshCalibration:{sha256(path)}", "formalRuns:6",
        "distinctRuns:6", "distinctSources:6", "freshness:confirmed",
        "gradePoints:recomputed", *server_evidence,
    ]


def audit_fresh_calibration(
    roots: list[Path], explicit: list[Path] | None = None,
    private_fetcher: Any | None = None,
) -> dict[str, Any]:
    candidates = list(explicit or [])
    candidates.extend(find_json_files(
        roots, ["數A能力目標證據-*.json", "*capability*goal*evidence*.json"],
    ))
    unique = list(dict.fromkeys(path.resolve() for path in candidates if path.is_file()))
    if not unique:
        return gate(
            "fresh-calibration", "正式新鮮校準證據", "blocked",
            "尚無 App 匯出的 v2 真實作答證據；清冊文字不算作答",
            blockers=["完成六回本人確認未看過的 20 題／100 分鐘正式卷並匯出證據"],
            phase="post-delivery",
        )
    valid: list[tuple[datetime, Path, list[str]]] = []
    errors: list[str] = []
    live_fetcher = private_fetcher or private_storage_fetcher_from_env()
    for path in unique:
        try:
            evidence = validate_fresh_calibration_evidence(path, live_fetcher)
            value = load_json(path, "能力目標證據")
            valid.append((parse_timestamp(value.get("generatedAt"), "能力目標證據"), path, evidence))
        except ReadinessError as error:
            errors.append(str(error))
    if not valid:
        return gate(
            "fresh-calibration", "正式新鮮校準證據", "blocked",
            errors[0] if errors else "六回正式新鮮校準證據尚未達標",
            blockers=["需六回 distinct run/source、freshness-confirmed、20 題／100 分鐘真實正式卷"],
            phase="post-delivery",
        )
    _, path, evidence = max(valid, key=lambda row: row[0])
    return gate(
        "fresh-calibration", "正式新鮮校準證據", "pass",
        "已有六回不同來源、題分與 digest 可重算的真實新鮮正式卷",
        evidence=[str(path), *evidence], phase="post-delivery",
    )


def audit_score_stability(
    roots: list[Path], explicit: list[Path] | None = None,
    private_fetcher: Any | None = None,
) -> dict[str, Any]:
    candidates = list(explicit or [])
    candidates.extend(find_json_files(
        roots, ["數A能力目標證據-*.json", "*capability*goal*evidence*.json"],
    ))
    unique = list(dict.fromkeys(path.resolve() for path in candidates if path.is_file()))
    if not unique:
        return gate(
            "score-stability", "最近三回正式卷皆達 72 分", "blocked",
            "尚無 App 匯出的能力目標證據",
            blockers=["交付後完成三回未看過的 20 題／100 分鐘正式卷"],
            phase="post-delivery",
        )
    valid: list[tuple[datetime, Path, list[str]]] = []
    errors: list[str] = []
    live_fetcher = private_fetcher or private_storage_fetcher_from_env()
    for path in unique:
        try:
            evidence = validate_capability_goal_evidence(path, live_fetcher)
            value = load_json(path, "能力目標證據")
            valid.append((parse_timestamp(value.get("generatedAt"), "能力目標證據"), path, evidence))
        except ReadinessError as error:
            errors.append(str(error))
    if not valid:
        return gate(
            "score-stability", "最近三回正式卷皆達 72 分", "blocked",
            errors[0] if errors else "能力目標證據尚未達標",
            blockers=["需三回 distinct、freshness-confirmed、20 題／100 分鐘正式卷且每回至少 72 分"],
            phase="post-delivery",
        )
    _, path, evidence = max(valid, key=lambda row: row[0])
    return gate(
        "score-stability", "最近三回正式卷皆達 72 分", "pass",
        "最近三回不同來源的正式新鮮卷皆達 72 分，題分與 digest 可重算",
        evidence=[str(path), *evidence], phase="post-delivery",
    )


def validate_github_delivery(path: Path, *, command_runner: Any | None = None,
                             fetcher: Any | None = None) -> list[str]:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
    except ValueError:
        pass
    else:
        raise ReadinessError("GitHub 交付證據不可放進公開 repo")
    value = load_json(path, "GitHub 交付證據")
    verified_at = parse_timestamp(value.get("verifiedAt"), "GitHub 交付證據")
    if verified_at > datetime.now(timezone.utc) + timedelta(minutes=10):
        raise ReadinessError("GitHub 交付證據時間在未來")
    verifier = github_delivery_verifier()
    runner = command_runner or verifier.run
    live_fetch = fetcher or verifier.default_fetch
    try:
        public_auditor = verifier.public_repo_auditor()
    except verifier.DeliveryVerificationError as error:
        raise ReadinessError(f"無法載入公開 Git 安全稽核器：{error}") from error
    try:
        public_repo_audit = public_auditor.audit_tracked_tree(REPO_ROOT)
        if runner(["git", "status", "--porcelain"]):
            raise ReadinessError("目前工作樹不是交付後的乾淨狀態")
        runner(["git", "fetch", "--quiet", "origin", "main"])
        head = runner(["git", "rev-parse", "HEAD"])
        origin = runner(["git", "rev-parse", "origin/main"])
        branch = runner(["git", "branch", "--show-current"])
        remote_head = runner([
            "gh", "api", "repos/uqrqmmw/matha/git/ref/heads/main",
            "--jq", ".object.sha",
        ])
        repo = json.loads(runner([
            "gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef",
        ]))
        rows = json.loads(runner([
            "gh", "run", "list", "--commit", head, "--limit", "50", "--json",
            "databaseId,workflowName,status,conclusion,headSha,url,updatedAt",
        ]))
        live_actions = {
            "ci": verifier.select_run(rows, "CI", head),
            "pages": verifier.select_run(rows, "Deploy GitHub Pages", head),
        }
    except ReadinessError:
        raise
    except (OSError, ValueError, json.JSONDecodeError,
            verifier.DeliveryVerificationError,
            public_auditor.PublicRepoAuditError) as error:
        raise ReadinessError(f"無法即時核對 GitHub／Pages：{error}") from error
    if (head != origin or head != remote_head or branch != "main"
            or not re.fullmatch(r"[0-9a-f]{40}", head)
            or repo.get("nameWithOwner") != "uqrqmmw/matha"
            or (repo.get("defaultBranchRef") or {}).get("name") != "main"):
        raise ReadinessError("目前 main、origin/main 與 GitHub 遠端 main 不一致")
    expected_assets = {
        name: {"sha256": sha256(REPO_ROOT / name), "bytes": (REPO_ROOT / name).stat().st_size}
        for name in ("index.html", "app.js", "sw.js", "textbook-catalog.js")
    }
    try:
        for name, expected in expected_assets.items():
            remote = live_fetch(f"https://uqrqmmw.github.io/matha/{name}?audit={head}")
            if hashlib.sha256(remote).hexdigest() != expected["sha256"] or len(remote) != expected["bytes"]:
                raise ReadinessError(f"GitHub Pages 的 {name} 已與目前 HEAD 漂移")
    except ReadinessError:
        raise
    except (OSError, verifier.DeliveryVerificationError) as error:
        raise ReadinessError(f"無法即時讀回 GitHub Pages：{error}") from error
    actions = value.get("actions") or {}
    if actions != live_actions:
        raise ReadinessError("GitHub 交付證據的 Actions 紀錄不是目前 HEAD 的即時成功紀錄")
    for key, workflow in (("ci", "CI"), ("pages", "Deploy GitHub Pages")):
        row = actions.get(key) or {}
        if (row.get("workflowName") != workflow or row.get("headSha") != head
                or row.get("status") != "completed" or row.get("conclusion") != "success"
                or not isinstance(row.get("databaseId"), int)
                or not str(row.get("url") or "").startswith(
                    "https://github.com/uqrqmmw/matha/actions/runs/")):
            raise ReadinessError(f"GitHub {workflow} 尚未對目前 HEAD 成功")
        parse_timestamp(row.get("updatedAt"), f"GitHub {workflow}")
    binding = {
        key: value.get(key) for key in (
            "repository", "branch", "headSha", "originMainSha", "remoteMainSha", "appVersion",
            "appJsSha256", "pagesRoot", "publicRepoAudit", "actions", "published",
        )
    }
    if (value.get("kind") != "matha-github-delivery-verification"
            or value.get("version") != 1 or value.get("status") != "verified"
            or value.get("repository") != "uqrqmmw/matha"
            or value.get("branch") != "main"
            or value.get("headSha") != head or value.get("originMainSha") != origin
            or value.get("remoteMainSha") != remote_head
            or value.get("workingTreeClean") is not True
            or value.get("publicRepoAudit") != public_repo_audit
            or value.get("appVersion") != current_app_version()
            or value.get("appJsSha256") != expected_assets["app.js"]["sha256"]
            or value.get("pagesRoot") != "https://uqrqmmw.github.io/matha"
            or value.get("published") != expected_assets
            or value.get("deliveryBindingSha256") != canonical_sha(binding)):
        raise ReadinessError("GitHub 交付證據未綁定目前 HEAD、App 與 Pages 位元")
    return [
        f"delivery:{sha256(path)}", f"head:{head}",
        f"ci:{actions['ci']['databaseId']}:success",
        f"pages:{actions['pages']['databaseId']}:success",
        f"publicRepo:{public_repo_audit['treeSha256']}:violations=0",
        f"publishedApp:{expected_assets['app.js']['sha256']}",
        f"publishedCatalog:{expected_assets['textbook-catalog.js']['sha256']}",
    ]


def audit_github_delivery(roots: list[Path], explicit: list[Path] | None = None) -> dict[str, Any]:
    candidates = list(explicit or [])
    candidates.extend(find_json_files(
        roots, ["*github*delivery*verification*.json"],
    ))
    unique = list(dict.fromkeys(path.resolve() for path in candidates if path.is_file()))
    if not unique:
        return gate(
            "github-delivery", "GitHub main、CI 與 Pages 實際交付", "blocked",
            "目前版本尚無 repo 外的 CI／Pages 位元驗證紀錄",
            blockers=["提交推送乾淨 main，等待 CI 與 Pages 成功，再讀回線上 app.js"],
        )
    valid: list[tuple[datetime, Path, list[str]]] = []
    errors: list[str] = []
    for path in unique:
        try:
            evidence = validate_github_delivery(path)
            value = load_json(path, "GitHub 交付證據")
            valid.append((parse_timestamp(value.get("verifiedAt"), "GitHub 交付證據"),
                          path, evidence))
        except ReadinessError as error:
            errors.append(str(error))
    if not valid:
        return gate(
            "github-delivery", "GitHub main、CI 與 Pages 實際交付", "blocked",
            errors[0] if errors else "CI／Pages 證據尚未對應目前版本",
            blockers=["對目前乾淨 HEAD 重新執行 GitHub delivery verifier"],
        )
    _, path, evidence = max(valid, key=lambda row: row[0])
    return gate(
        "github-delivery", "GitHub main、CI 與 Pages 實際交付", "pass",
        "乾淨 main 已等於 origin/main，CI 與 Pages 成功且線上四個信任檔逐位元相符",
        evidence=[str(path), *evidence],
    )


def validate_supabase_delivery(path: Path) -> list[str]:
    value = load_json(path, "Supabase runtime 交付證據")
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True,
        text=True, encoding="utf-8", check=True,
    ).stdout.strip()
    if (value.get("kind") != "matha-supabase-runtime-delivery-v1"
            or value.get("version") != 1 or value.get("status") != "verified"
            or value.get("projectRef") != "rrihysbxhsbxjteqmtdu"
            or value.get("headSha") != head
            or value.get("appVersion") != current_app_version()
            or value.get("appJsSha256") != sha256(REPO_ROOT / "app.js")
            or value.get("migrations") != EXPECTED_MIGRATIONS
            or value.get("browserUsed") is not False
            or value.get("openAiApiCalled") is not False
            or value.get("credentialsSerialized") is not False):
        raise ReadinessError("Supabase runtime 證據未綁定目前 HEAD、App 或 001–011 migration")
    edge = value.get("edge") or {}
    expected_files = {
        source.name: {"sha256": sha256(source), "bytes": source.stat().st_size}
        for source in (REPO_ROOT / "supabase" / "functions" / "openai-proxy").glob("*.ts")
        if not source.name.endswith(".test.ts")
    }
    actual_files = {
        str(row.get("file") or ""): {
            "sha256": row.get("sha256"), "bytes": row.get("bytes"),
        }
        for row in edge.get("sourceFiles") or [] if isinstance(row, dict)
    }
    probe = value.get("contractProbe") or {}
    if (edge.get("slug") != "openai-proxy"
            or edge.get("status") != "ACTIVE"
            or int(edge.get("version") or 0) != EXPECTED_EDGE_FUNCTION_VERSION
            or actual_files != expected_files
            or probe != {"optionsStatus": 204, "unauthenticatedPostStatus": 401}):
        raise ReadinessError("遠端 Edge 版本、production source 或未登入拒絕合約不符")
    return [
        f"supabaseDelivery:{sha256(path)}", f"head:{head}",
        "migrations:001-011:exact", f"edge:v{EXPECTED_EDGE_FUNCTION_VERSION}:sourceExact",
        "edgeProbe:options=204,unauthenticatedPost=401",
    ]


def audit_supabase_delivery(roots: list[Path],
                            explicit: list[Path] | None = None) -> dict[str, Any]:
    candidates = list(explicit or [])
    candidates.extend(find_json_files(roots, ["*supabase*runtime*delivery*.json"]))
    unique = list(dict.fromkeys(path.resolve() for path in candidates if path.is_file()))
    valid: list[tuple[datetime, Path, list[str]]] = []
    errors: list[str] = []
    for path in unique:
        try:
            evidence = validate_supabase_delivery(path)
            value = load_json(path, "Supabase runtime 交付證據")
            valid.append((parse_timestamp(value.get("verifiedAt"), "Supabase runtime 交付"),
                          path, evidence))
        except (OSError, subprocess.SubprocessError, ReadinessError) as error:
            errors.append(str(error))
    if not valid:
        return gate(
            "supabase-runtime-delivery", "Supabase DB 與 Edge 實際交付", "blocked",
            errors[0] if errors else "目前 HEAD 尚無遠端 migration／Edge exact-source 證據",
            blockers=["以只讀 verifier 核對 migration 001–011、Edge source 與 401/204 合約"],
        )
    _, path, evidence = max(valid, key=lambda row: row[0])
    return gate(
        "supabase-runtime-delivery", "Supabase DB 與 Edge 實際交付", "pass",
        "遠端 migration 001–011、Edge v37 production source 與未登入拒絕合約均和目前 HEAD 一致",
        evidence=[str(path), *evidence],
    )


def validate_device_audit(path: Path, selected_paper: str, app_version: str,
                          private_fetcher: Any | None = None) -> list[str]:
    value = load_json(path, "真機驗收")
    run, audit = value.get("run") or {}, value.get("audit") or {}
    if (value.get("kind") != "matha-paper-runtime-audit-v2"
            or value.get("schemaVersion") != 2 or audit.get("schema") != 2):
        raise ReadinessError("正式真機驗收只接受 matha-paper-runtime-audit-v2/schema 2；舊 v1 僅供辨識")
    if value.get("appVersion") != app_version or audit.get("appVersion") != app_version:
        raise ReadinessError(f"真機驗收不是目前版本 {app_version}")
    run_id = str(run.get("id") or "")
    if (not re.fullmatch(r"paper-run-\d{10,20}", run_id)
            or run.get("sourceId") != selected_paper
            or audit.get("runId") != run_id or audit.get("sourceId") != selected_paper
            or run.get("status") not in {"awaiting-correction", "completed"}
            or run.get("paperLayoutVersion") != DEVICE_PAPER_LAYOUT_VERSION):
        raise ReadinessError("真機驗收不是指定第三回的已交卷紀錄")
    expected_pages = DEVICE_ACCEPTANCE_PAGE_COUNTS.get(selected_paper)
    if not expected_pages:
        raise ReadinessError("真機驗收指定卷沒有固定頁數規格")

    def finite_number(item: Any) -> bool:
        return isinstance(item, (int, float)) and not isinstance(item, bool) \
            and float("-inf") < float(item) < float("inf")

    attestation = value.get("deviceAttestation") or {}
    nested_attestation = audit.get("deviceAttestation") or {}
    if (attestation.get("confirmed") is not True
            or attestation.get("model") != DEVICE_MODEL
            or attestation.get("source") != "user-confirmation"
            or any(nested_attestation.get(key) != attestation.get(key) for key in (
                "confirmed", "model", "source", "confirmedAt", "browserReportedModel",
            ))):
        raise ReadinessError("缺少 Galaxy Tab S10 Ultra 使用者裝置確認")
    parse_timestamp(attestation.get("confirmedAt"), "Galaxy 裝置確認")
    parse_timestamp(value.get("exportedAt"), "真機驗收匯出")
    device = audit.get("device") or {}
    user_agent = str(device.get("userAgent") or "")
    reported_model = str(attestation.get("browserReportedModel") or "")
    width = float(device.get("screenWidth")) if finite_number(device.get("screenWidth")) else 0
    height = float(device.get("screenHeight")) if finite_number(device.get("screenHeight")) else 0
    if "Android" not in user_agent:
        raise ReadinessError("裝置 UA 不是 Android")
    if reported_model and not re.search(r"SM-X9", reported_model, re.I):
        raise ReadinessError("瀏覽器回報型號不是 Samsung Galaxy Tab Ultra")
    if not reported_model and not re.search(r"SM-X9", user_agent, re.I) \
            and (max(width, height) < 1100 or min(width, height) < 700):
        raise ReadinessError("瀏覽器未回報型號，螢幕資料也不能支持大型 Samsung 平板證據")

    elapsed_raw = audit.get("activeElapsedMs")
    strokes = audit.get("strokesCommitted")
    if (not finite_number(elapsed_raw) or not isinstance(strokes, int) or isinstance(strokes, bool)
            or strokes < 1):
        raise ReadinessError("未證明完整 100 分鐘與實際手寫")
    elapsed = float(elapsed_raw)
    if elapsed < 5_999_000 or elapsed > 6_001_000:
        raise ReadinessError("未證明完整 100 分鐘與實際手寫")

    visited = audit.get("visitedPages")
    if (not isinstance(visited, list) or len(visited) != expected_pages
            or any(not isinstance(page, int) or isinstance(page, bool) for page in visited)
            or len(set(visited)) != expected_pages
            or set(visited) != set(range(expected_pages))):
        raise ReadinessError("真機驗收沒有 raw visitedPages 全部頁面證據")
    switches = audit.get("pageSwitches")
    if not isinstance(switches, list):
        raise ReadinessError("真機驗收缺少 raw 翻頁資料")
    swipe_rows = []
    for row in switches:
        if (not isinstance(row, dict) or row.get("method") not in {"swipe", "button"}
                or row.get("painted") is not True
                or not finite_number(row.get("at")) or float(row["at"]) <= 0
                or not finite_number(row.get("ms")) or float(row["ms"]) < 0
                or not isinstance(row.get("from"), int) or isinstance(row.get("from"), bool)
                or not isinstance(row.get("to"), int) or isinstance(row.get("to"), bool)
                or row["from"] == row["to"]
                or row["from"] not in range(expected_pages)
                or row["to"] not in range(expected_pages)):
            raise ReadinessError("真機驗收含無效或未完成 painted 的翻頁事件")
        if row["method"] == "swipe":
            swipe_rows.append(row)
    initial_page = audit.get("initialPage")
    if not isinstance(initial_page, int) or isinstance(initial_page, bool) \
            or initial_page not in range(expected_pages):
        raise ReadinessError("真機驗收 initialPage 不合法")
    swipe_pages = {initial_page}
    for row in swipe_rows:
        swipe_pages.update((row["from"], row["to"]))
    if len(swipe_rows) < max(1, expected_pages - 1) or swipe_pages != set(range(expected_pages)):
        raise ReadinessError("未證明以手指滑動並完成 painted 後翻遍全部頁面；button-only 不合格")
    swipe_ms = sorted(float(row["ms"]) for row in swipe_rows)
    page_p95 = swipe_ms[max(0, min(len(swipe_ms) - 1, (95 * len(swipe_ms) + 99) // 100 - 1))]
    if page_p95 > 500:
        raise ReadinessError("手指滑動 painted 後的 P95 超過 500 ms")

    save_ms = audit.get("localSaveMs")
    if (not isinstance(save_ms, list) or not save_ms
            or any(not finite_number(item) or float(item) < 0 for item in save_ms)
            or max(float(item) for item in save_ms) > 2000
            or audit.get("localSaveFailures") != 0
            or (audit.get("localSaveFailureIds") not in (None, []))):
        raise ReadinessError("本機筆跡保存沒有 raw 成功量測或發生失敗")
    sorted_saves = sorted(float(item) for item in save_ms)
    save_p95 = sorted_saves[max(0, min(len(sorted_saves) - 1, (95 * len(sorted_saves) + 99) // 100 - 1))]
    canvas_pixels = audit.get("maxSingleCanvasPixels")
    canvas_count = audit.get("maxLiveCanvasCount")
    if (not finite_number(canvas_pixels) or not finite_number(canvas_count)
            or float(canvas_pixels) <= 0 or float(canvas_pixels) > 12_000_000
            or int(canvas_count) != float(canvas_count) or int(canvas_count) < 1
            or int(canvas_count) > 3):
        raise ReadinessError("Canvas raw 資源量測未通過")

    recoveries = audit.get("crashRecoveries")
    events = audit.get("recoveryEvents")
    sessions = audit.get("sessions")
    if (not isinstance(recoveries, int) or isinstance(recoveries, bool) or recoveries < 1
            or not isinstance(sessions, int) or isinstance(sessions, bool) or sessions < 2
            or not isinstance(events, list) or len(events) != recoveries):
        raise ReadinessError("sessions 次數不能代替真實當機恢復；缺少 crashRecoveries/recoveryEvents")
    for row in events:
        if (not isinstance(row, dict) or row.get("sourceId") != selected_paper
                or not finite_number(row.get("checkpointUpdatedAt"))
                or not finite_number(row.get("recoveredAt"))
                or float(row["checkpointUpdatedAt"]) <= 0
                or float(row["recoveredAt"]) < float(row["checkpointUpdatedAt"])
                or not isinstance(row.get("page"), int) or isinstance(row.get("page"), bool)
                or row["page"] not in range(expected_pages)
                or not finite_number(row.get("remainingMs"))
                or float(row["remainingMs"]) < 0 or float(row["remainingMs"]) > 6_000_000
                or row.get("inkVerified") is not True
                or not re.fullmatch(r"[a-f0-9]{64}", str(row.get("checkpointInkSha256") or ""))
                or row.get("checkpointInkSha256") != row.get("recoveredInkSha256")
                or row.get("pageCount") != expected_pages
                or not isinstance(row.get("strokeCount"), int) or isinstance(row.get("strokeCount"), bool)
                or row["strokeCount"] < 0
                or not isinstance(row.get("deletedCount"), int) or isinstance(row.get("deletedCount"), bool)
                or row["deletedCount"] < 0):
            raise ReadinessError("真實當機恢復事件內容不合法")

    durability = audit.get("submitDurability") or {}
    durability_pages = durability.get("pages")
    submitted_at = audit.get("submittedAt")
    if (durability.get("journalDrained") is not True
            or durability.get("allPagesPersisted") is not True
            or durability.get("cloudFlushed") is not True
            or durability.get("pendingAtSubmit") != 0
            or audit.get("pendingAtSubmit") != 0
            or durability.get("expectedPages") != expected_pages
            or durability.get("verifiedPages") != expected_pages
            or not finite_number(submitted_at) or float(submitted_at) <= 0
            or not finite_number(durability.get("readbackVerifiedAt"))
            or float(durability.get("readbackVerifiedAt") or 0) < float(submitted_at or 0)
            or not isinstance(durability_pages, list)
            or len(durability_pages) != expected_pages):
        raise ReadinessError("交卷 submitDurability 未證明全頁、零 pending 與雲端回讀")
    seen_pages: set[int] = set()
    hash_pattern = re.compile(r"[a-f0-9]{64}")
    for row in durability_pages:
        page = row.get("page") if isinstance(row, dict) else None
        local_hash = str(row.get("localSha256") or "") if isinstance(row, dict) else ""
        cloud_hash = str(row.get("cloudSha256") or "") if isinstance(row, dict) else ""
        if (not isinstance(page, int) or isinstance(page, bool)
                or page not in range(expected_pages) or page in seen_pages
                or row.get("matched") is not True
                or not hash_pattern.fullmatch(local_hash)
                or not hash_pattern.fullmatch(cloud_hash)
                or local_hash != cloud_hash
                or row.get("qid") != f"paper:{run_id}:v{DEVICE_PAPER_LAYOUT_VERSION}:{page}"
                or not isinstance(row.get("clientId"), str) or not row.get("clientId")):
            raise ReadinessError("交卷逐頁本機／雲端雜湊不一致或頁碼綁定漂移")
        seen_pages.add(page)
    if seen_pages != set(range(expected_pages)):
        raise ReadinessError("交卷 submitDurability 缺少頁面")

    pdf = audit.get("pdfArtifact") or {}
    pdf_hash = str(pdf.get("sha256") or "")
    content_binding_hash = str(pdf.get("contentBindingSha256") or "")
    pdf_path = str(pdf.get("path") or "").replace("\\", "/")
    pdf_path_pattern = re.compile(
        rf"runtime-audits/matha_[a-f0-9]{{32}}/pdf/{re.escape(run_id)}/"
        rf"(graded|answer)-({hash_pattern.pattern})-({hash_pattern.pattern})\.pdf"
    )
    pdf_path_match = pdf_path_pattern.fullmatch(pdf_path)
    if (pdf.get("magic") != "%PDF-" or pdf.get("eof") != "%%EOF"
            or pdf.get("format") != "application/pdf"
            or not hash_pattern.fullmatch(pdf_hash)
            or not isinstance(pdf.get("bytes"), int) or isinstance(pdf.get("bytes"), bool)
            or pdf.get("bytes") <= 1000 or pdf.get("bytes") > 14_000_000
            or pdf.get("pageCount") != expected_pages
            or pdf.get("kind") not in {"graded", "answer"}
            or pdf.get("storageVerified") is not True
            or pdf.get("bucket") != PRIVATE_AUDIT_BUCKET
            or not pdf_path_match or pdf_path_match.group(1) != pdf.get("kind")
            or pdf_path_match.group(2) != content_binding_hash
            or pdf_path_match.group(3) != pdf_hash
            or pdf.get("contentBindingVersion") != 1
            or not hash_pattern.fullmatch(content_binding_hash)
            or not re.fullmatch(r"private-scan-set-[a-z0-9-]+-\d{8}-v\d+",
                                str(pdf.get("sourceAssetVersion") or ""))
            or (pdf.get("kind") == "graded"
                and not hash_pattern.fullmatch(str(pdf.get("gradeBindingSha256") or "")))
            or (pdf.get("kind") == "answer" and pdf.get("gradeBindingSha256") is not None)
            or pdf.get("runId") != run_id or pdf.get("sourceId") != selected_paper
            or not finite_number(pdf.get("generatedAt"))
            or float(pdf["generatedAt"]) < float(submitted_at)):
        raise ReadinessError("PDF 必須是指定 run 的私有 hash-addressed 正式檔；列印 timestamp 或本機 metadata 不算")
    parse_timestamp(pdf.get("serverVerifiedAt"), "PDF 伺服器回讀")

    pixel_qa = audit.get("pdfPixelQa") or {}
    pixel_qa_at = parse_timestamp(pixel_qa.get("confirmedAt"), "PDF 真人像素核對")
    pdf_verified_at = parse_timestamp(pdf.get("serverVerifiedAt"), "PDF 伺服器回讀")
    if (pixel_qa.get("confirmed") is not True
            or pixel_qa.get("source") != "owner-visual-review"
            or pixel_qa.get("reviewer") != "authenticated-owner"
            or pixel_qa.get("pdfSha256") != pdf_hash
            or pixel_qa.get("contentBindingSha256") != content_binding_hash
            or pixel_qa_at < pdf_verified_at):
        raise ReadinessError("PDF 內容正確性仍缺本人逐頁像素核對；雜湊不能冒充視覺驗證")

    archive = audit.get("archive") or {}
    archive_hash = str(archive.get("sha256") or "")
    archive_path = str(archive.get("path") or "").replace("\\", "/")
    archive_pattern = re.compile(
        rf"runtime-audits/matha_[a-f0-9]{{32}}/matha-paper-runtime-audit-{re.escape(run_id)}-([a-f0-9]{{16}})\.json"
    )
    archive_match = archive_pattern.fullmatch(archive_path)
    if (archive.get("authority") != "supabase-service-role-storage-readback"
            or archive.get("bucket") != PRIVATE_AUDIT_BUCKET
            or not hash_pattern.fullmatch(archive_hash)
            or not archive_match or archive_match.group(1) != archive_hash[:16]
            or archive.get("appVersion") != app_version
            or archive.get("sourceId") != selected_paper
            or archive.get("contentBindingSha256") != content_binding_hash
            or archive.get("pdfSha256") != pdf_hash
            or not isinstance(archive.get("bytes"), int) or isinstance(archive.get("bytes"), bool)
            or archive.get("bytes") <= 0 or archive.get("bytes") > MAX_PRIVATE_AUDIT_BYTES
            or not finite_number(archive.get("archivedAt"))):
        raise ReadinessError("缺少私有 hash-addressed 真機驗收封存或封存雜湊漂移")
    parse_timestamp(archive.get("readbackVerifiedAt"), "真機驗收私有回讀")

    # 本機 JSON 與公開 SHA 都可被重算，不能自行證明真機或 100 分鐘。正式通過前必須
    # 以私有權限讀回 Edge 產生的封存與 PDF，並核對實際位元。這條路徑只讀取，不寫入。
    if private_fetcher is None:
        raise ReadinessError("缺少私有 Storage 即時回讀；本機 JSON／SHA 不能自行證明真機驗收")
    try:
        archive_bytes = private_fetcher(PRIVATE_AUDIT_BUCKET, archive_path)
        pdf_bytes = private_fetcher(PRIVATE_AUDIT_BUCKET, pdf_path)
    except ReadinessError:
        raise
    except Exception as error:
        raise ReadinessError(f"私有 Storage 即時回讀失敗：{error}") from error
    if (not isinstance(archive_bytes, bytes) or len(archive_bytes) > MAX_PRIVATE_AUDIT_BYTES
            or hashlib.sha256(archive_bytes).hexdigest() != archive_hash):
        raise ReadinessError("私有真機封存實際位元與 archive SHA 不一致")
    try:
        server = json.loads(archive_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ReadinessError("私有真機封存不是有效的伺服器 JSON") from error
    server_run = server.get("run") or {}
    server_audit = server.get("audit") or {}
    server_summary = server.get("summary") or {}
    if (server.get("kind") != "matha-paper-runtime-audit-v2"
            or server.get("schemaVersion") != 2
            or server.get("appVersion") != app_version
            or server_run.get("id") != run_id
            or server_run.get("sourceId") != selected_paper
            or server_run.get("pageCount") != expected_pages
            or server_run.get("paperLayoutVersion") != DEVICE_PAPER_LAYOUT_VERSION
            or server_run.get("status") not in {"awaiting-correction", "completed"}
            or server_audit.get("schema") != 2
            or server_audit.get("appVersion") != app_version
            or server_audit.get("runId") != run_id
            or server_audit.get("sourceId") != selected_paper
            or server_summary.get("passed") is not True):
        raise ReadinessError("私有真機封存未綁定目前 App、題本、run 與頁數")
    parse_timestamp(server.get("exportedAt"), "私有真機封存")
    server_checks = {
        str(row.get("id")): row.get("status")
        for row in server_summary.get("checks") or [] if isinstance(row, dict)
    }
    required_server_checks = {"duration", "page", "save", "canvas", "resume", "pdf", "pdf-visual", "durability"}
    if any(server_checks.get(check) != "pass" for check in required_server_checks):
        raise ReadinessError("私有真機封存沒有通過全部伺服器必要檢查")
    for field in (
        "activeElapsedMs", "sessions", "crashRecoveries", "recoveryEvents",
        "strokesCommitted", "initialPage", "visitedPages", "pageSwitches",
        "localSaveMs", "localSaveFailures", "pendingAtSubmit",
        "maxSingleCanvasPixels", "maxLiveCanvasCount", "deviceAttestation", "device",
    ):
        if server_audit.get(field) != audit.get(field):
            raise ReadinessError(f"私有真機封存的 {field} 與匯出檔不一致")
    server_durability = server_audit.get("submitDurability") or {}
    for field in (
        "journalDrained", "allPagesPersisted", "cloudFlushed", "pendingAtSubmit",
        "readbackVerifiedAt", "expectedPages", "verifiedPages",
    ):
        if server_durability.get(field) != durability.get(field):
            raise ReadinessError("私有真機封存的交卷回讀證據與匯出檔不一致")
    server_pdf = server_audit.get("pdfArtifact") or {}
    for field in (
        "format", "magic", "eof", "sha256", "bytes", "pageCount", "kind",
        "generatedAt", "storageVerified", "bucket", "path", "serverVerifiedAt",
        "contentBindingVersion", "contentBindingSha256", "sourceAssetVersion",
        "gradeBindingSha256",
    ):
        if server_pdf.get(field) != pdf.get(field):
            raise ReadinessError("私有真機封存的 PDF 證據與匯出檔不一致")
    if server_audit.get("pdfPixelQa") != pixel_qa:
        raise ReadinessError("私有真機封存的本人 PDF 像素核對與匯出檔不一致")
    ink_readback = server.get("inkReadback") or {}
    server_pages = ink_readback.get("pages")
    if (ink_readback.get("route") != "service-role-postgrest"
            or ink_readback.get("expectedPages") != expected_pages
            or ink_readback.get("verifiedPages") != expected_pages
            or not isinstance(server_pages, list) or len(server_pages) != expected_pages):
        raise ReadinessError("私有真機封存缺少逐頁伺服器筆跡回讀")
    local_pages = {row["page"]: row for row in durability_pages}
    seen_server_pages: set[int] = set()
    for row in server_pages:
        page = row.get("page") if isinstance(row, dict) else None
        local = local_pages.get(page)
        if (not isinstance(page, int) or isinstance(page, bool) or page in seen_server_pages
                or local is None or row.get("matched") is not True
                or row.get("qid") != local.get("qid")
                or row.get("clientId") != local.get("clientId")
                or row.get("sha256") != local.get("cloudSha256")):
            raise ReadinessError("私有真機封存逐頁筆跡與匯出檔不一致")
        seen_server_pages.add(page)
    if seen_server_pages != set(range(expected_pages)):
        raise ReadinessError("私有真機封存逐頁筆跡不完整")
    if (not isinstance(pdf_bytes, bytes) or len(pdf_bytes) != pdf.get("bytes")
            or hashlib.sha256(pdf_bytes).hexdigest() != pdf_hash
            or not pdf_bytes.startswith(b"%PDF-")
            or not pdf_bytes.rstrip().endswith(b"%%EOF")
            or len(re.findall(rb"/Type\s*/Page\b", pdf_bytes)) != expected_pages):
        raise ReadinessError("私有正式 PDF 實際位元、雜湊或頁數不一致")
    return [
        f"file:{path}", f"sha256:{sha256(path)}", f"run:{run.get('id')}",
        f"pageP95Ms:{round(page_p95, 2)}",
        f"localSaveP95Ms:{round(save_p95, 2)}",
        f"privateArchive:{archive_path}:{archive_hash}",
        f"privatePdf:{pdf_path}:{pdf_hash}",
    ]


def audit_device(roots: list[Path], selected_paper: str,
                 explicit: list[Path] | None = None) -> dict[str, Any]:
    candidates = [path.resolve() for path in explicit or []]
    if not candidates:
        candidates = find_json_files(roots, ["數A真機驗收-*.json", "matha-paper-runtime-audit*.json"])
    if not candidates:
        return gate(
            "galaxy-tab", "Galaxy Tab 100 分鐘真機驗收", "blocked",
            "尚無真機驗收匯出檔",
            blockers=["在 Galaxy Tab S10 Ultra 完成第三回、滑動翻頁、恢復、交卷與 PDF 後按『同步並匯出驗收檔』"],
            phase="post-delivery",
        )
    errors = []
    version = current_app_version()
    private_fetcher = private_storage_fetcher_from_env()
    for path in candidates:
        try:
            evidence = validate_device_audit(path, selected_paper, version, private_fetcher)
            return gate("galaxy-tab", "Galaxy Tab 100 分鐘真機驗收", "pass", "真機必要證據全部通過", evidence=evidence, phase="post-delivery")
        except ReadinessError as error:
            errors.append(f"{path.name}: {error}")
    return gate("galaxy-tab", "Galaxy Tab 100 分鐘真機驗收", "fail", "找到驗收檔但沒有一份可通過", evidence=errors, phase="post-delivery")


def validate_gold_sources(gold: dict[str, Any], gold_path: Path) -> None:
    for name, source in (gold.get("sources") or {}).items():
        path = Path(str(source.get("path") or ""))
        if not path.is_file() or sha256(path).upper() != str(source.get("sha256") or "").upper():
            raise ReadinessError(f"gold 來源 {name} 不存在或雜湊漂移")
    root = Path(str(gold.get("assetRoot") or gold_path.parent))
    for row in gold.get("cases") or []:
        assets = [row.get("studentEvidence"), *(row.get("solutionEvidence") or [])]
        for asset in assets:
            path = root / str((asset or {}).get("file") or "")
            if not path.is_file() or sha256(path).upper() != str((asset or {}).get("sha256") or "").upper():
                raise ReadinessError(f"第 {row.get('no')} 題 gold 像素不存在或雜湊漂移")


def identifiable_human(value: Any) -> bool:
    name = str(value or "").strip()
    return len(name) >= 3 and NON_HUMAN.search(name) is None


def approved_gold(gold: dict[str, Any], gold_path: Path | None = None) -> bool:
    approval = gold.get("releaseApproval") or {}
    if (gold.get("releaseAuthority") is not True
            or approval.get("kind") != "named-human-paper-detail-gold-signoff"
            or not identifiable_human(approval.get("approvedBy"))):
        return False
    try:
        unsigned = Path(str(approval.get("unsignedGoldPath") or ""))
        packet = Path(str(approval.get("reviewPacketPath") or ""))
        signoff_path = Path(str(approval.get("signoffPath") or ""))
        if (not unsigned.is_file() or not packet.is_file() or not signoff_path.is_file()
                or sha256(unsigned) != str(approval.get("unsignedGoldSha256") or "").lower()
                or sha256(packet) != str(approval.get("reviewPacketSha256") or "").lower()
                or sha256(signoff_path) != str(approval.get("signoffSha256") or "").lower()):
            return False
        signoff = load_json(signoff_path, "詳批 gold 簽核")
        return (signoff.get("kind") == "matha-paper-detail-gold-signoff"
                and signoff.get("releaseAuthority") is True
                and signoff.get("approvedBy") == approval.get("approvedBy")
                and signoff.get("goldId") == gold.get("id")
                and str(signoff.get("unsignedGoldSha256") or "").lower() == sha256(unsigned)
                and str(signoff.get("reviewPacketSha256") or "").lower() == sha256(packet))
    except (OSError, ReadinessError):
        return False


def audit_detail(private_eval_root: Path, gold_path: Path,
                 prediction_path: Path | None) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        signed_candidate = gold_path.with_name(f"{gold_path.stem}.signed{gold_path.suffix}")
        if signed_candidate.is_file():
            gold_path = signed_candidate
        gold = load_json(gold_path, "詳批 gold")
        cases = gold.get("cases") or []
        if {int(row.get("no") or 0) for row in cases} != REQUIRED_DETAIL_NOS:
            raise ReadinessError("詳批 gold 不是固定 7 題")
        validate_gold_sources(gold, gold_path)
    except ReadinessError as error:
        failed = gate("detail-eval", "7 題 GPT-5.5 詳批評測", "fail", str(error), phase="post-delivery")
        scale = gate("detail-gold-scale", "30 題真實詳批 gold", "fail", str(error), phase="post-delivery")
        return failed, scale

    if prediction_path is None:
        matches = find_json_files([private_eval_root], ["paper-*-detail-prediction*.json"])
        prediction_path = matches[0] if matches else None
    detail_gate: dict[str, Any]
    if prediction_path is None:
        detail_gate = gate(
            "detail-eval", "7 題 GPT-5.5 詳批評測", "blocked",
            "7 題來源像素已驗證，但尚無真實 prediction",
            evidence=[f"gold:{gold_path}", f"goldSha256:{sha256(gold_path)}"],
            blockers=["先在 App 保存真實隔日重想，再經正式 Edge Function 產生 7 題 prediction"],
            phase="post-delivery",
        )
    else:
        command = ["node", str(REPO_ROOT / "scripts" / "evaluate-paper-detail-gold.js"),
                   "--gold", str(gold_path), "--prediction", str(prediction_path), "--allow-fail"]
        completed = subprocess.run(command, cwd=REPO_ROOT, text=True, encoding="utf-8",
                                   capture_output=True, check=False)
        if completed.returncode:
            detail_gate = gate("detail-eval", "7 題 GPT-5.5 詳批評測", "fail", completed.stderr.strip()[:800], phase="post-delivery")
        else:
            result = json.loads(completed.stdout)
            if result.get("safeToShip") is True and approved_gold(gold, gold_path):
                detail_gate = gate("detail-eval", "7 題 GPT-5.5 詳批評測", "pass", "詳批門檻與具名真人簽核皆通過", evidence=[str(prediction_path), json.dumps(result.get("metrics"), ensure_ascii=False)], phase="post-delivery")
            else:
                detail_gate = gate("detail-eval", "7 題 GPT-5.5 詳批評測", "blocked", "prediction 已評測但正式門檻或具名真人簽核未完成", evidence=[json.dumps(result.get("gates"), ensure_ascii=False)], blockers=["修正未通過門檻，並完成 exact-hash 具名真人 gold 簽核"], phase="post-delivery")

    released_cases: set[tuple[str, int]] = set()
    for path in find_json_files([private_eval_root], ["paper-*-detail-gold*.json"]):
        try:
            value = load_json(path, "詳批 gold")
            if not approved_gold(value, path):
                continue
            validate_gold_sources(value, path)
            for row in value.get("cases") or []:
                released_cases.add((str(value.get("id")), int(row.get("no") or 0)))
        except (ReadinessError, ValueError):
            continue
    if len(released_cases) >= 30:
        scale_gate = gate("detail-gold-scale", "30 題真實詳批 gold", "pass", f"已有 {len(released_cases)} 題具名真人簽核 gold", phase="post-delivery")
    else:
        scale_gate = gate("detail-gold-scale", "30 題真實詳批 gold", "blocked", f"目前具名真人簽核 gold {len(released_cases)} / 30 題", blockers=[f"仍需 {30 - len(released_cases)} 題真實錯題 gold"], phase="post-delivery")
    return detail_gate, scale_gate


def release_object_rows(plan: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if (plan.get("kind") != "matha-private-storage-upload-plan"
            or plan.get("version") != 1
            or plan.get("releaseReady") is not True
            or plan.get("uploadPerformed") is not False):
        raise ReadinessError("上傳計畫不是可發布的私有題庫")
    release_id = plan.get("releaseId")
    if not isinstance(release_id, str) or not release_id:
        raise ReadinessError("上傳計畫缺少 releaseId")
    alias_path = plan.get("manifestAlias")
    versioned_manifest = plan.get("versionedManifest")
    legacy_manifest = f"releases/{release_id}/manifest.json"
    addressed_manifest = re.fullmatch(
        rf"releases/{re.escape(release_id)}/manifests/manifest-[a-f0-9]{{16}}\.json",
        str(versioned_manifest or ""),
    )
    if alias_path != EXPECTED_MANIFEST_ALIAS:
        raise ReadinessError("上傳計畫不是 App 使用的固定 alias")
    if versioned_manifest != legacy_manifest and addressed_manifest is None:
        raise ReadinessError("上傳計畫的版本化 manifest 路徑不符")
    summary = plan.get("summary")
    question_count = summary.get("questions") if isinstance(summary, dict) else None
    content_file_count = summary.get("contentFiles") if isinstance(summary, dict) else None
    if (not isinstance(question_count, int) or isinstance(question_count, bool)
            or question_count < 1
            or not isinstance(content_file_count, int) or isinstance(content_file_count, bool)
            or content_file_count < 4
            or summary.get("stemAssets") != question_count):
        raise ReadinessError("上傳計畫摘要不是有效的正式 bundle")
    if not re.fullmatch(r"[a-f0-9]{64}", str(plan.get("sourceSha256") or "")):
        raise ReadinessError("上傳計畫缺少簽核題源雜湊")
    buckets = plan.get("buckets")
    if not isinstance(buckets, dict) or set(buckets) != {"matha-content", "matha-figures"}:
        raise ReadinessError("上傳計畫缺少 bucket 清冊")
    versioned: list[dict[str, Any]] = []
    alias_row = None
    seen: set[tuple[str, str]] = set()
    for bucket in ("matha-content", "matha-figures"):
        payload = buckets.get(bucket)
        files = payload.get("files") if isinstance(payload, dict) else None
        if not isinstance(files, list):
            raise ReadinessError(f"上傳計畫 bucket 不完整：{bucket}")
        for raw in files:
            if not isinstance(raw, dict):
                raise ReadinessError(f"上傳計畫物件不合法：{bucket}")
            row = {key: raw.get(key) for key in ("path", "sha256", "bytes")}
            if (not isinstance(row["path"], str) or not row["path"]
                    or not re.fullmatch(r"[a-f0-9]{64}", str(row["sha256"] or ""))
                    or not isinstance(row["bytes"], int) or isinstance(row["bytes"], bool)
                    or row["bytes"] < 0):
                raise ReadinessError(f"上傳計畫物件欄位不完整：{bucket}")
            normalized = {"bucket": bucket, **row}
            key = (bucket, row["path"])
            if key in seen:
                raise ReadinessError(f"上傳計畫有重複物件：{bucket}/{row['path']}")
            seen.add(key)
            if bucket == "matha-content" and row["path"] == alias_path:
                if alias_row is not None:
                    raise ReadinessError("上傳計畫有重複 alias")
                alias_row = normalized
            else:
                if not row["path"].startswith(f"releases/{release_id}/"):
                    raise ReadinessError(f"上傳計畫含非版本化物件：{bucket}/{row['path']}")
                versioned.append(normalized)
    if alias_row is None:
        raise ReadinessError("上傳計畫找不到 alias 物件")
    content_count = sum(row["bucket"] == "matha-content" for row in versioned)
    figure_count = sum(row["bucket"] == "matha-figures" for row in versioned)
    if (content_count != content_file_count - 1
            or figure_count != question_count
            or len(versioned) != (content_file_count - 1) + question_count):
        raise ReadinessError("上傳計畫物件分布與宣告題數不一致")
    if not any(row["bucket"] == "matha-content"
               and row["path"] == versioned_manifest for row in versioned):
        raise ReadinessError("上傳計畫缺少版本化 manifest")
    return versioned, alias_row


def runtime_object_set(plan: dict[str, Any]) -> tuple[str, dict[str, Any], int, int]:
    versioned, alias_row = release_object_rows(plan)
    canonical = json.dumps(
        sorted(versioned, key=lambda row: (row["bucket"], row["path"])),
        ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")
    content_count = sum(row["bucket"] == "matha-content" for row in versioned)
    figure_count = sum(row["bucket"] == "matha-figures" for row in versioned)
    return hashlib.sha256(canonical).hexdigest(), alias_row, content_count, figure_count


def validate_deployment_record(plan_path: Path, record_path: Path) \
        -> tuple[dict[str, Any], datetime]:
    plan = load_json(plan_path, "上傳計畫")
    versioned, alias_row = release_object_rows(plan)
    record = load_json(record_path, "部署記錄")
    alias = record.get("alias") or {}
    if (record.get("kind") != "matha-private-storage-deployment"
            or record.get("version") != 1
            or record.get("state") != "deployed"
            or record.get("rollbackAvailable") is not True
            or record.get("releaseId") != plan.get("releaseId")
            or record.get("projectUrl") != EXPECTED_SUPABASE_URL
            or record.get("uploadPlanSha256") != sha256(plan_path)):
        raise ReadinessError("部署記錄不是目前 App 專案的已完成發布")
    deployed_at = parse_timestamp(record.get("deployedAt"), "部署記錄")
    prepared_at = parse_timestamp(record.get("preparedAt"), "部署準備記錄")
    if deployed_at < prepared_at:
        raise ReadinessError("部署完成時間早於準備時間")
    if ((alias.get("bucket"), alias.get("path"), alias.get("newSha256")) !=
            (alias_row["bucket"], alias_row["path"], alias_row["sha256"])):
        raise ReadinessError("部署記錄 alias 與上傳計畫不一致")
    previous_sha = str(alias.get("previousSha256") or "")
    if (not re.fullmatch(r"[a-f0-9]{64}", previous_sha)
            or previous_sha == alias_row["sha256"]):
        raise ReadinessError("部署記錄缺少可回復的不同舊 alias")
    try:
        previous = base64.b64decode(alias.get("previousBytesBase64"), validate=True)
    except (TypeError, ValueError) as error:
        raise ReadinessError("部署記錄舊 alias 位元不合法") from error
    if hashlib.sha256(previous).hexdigest() != previous_sha:
        raise ReadinessError("部署記錄舊 alias 位元與雜湊不一致")
    uploaded = record.get("uploaded")
    if not isinstance(uploaded, list):
        raise ReadinessError("部署記錄缺少完整上傳清冊")
    expected_uploaded = sorted(versioned, key=lambda row: (row["bucket"], row["path"]))
    actual_uploaded = []
    for raw in uploaded:
        if not isinstance(raw, dict):
            raise ReadinessError("部署記錄上傳清冊格式不合法")
        actual_uploaded.append({key: raw.get(key) for key in ("bucket", "path", "sha256", "bytes")})
    actual_uploaded.sort(key=lambda row: (str(row["bucket"]), str(row["path"])))
    if actual_uploaded != expected_uploaded:
        raise ReadinessError("部署記錄未精確涵蓋本 release 的版本化物件")
    return record, deployed_at


def validate_rollback_record(path: Path, deployment_path: Path,
                             deployment: dict[str, Any], deployed_at: datetime) \
        -> tuple[dict[str, Any], datetime]:
    value = load_json(path, "回滾演練")
    alias = deployment.get("alias") or {}
    if (value.get("kind") != "matha-private-storage-rollback"
            or value.get("version") != 1
            or value.get("releaseId") != deployment.get("releaseId")
            or value.get("deploymentRecordSha256") != sha256(deployment_path)
            or value.get("restoredAliasSha256") != alias.get("previousSha256")):
        raise ReadinessError("回滾演練未精確綁定初次部署與舊 alias")
    rolled_back_at = parse_timestamp(value.get("rolledBackAt"), "回滾演練")
    if rolled_back_at <= deployed_at:
        raise ReadinessError("回滾時間未晚於初次部署")
    return value, rolled_back_at


def validate_signed_starter(path: Path) -> tuple[dict[str, Any], list[str]]:
    signed = load_json(path, "代理簽核題源")
    approval = signed.get("releaseApproval") or {}
    direct_hashes = (signed.get("reviewAudit") or {}).get("directReviewSha256")
    approval_hashes = approval.get("delegatedReviewSha256")
    if isinstance(approval_hashes, str):
        approval_hashes = [approval_hashes]
    questions = signed.get("questions")
    if (signed.get("schema") != 3
            or signed.get("kind") != "private-question-source"
            or any(signed.get(key) != value for key, value in EXPECTED_CORPUS.items())
            or signed.get("originalPdfVerified") is not True
            or signed.get("answerKeyVerified") is not True
            or signed.get("mathematicalCorrectnessVerified") is not True
            or signed.get("reviewPolicy") != EXPECTED_REVIEW_POLICY
            or approval.get("kind") != "owner-delegated-agent-starter-private-release-signoff"
            or int(approval.get("version") or 0) != (
                1 if isinstance(direct_hashes, list) and len(direct_hashes) == 1 else 2
            )
            or not identifiable_human(signed.get("releaseApprovedBy"))
            or approval.get("authorizedBy") != signed.get("releaseApprovedBy")
            or approval.get("humanPixelReviewClaimed") is not False
            or not isinstance(approval.get("performedBy"), str)
            or NON_HUMAN.search(approval["performedBy"]) is None
            or not isinstance(direct_hashes, list) or not direct_hashes
            or approval_hashes != direct_hashes
            or any(not re.fullmatch(r"[a-f0-9]{64}", str(value))
                   for value in direct_hashes)
            or not isinstance(questions, list) or not questions):
        raise ReadinessError("簽核題源的世代、授權、題目或逐批雜湊不完整")
    question_ids: set[str] = set()
    for row in questions:
        if not isinstance(row, dict):
            raise ReadinessError("簽核題源含非物件題目")
        qid = row.get("id")
        stem = row.get("stemAsset") or {}
        answer = row.get("answerVerification") or {}
        structured = answer.get("structuredAnswer") or {}
        if (not isinstance(qid, str) or not qid or qid in question_ids
                or not isinstance(row.get("ans"), list) or not row["ans"]
                or not isinstance(row.get("sol"), str) or not row["sol"].strip()
                or row.get("displayTruth") != "original-pdf-crop"
                or row.get("needsStemAsset") is not True
                or stem.get("assetStatus") != "verified"
                or stem.get("containsAnswer") is not False
                or stem.get("containsSolution") is not False
                or stem.get("containsHandwriting") is not False
                or not re.fullmatch(r"[a-f0-9]{64}", str(stem.get("sha256") or ""))
                or not re.fullmatch(r"[a-f0-9]{64}",
                                    str(answer.get("officialAnswerSha256") or ""))
                or structured.get("schema") != 1):
            raise ReadinessError(f"簽核題源題面或官方答案鏈不完整：{qid}")
        question_ids.add(qid)
    samples = approval.get("sampleQuestionIds")
    if (not isinstance(samples, list) or not samples
            or any(item not in question_ids for item in samples)):
        raise ReadinessError("簽核題源抽查題號未綁定完整題目集合")
    return signed, [
        f"signed:{sha256(path)}",
        *[f"direct:{value}" for value in direct_hashes],
        f"questions:{len(questions)}:unique={len(question_ids)}",
    ]


def validate_runtime_pointer(path: Path, runtime: dict[str, Any]) -> None:
    """Prove that the latest mutable pointer names immutable evidence."""
    role = runtime.get("recordRole")
    if role != "current-pointer":
        raise ReadinessError("runtime 完工證據必須是綁定不可覆寫檔的 current pointer")
    name = runtime.get("immutableRecord")
    expected_sha = str(runtime.get("immutableRecordSha256") or "")
    if (not isinstance(name, str) or not name or Path(name).name != name
            or not re.fullmatch(r"[a-f0-9]{64}", expected_sha)):
        raise ReadinessError("runtime current pointer 缺少不可覆寫證據綁定")
    immutable_path = path.with_name(name)
    if not immutable_path.is_file() or sha256(immutable_path) != expected_sha:
        raise ReadinessError("runtime 不可覆寫證據不存在或雜湊漂移")
    immutable = load_json(immutable_path, "runtime 不可覆寫證據")
    pointer_payload = {
        key: value for key, value in runtime.items()
        if key not in {"recordRole", "immutableRecord", "immutableRecordSha256"}
    }
    if immutable != pointer_payload:
        raise ReadinessError("runtime current pointer 與不可覆寫證據內容不一致")


def validate_runtime_verification(path: Path, plan_path: Path,
                                  record_path: Path, signed_path: Path,
                                  *, not_before: datetime | None = None) -> list[str]:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
    except ValueError:
        pass
    else:
        raise ReadinessError("runtime 驗證記錄不可放進公開 repo")
    runtime = load_json(path, "正式題庫 runtime 驗證")
    validate_runtime_pointer(path, runtime)
    plan = load_json(plan_path, "上傳計畫")
    signed, _ = validate_signed_starter(signed_path)
    if plan.get("sourceSha256") != sha256(signed_path):
        raise ReadinessError("runtime 所依據的上傳計畫未綁定簽核真值")
    authorization = (runtime.get("trust") or {}).get("authorizationChain")
    evidence_files = authorization.get("evidenceFiles") \
        if isinstance(authorization, dict) else None
    if not isinstance(evidence_files, dict):
        raise ReadinessError("runtime 缺少逐題審核與官方答案裁圖實檔證據")

    def evidence_paths(key: str) -> list[Path]:
        rows = evidence_files.get(key)
        if not isinstance(rows, list) or not rows:
            raise ReadinessError(f"runtime 缺少完整 {key} 實檔清單")
        paths: list[Path] = []
        for row in rows:
            value = row.get("path") if isinstance(row, dict) else None
            if not isinstance(value, str) or not value.strip():
                raise ReadinessError(f"runtime {key} 實檔路徑不合法")
            paths.append(Path(value))
        return paths

    direct_review_paths = evidence_paths("directReviews")
    dual_review_paths = evidence_paths("dualReviews")
    answer_binding_paths = evidence_paths("answerBindings")
    verifier = runtime_verifier()
    try:
        signed, _, signed_answer_modes, authoritative_chain = (
            verifier._validate_signed_source(
                signed_path, plan, plan.get("releaseId"),
                direct_review_paths, dual_review_paths, answer_binding_paths,
            )
        )
    except (verifier.RuntimeVerificationError, OSError, ValueError) as error:
        raise ReadinessError(f"簽核真值未通過正式 runtime 驗證器：{error}") from error
    record, deployed_at = validate_deployment_record(plan_path, record_path)
    object_set_sha, alias_row, content_objects, stem_assets = runtime_object_set(plan)
    record_alias = record.get("alias") or {}
    if ((record_alias.get("bucket"), record_alias.get("path"),
         record_alias.get("newSha256")) !=
            (alias_row["bucket"], alias_row["path"], alias_row["sha256"])):
        raise ReadinessError("runtime 所依據的不是本 bundle 最終部署記錄")
    binding = {
        "releaseId": plan.get("releaseId"),
        "uploadPlanSha256": sha256(plan_path),
        "deploymentRecordSha256": sha256(record_path),
        "signedSourceSha256": sha256(signed_path),
        "aliasSha256": alias_row["sha256"],
        "versionedObjectSetSha256": object_set_sha,
        "appVersion": current_app_version(),
        "appJsSha256": sha256(REPO_ROOT / "app.js"),
        "textbookCatalogSha256": sha256(REPO_ROOT / "textbook-catalog.js"),
    }
    binding_sha = canonical_sha(binding)
    verified_at = parse_timestamp(runtime.get("verifiedAt"), "runtime 驗證")
    lower_bound = max(deployed_at, not_before) if not_before is not None else deployed_at
    if verified_at <= lower_bound:
        raise ReadinessError("runtime 驗證必須晚於回滾後最終部署")
    if (runtime.get("kind") != "matha-private-release-runtime-verification"
            or runtime.get("version") != 2
            or runtime.get("status") != "verified"
            or any(runtime.get(key) != value for key, value in binding.items())
            or runtime.get("releaseAppBindingSha256") != binding_sha
            or runtime.get("projectUrl") != EXPECTED_SUPABASE_URL
            or record.get("projectUrl") != EXPECTED_SUPABASE_URL):
        raise ReadinessError("runtime 記錄未綁定最終部署、物件集合、簽核真值或目前 App")
    alias = runtime.get("alias") or {}
    if alias != {
        "bucket": alias_row["bucket"], "path": alias_row["path"],
        "sha256": alias_row["sha256"], "bytes": alias_row["bytes"],
    }:
        raise ReadinessError("runtime alias 回讀證據不一致")
    readback = runtime.get("readback") or {}
    if readback != {
        "aliasObjects": 1,
        "versionedObjects": content_objects + stem_assets,
        "contentObjects": content_objects,
        "stemAssets": stem_assets,
        "hashMismatches": 0,
        "missingObjects": 0,
    }:
        raise ReadinessError("runtime 未完整讀回全部私有物件")
    content = runtime.get("content") or {}
    topics = content.get("topics") or {}
    topic_values = list(topics.values()) if isinstance(topics, dict) else []
    question_count = len(signed["questions"])
    summary = plan.get("summary") or {}
    pack_count = summary.get("contentFiles", 0) - 3 \
        if isinstance(summary.get("contentFiles"), int) else -1
    expected_topic_counts = Counter(
        question["topic"] for question in signed["questions"]
    )
    expected_role_counts = Counter(
        question["role"] for question in signed["questions"]
    )
    if (content.get("questions") != question_count or content.get("packs") != pack_count
            or not isinstance(topics, dict) or set(topics) != EXPECTED_TOPICS
            or any(not isinstance(value, int) or isinstance(value, bool)
                   or value < 1 for value in topic_values)
            or Counter(topics) != expected_topic_counts
            or Counter(content.get("roles") or {}) != expected_role_counts
            or content.get("answerModes") != signed_answer_modes
            or content.get("answersVerifiedAgainstSignedSource") != question_count
            or content.get("pendingVisuals") != 0
            or content_objects != summary.get("contentFiles", 0) - 1
            or stem_assets != question_count):
        raise ReadinessError("runtime 題數、題包、單元、角色或答案分布不符簽核版本")
    trust = runtime.get("trust") or {}
    authorization = trust.get("authorizationChain")
    if authorization != authoritative_chain:
        raise ReadinessError("runtime 授權鏈未精確綁定簽核真值")
    answer_evidence = [
        {
            "id": question["id"], "ans": question["ans"],
            "sol": question["sol"],
            "answerVerification": question["answerVerification"],
        }
        for question in signed["questions"]
    ]
    if (any(trust.get(key) != value for key, value in EXPECTED_CORPUS.items())
            or trust.get("reviewPolicy") != EXPECTED_REVIEW_POLICY
            or trust.get("releaseApprovedBy") != signed.get("releaseApprovedBy")
            or trust.get("signedSourceQuestionSetSha256") != canonical_sha(signed["questions"])
            or trust.get("answerEvidenceSetSha256") != canonical_sha(answer_evidence)
            or trust.get("authorizationChainSha256") != canonical_sha(authorization)):
        raise ReadinessError("runtime 題源、官方答案或授權真值雜湊不一致")
    return [
        f"runtime:{sha256(path)}", f"release:{binding['releaseId']}",
        f"alias:{binding['aliasSha256']}", f"app:{binding['appVersion']}:{binding['appJsSha256']}",
        f"signedSource:{binding['signedSourceSha256']}",
        f"readback:alias=1,versioned={content_objects + stem_assets},"
        f"questions={question_count},packs={pack_count},topics=14,answers={question_count}",
    ]


def validate_app_loader_verification(path: Path, plan_path: Path,
                                     record_path: Path, runtime_path: Path,
                                     *, not_before: datetime) -> list[str]:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
    except ValueError:
        pass
    else:
        raise ReadinessError("App loader 驗證記錄不可放進公開 repo")
    plan = load_json(plan_path, "上傳計畫")
    _, alias_row = release_object_rows(plan)
    runtime = load_json(runtime_path, "Storage 全量讀回")
    validate_runtime_pointer(runtime_path, runtime)
    signed_path = Path(str(plan.get("source") or ""))
    if not signed_path.is_absolute():
        signed_path = plan_path.resolve().parent / signed_path
    if not signed_path.is_file() or sha256(signed_path) != plan.get("sourceSha256"):
        raise ReadinessError("App loader 所綁定的簽核題源不存在或雜湊漂移")
    value = load_json(path, "登入 App loader 驗證")
    verifier = app_loader_verifier()
    try:
        verifier.validate_app_loader_evidence(value)
    except (verifier.AppLoaderVerificationError, OSError, ValueError) as error:
        raise ReadinessError(f"登入 App loader 未通過正式證據驗證器：{error}") from error
    verified_at = parse_timestamp(value.get("verifiedAt"), "登入 App loader 驗證")
    if verified_at <= not_before:
        raise ReadinessError("登入 App loader 驗證必須晚於 Storage 全量讀回")
    if runtime.get("recordRole") == "current-pointer":
        pointer_sha: str | None = sha256(runtime_path)
        immutable_name = runtime.get("immutableRecord")
        immutable_sha = runtime.get("immutableRecordSha256")
    else:
        pointer_sha = None
        immutable_name = runtime_path.name
        immutable_sha = sha256(runtime_path)
    binding = {
        "releaseId": plan.get("releaseId"),
        "uploadPlanSha256": sha256(plan_path),
        "deploymentRecordSha256": sha256(record_path),
        "storageRuntimeRecordSha256": sha256(runtime_path),
        "storageRuntimeCurrentPointerSha256": pointer_sha,
        "storageRuntimeImmutableRecord": immutable_name,
        "storageRuntimeImmutableRecordSha256": immutable_sha,
        "storageRuntimeBindingSha256": runtime.get("releaseAppBindingSha256"),
        "signedSourceSha256": sha256(signed_path),
        "aliasSha256": alias_row["sha256"],
        "appVersion": current_app_version(),
        "appJsSha256": sha256(REPO_ROOT / "app.js"),
        "textbookCatalogSha256": sha256(REPO_ROOT / "textbook-catalog.js"),
        "projectUrl": EXPECTED_SUPABASE_URL,
    }
    if (value.get("kind") != "matha-private-app-loader-verification"
            or value.get("version") != 1
            or value.get("status") != "verified"
            or any(value.get(key) != expected for key, expected in binding.items())
            or value.get("appLoaderBindingSha256") != canonical_sha(binding)):
        raise ReadinessError("登入 App loader 記錄未綁定最終部署、Storage 證據與目前 App")
    authentication = value.get("authentication") or {}
    if (authentication.get("mode") not in {
            "provided-user-access-token", "admin-generated-one-time-magiclink",
            }
            or authentication.get("realUserSession") is not True
            or authentication.get("appUserEnabled") is not True
            or authentication.get("serviceRoleUsedForStorage") is not False
            or authentication.get("credentialsSerialized") is not False):
        raise ReadinessError("登入 App loader 未使用啟用中的真實使用者與 RLS")
    loader = value.get("loader") or {}
    topics = loader.get("topics") or {}
    runtime_content = runtime.get("content") or {}
    question_count = runtime_content.get("questions")
    pack_count = runtime_content.get("packs")
    expected_roles = runtime_content.get("roles")
    if (loader.get("alias") != EXPECTED_MANIFEST_ALIAS
            or loader.get("aliasRoute") != "authenticated-jwt-signed-url"
            or loader.get("packs") != pack_count
            or loader.get("packRoute") != "authenticated-jwt-storage-rls"
            or loader.get("packHashMismatches") != 0
            or loader.get("questions") != question_count
            or loader.get("questionSchemaFailures") != 0
            or loader.get("quarantinedQuestions") != 0
            or not isinstance(topics, dict) or set(topics) != EXPECTED_TOPICS
            or any(not isinstance(count, int) or isinstance(count, bool)
                   or count < 1 for count in topics.values())
            or sum(topics.values()) != question_count
            or loader.get("roles") != expected_roles):
        raise ReadinessError("登入 App loader 題包、題數、隔離或分布證據不完整")
    sample = value.get("stemAssetSample") or {}
    count = sample.get("count")
    ids = sample.get("questionIds")
    if (not isinstance(count, int) or isinstance(count, bool) or count < 14
            or not isinstance(ids, list) or len(ids) != count or len(set(ids)) != count
            or sample.get("coveredTopics") != sorted(EXPECTED_TOPICS)
            or sample.get("coveredRoles") != sorted(expected_roles)
            or sample.get("authenticatedRlsDownloads") != count
            or sample.get("signedUrlCrossChecks") != count
            or sample.get("hashMismatches") != 0):
        raise ReadinessError("登入 App loader 題圖 RLS／signed URL 覆蓋不足")
    readback = value.get("stemAssetReadback") or {}
    if (readback.get("count") != question_count
            or readback.get("authenticatedRlsDownloads") != question_count
            or readback.get("missingObjects") != 0
            or readback.get("hashMismatches") != 0):
        raise ReadinessError("登入 App loader 未以一般使用者 RLS 完整讀回全部題圖")
    return [
        f"appLoader:{sha256(path)}",
        f"storageRuntime:{binding['storageRuntimeRecordSha256']}",
        f"auth:{authentication['mode']}:serviceRoleStorage=false",
        f"loader:packs={pack_count},questions={question_count},quarantined=0,"
        f"stemRls={question_count},stemSamples={count}",
    ]


def _ordered_evidence_files(candidates: list[Path], expected_hashes: list[str],
                            label: str) -> list[Path]:
    by_hash: dict[str, list[Path]] = {}
    for path in candidates:
        try:
            by_hash.setdefault(sha256(path), []).append(path)
        except OSError:
            continue
    ordered: list[Path] = []
    for expected in expected_hashes:
        matches = by_hash.get(expected) or []
        if not matches:
            raise ReadinessError(f"找不到簽核鏈指定的 {label} 實檔：{expected}")
        ordered.append(sorted(matches, key=lambda value: str(value).casefold())[0])
    return ordered


def validate_starter_review_files(signed_path: Path, plan_path: Path,
                                  search_root: Path) -> list[str]:
    """Re-run the authoritative signed review against real private files."""
    signed = load_json(signed_path, "Starter 簽核題源")
    audit = signed.get("reviewAudit") or {}
    direct_hashes = audit.get("directReviewSha256")
    dual_hashes = audit.get("dualReviewSha256")
    if not isinstance(direct_hashes, list) or not isinstance(dual_hashes, list):
        raise ReadinessError("Starter 簽核題源缺少 direct／dual 實檔雜湊鏈")
    direct_candidates = find_json_files(
        [search_root], ["*decisions*.json", "*direct-review*.json", "delegated-review.json"],
    )
    dual_candidates = find_json_files(
        [search_root], [
            "*owner-delegated-intersection*.json",
            "owner-delegated-review.intersection.json",
            "dual-review.json",
        ],
    )
    binding_candidates = find_json_files(
        [search_root], ["answer-binding-candidates.json"],
    )
    direct_paths = _ordered_evidence_files(
        direct_candidates, [str(value) for value in direct_hashes], "direct review",
    )
    dual_paths = _ordered_evidence_files(
        dual_candidates, [str(value) for value in dual_hashes], "dual review",
    )
    binding_hashes: list[str] = []
    for path in dual_paths:
        value = load_json(path, "Starter dual review")
        hash_value = str(value.get("answerBindingSha256") or "")
        if not re.fullmatch(r"[a-f0-9]{64}", hash_value):
            raise ReadinessError(f"dual review 缺少官方答案來源雜湊：{path}")
        binding_hashes.append(hash_value)
    binding_paths = _ordered_evidence_files(
        binding_candidates, binding_hashes, "answer binding",
    )
    verifier = runtime_verifier()
    plan = load_json(plan_path, "Starter 上傳計畫")
    try:
        _, questions, _, chain = verifier._validate_signed_source(
            signed_path, plan, plan.get("releaseId"),
            direct_paths, dual_paths, binding_paths,
        )
    except (verifier.RuntimeVerificationError, OSError, ValueError) as error:
        raise ReadinessError(f"Starter 審核實檔未通過正式驗證器：{error}") from error
    binding_rows = chain["evidenceFiles"]["answerBindings"]
    question_count = len(signed.get("questions") or [])
    if (len(questions) != question_count
            or sum(row["answerAssetCount"] for row in binding_rows) != question_count):
        raise ReadinessError("Starter 審核實檔未完整涵蓋全部題目與官方答案裁圖")
    return [
        *[f"directFile:{sha256(path)}" for path in direct_paths],
        *[f"dualFile:{sha256(path)}" for path in dual_paths],
        *[f"answerBinding:{sha256(path)}" for path in binding_paths],
        f"answerCrops:{question_count}:hashVerified={question_count}",
    ]


def _source_contract_gate(identifier: str, label: str, paths: list[Path],
                          required_text: list[str], summary: str) -> dict[str, Any]:
    try:
        missing = [str(path.relative_to(REPO_ROOT)) for path in paths if not path.is_file()]
        if missing:
            raise ReadinessError(f"缺少工程檔案：{', '.join(missing)}")
        source = "\n".join(path.read_text(encoding="utf-8") for path in paths)
        absent = [text for text in required_text if text not in source]
        if absent:
            raise ReadinessError(f"驗收案例未覆蓋：{absent[0]}")
        evidence = canonical_sha({
            str(path.relative_to(REPO_ROOT)).replace("\\", "/"): sha256(path)
            for path in paths
        })
        return gate(identifier, label, "pass", summary, evidence=[f"sourceSet:{evidence}"])
    except (OSError, ReadinessError) as error:
        return gate(identifier, label, "fail", str(error))


def audit_core_feature_contracts() -> list[dict[str, Any]]:
    """Make core App contracts first-class gates instead of hiding them in CI."""
    package_path = REPO_ROOT / "package.json"
    ci_path = REPO_ROOT / ".github" / "workflows" / "ci.yml"
    pages_path = REPO_ROOT / ".github" / "workflows" / "pages.yml"
    try:
        package = load_json(package_path, "package.json")
        scripts = package.get("scripts") or {}
        full_command = "npm test && npm run test:figures && npm run test:edge"
        if (full_command not in ci_path.read_text(encoding="utf-8")
                or full_command not in pages_path.read_text(encoding="utf-8")
                or not all(isinstance(scripts.get(name), str) and scripts[name]
                           for name in ("test", "test:figures", "test:postgres", "test:edge"))):
            raise ReadinessError("CI 與 Pages 尚未同時執行 Web、Python/PostgreSQL、Edge 全套測試")
        workflow_sha = canonical_sha({
            "package": sha256(package_path), "ci": sha256(ci_path),
            "pages": sha256(pages_path),
        })
        pipeline = gate(
            "core-test-pipeline", "核心測試管線", "pass",
            "CI 與 Pages 都明確執行 Web、Python/PostgreSQL 與完整 Edge 測試",
            evidence=[f"workflowSet:{workflow_sha}"],
        )
    except (OSError, ReadinessError) as error:
        pipeline = gate("core-test-pipeline", "核心測試管線", "fail", str(error))

    migration_paths = sorted((REPO_ROOT / "supabase" / "migrations").glob("2026083000*.sql"))
    expected_migrations = {f"2026083000{number:02d}" for number in range(1, 12)}
    actual_migrations = {path.stem.split("_")[0] for path in migration_paths}
    grading_paths = [
        REPO_ROOT / "tests" / "paper-grade-idempotency.test.js",
        REPO_ROOT / "tests" / "learning-loop.test.js",
        REPO_ROOT / "tests" / "paper-detail-gold.test.js",
        REPO_ROOT / "supabase" / "functions" / "openai-proxy" / "paper-grade-model-input.test.ts",
        REPO_ROOT / "supabase" / "functions" / "openai-proxy" / "paper-correction-grade-model-input.test.ts",
        REPO_ROOT / "supabase" / "functions" / "openai-proxy" / "paper-detail-model-input.test.ts",
        *migration_paths,
    ]
    grading = _source_contract_gate(
        "grading-correction-engineering", "批改與隔日訂正工程合約", grading_paths,
        [
            "逐題詳批只接受與工作、輸入、結果完全一致的不可變完成收據",
            "隔日訂正保存失敗時不呼叫逐題詳解",
            "first pass generation 0 pending is fail-closed and does not issue/reinvoke another generation",
            "browser composites and messages are not part of the authority API",
        ],
        "首輪批改、隔日訂正、第一錯步詳批、去重與不可變收據都有獨立驗收案例",
    )
    if actual_migrations != expected_migrations:
        grading = gate(
            "grading-correction-engineering", "批改與隔日訂正工程合約", "fail",
            f"正式 DB migration 不完整：{len(actual_migrations)} / 11",
        )

    durability = _source_contract_gate(
        "tablet-safety-engineering", "長考保存、救援與平板互動工程合約",
        [
            REPO_ROOT / "tests" / "paper-stress.test.js",
            REPO_ROOT / "tests" / "paper-stability.test.js",
            REPO_ROOT / "tests" / "learning-loop.test.js",
            REPO_ROOT / "tests" / "ui.test.js",
        ],
        [
            "6 頁、1200 筆 journal 壓力合併不遺失不重複",
            "虛擬 80 分鐘共 960 次 heartbeat 後當機",
            "當機恢復必須讓當機前與重載後的整份筆跡 SHA-256 完全相同",
            "S Pen 側鍵暫時切換橡皮擦",
            "原版模考支援雙指以手勢中心縮放",
            "原版模考單指水平滑動翻頁",
            "內建 PDF 生成器輸出真正多頁 PDF 位元組",
        ],
        "長考增量保存、當機恢復、S Pen、雙指縮放、滑動翻頁與 PDF 救援均有獨立驗收案例",
    )

    personalization = _source_contract_gate(
        "personalization-report-engineering", "個人化推薦與老師週報工程合約",
        [
            REPO_ROOT / "tests" / "learner-model.test.js",
            REPO_ROOT / "tests" / "learning-loop.test.js",
            REPO_ROOT / "tests" / "ui.test.js",
        ],
        [
            "教材精選冷啟動與能力變化都有明確三帶配額",
            "老師具名修正保留 AI 原判與每次歷史",
            "老師單頁只把跨兩題以上的流程錯誤列為反覆斷點",
            "首頁只列最多兩個真的到期閉環",
            "推薦題換題與品質回報不會污染作答證據",
        ],
        "弱點證據、推薦限流、冷啟動、首頁閉環與老師報告都有獨立驗收案例",
    )
    return [pipeline, grading, durability, personalization]


def audit_starter(work_root: Path) -> tuple[
        dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    search_root = work_root.parent if work_root.parent.is_dir() else work_root
    signed_paths = find_json_files(
        [work_root, search_root], ["signed-private-question-source.json"],
    )
    valid_signed: dict[str, tuple[Path, dict[str, Any], list[str]]] = {}
    signed_errors: list[str] = []
    for path in signed_paths:
        try:
            signed, evidence = validate_signed_starter(path)
            valid_signed.setdefault(sha256(path), (path, signed, evidence))
        except ReadinessError as error:
            signed_errors.append(str(error))
    if not valid_signed:
        review = gate(
            "starter-safe-review", "Starter 題庫逐題安全審核與發布授權",
            "fail" if signed_paths else "blocked",
            signed_errors[0] if signed_errors else "尚無可驗證簽核題源",
            blockers=[] if signed_paths else ["完成逐題像素、官方答案、數學正確性與發布授權鏈"],
        )
        signed_path = None
        signed = None
    else:
        largest = max(len(row[1].get("questions") or []) for row in valid_signed.values())
        newest = [row for row in valid_signed.values()
                  if len(row[1].get("questions") or []) == largest]
        if len(newest) > 1:
            review = gate(
                "starter-safe-review", "Starter 題庫逐題安全審核與發布授權", "fail",
                f"找到多份不同的 {largest} 題簽核真值，拒絕猜測正式來源",
            )
            signed_path = None
            signed = None
        else:
            signed_path, signed, evidence = newest[0]
            review = gate(
                "starter-safe-review", "Starter 題庫逐題安全審核與發布授權", "pass",
                f"{largest} 題簽核真值格式有效，尚待核對 direct／dual／官方答案裁圖實檔",
                evidence=evidence,
            )

    plan_paths: list[Path] = []
    if signed_path is not None and signed is not None:
        for candidate in find_json_files([work_root, search_root], ["upload-plan.json"]):
            try:
                plan = load_json(candidate, "上傳計畫")
                release_object_rows(plan)
                if (plan.get("releaseId") == signed.get("releaseId")
                        and plan.get("sourceSha256") == sha256(signed_path)
                        and plan.get("releaseApprovedBy") == signed.get("releaseApprovedBy")):
                    plan_paths.append(candidate)
            except ReadinessError:
                continue

    if review["status"] == "pass":
        verified_review_evidence: list[str] | None = None
        review_errors: list[str] = []
        for plan_path in plan_paths:
            try:
                verified_review_evidence = validate_starter_review_files(
                    signed_path, plan_path, search_root,
                )
                break
            except ReadinessError as error:
                review_errors.append(str(error))
        if verified_review_evidence is None:
            review = gate(
                "starter-safe-review", "Starter 題庫逐題安全審核與發布授權",
                "fail" if plan_paths and review_errors else "blocked",
                review_errors[0] if review_errors
                else "仍缺 exact-hash bundle 或 direct／dual／官方答案裁圖實檔",
                blockers=[] if review_errors else [
                    "補齊 signed source 指定的 direct、dual 與全部官方答案裁圖後重驗",
                ],
            )
        else:
            review = gate(
                "starter-safe-review", "Starter 題庫逐題安全審核與發布授權", "pass",
                f"{len(signed.get('questions') or [])} 題已由透明代理逐像素核對原題與官方答案；實檔與答案裁圖均逐雜湊重驗，未冒充真人 QA",
                evidence=[*evidence, *verified_review_evidence],
            )

    deployment_paths = find_json_files([work_root, search_root], ["*deployment*.json"])
    rollback_paths = find_json_files([work_root, search_root], ["*rollback*.json"])
    chains: list[dict[str, Any]] = []
    matching_deployment_evidence = False
    for plan_path in plan_paths:
        plan = load_json(plan_path, "上傳計畫")
        plan_sha = sha256(plan_path)
        deployments: list[tuple[Path, dict[str, Any], datetime]] = []
        for path in deployment_paths:
            try:
                raw = load_json(path, "部署記錄")
                if (raw.get("kind") != "matha-private-storage-deployment"
                        or raw.get("releaseId") != plan.get("releaseId")
                        or raw.get("uploadPlanSha256") != plan_sha):
                    continue
                matching_deployment_evidence = True
                record, deployed_at = validate_deployment_record(plan_path, path)
                deployments.append((path, record, deployed_at))
            except ReadinessError:
                continue
        for first_path, first, first_time in deployments:
            for rollback_path in rollback_paths:
                try:
                    rollback, rollback_time = validate_rollback_record(
                        rollback_path, first_path, first, first_time,
                    )
                except ReadinessError:
                    continue
                for final_path, final, final_time in deployments:
                    if final_path.resolve() == first_path.resolve() \
                            or sha256(final_path) == sha256(first_path):
                        continue
                    final_prepared = parse_timestamp(final.get("preparedAt"), "最終部署準備記錄")
                    final_alias = final.get("alias") or {}
                    if (final_prepared <= rollback_time or final_time <= rollback_time
                            or final_alias.get("previousSha256") != rollback.get("restoredAliasSha256")
                            or final_alias.get("newSha256") != (first.get("alias") or {}).get("newSha256")):
                        continue
                    chains.append({
                        "planPath": plan_path,
                        "plan": plan,
                        "signedPath": signed_path,
                        "firstPath": first_path,
                        "first": first,
                        "firstAt": first_time,
                        "rollbackPath": rollback_path,
                        "rollback": rollback,
                        "rollbackAt": rollback_time,
                        "finalPath": final_path,
                        "final": final,
                        "finalAt": final_time,
                    })

    chain = max(chains, key=lambda row: row["finalAt"]) if chains else None
    if review["status"] != "pass" or not plan_paths:
        deployment_gate = gate(
            "starter-deployment", "Starter Supabase 私有發布、回滾與最終重部署",
            "blocked", "須先有唯一簽核真值與 exact-hash bundle",
            blockers=["以簽核題源建立正式上傳計畫"],
        )
    elif chain is None:
        deployment_gate = gate(
            "starter-deployment", "Starter Supabase 私有發布、回滾與最終重部署",
            "fail" if matching_deployment_evidence else "blocked",
            "現有紀錄無法證明初次部署 → 回滾舊 alias → 不同紀錄最終重部署"
            if matching_deployment_evidence else "尚未執行正式發布與回滾演練",
            blockers=[] if matching_deployment_evidence else [
                "依序完成首次部署、回滾前版 alias、再最終部署同一 release",
            ],
        )
    else:
        deployment_gate = gate(
            "starter-deployment", "Starter Supabase 私有發布、回滾與最終重部署", "pass",
            "初次部署、綁定該紀錄的回滾與回滾後最終重部署已依時間及雜湊串接",
            evidence=[
                f"plan:{sha256(chain['planPath'])}",
                f"firstDeployment:{sha256(chain['firstPath'])}",
                f"rollback:{sha256(chain['rollbackPath'])}",
                f"finalDeployment:{sha256(chain['finalPath'])}",
            ],
        )

    selected_runtime_path: Path | None = None
    selected_runtime_time: datetime | None = None
    if chain is None:
        runtime_gate = gate(
            "starter-storage-readback", "Starter Storage 全量讀回與簽核真值綁定",
            "blocked", "須先完成回滾後最終部署",
            blockers=["最終部署後讀回固定 alias 與全部版本物件"],
        )
    else:
        # Only the canonical current pointer written beside D2 may represent
        # current state. Historical/renamed pointer copies are evidence archives,
        # never alternate candidates for a mutable "current" decision.
        canonical_runtime = chain["finalPath"].with_name(
            "private-release-runtime-verification.json"
        )
        runtime_paths = [canonical_runtime] if canonical_runtime.is_file() else []
        valid_runtime: list[tuple[datetime, int, Path, list[str]]] = []
        runtime_errors: list[str] = []
        for path in runtime_paths:
            try:
                value = load_json(path, "Storage 全量讀回")
                if (value.get("kind") != "matha-private-release-runtime-verification"
                        or value.get("releaseId") != chain["plan"].get("releaseId")
                        or value.get("uploadPlanSha256") != sha256(chain["planPath"])
                        or value.get("deploymentRecordSha256") != sha256(chain["finalPath"])):
                    continue
                evidence = validate_runtime_verification(
                    path, chain["planPath"], chain["finalPath"], chain["signedPath"],
                    not_before=chain["rollbackAt"],
                )
                valid_runtime.append((
                    parse_timestamp(value.get("verifiedAt"), "Storage 全量讀回"),
                    int(value.get("recordRole") == "current-pointer"),
                    path, evidence,
                ))
            except ReadinessError as error:
                runtime_errors.append(str(error))
        if not valid_runtime:
            runtime_gate = gate(
                "starter-storage-readback", "Starter Storage 全量讀回與簽核真值綁定",
                "fail" if runtime_errors else "blocked",
                runtime_errors[0] if runtime_errors else "尚無綁定最終部署的 Storage 全量讀回證據",
                blockers=[] if runtime_errors else [
                    "讀回 alias、全部版本物件、題目／題包並核對簽核題源",
                ],
            )
        else:
            selected_runtime_time, _, selected_runtime_path, evidence = max(
                valid_runtime, key=lambda row: (row[0], row[1]),
            )
            runtime_gate = gate(
                "starter-storage-readback", "Starter Storage 全量讀回與簽核真值綁定", "pass",
                f"遠端 alias 與全部版本物件已逐位元讀回，{chain['plan']['summary']['questions']} 題已綁定簽核真值",
                evidence=[str(selected_runtime_path), *evidence],
            )

    if (chain is None or selected_runtime_path is None or selected_runtime_time is None):
        app_loader_gate = gate(
            "starter-authenticated-app-load", "Starter 登入使用者 App loader 實載",
            "blocked", "須先完成回滾後最終部署與 Storage 全量讀回",
            blockers=["以啟用中的一般使用者 JWT 驗證 RLS、signed URL、全部題包與題圖"],
        )
    else:
        canonical_loader = chain["finalPath"].with_name(
            "private-app-loader-verification.json"
        )
        app_loader_paths = [canonical_loader] if canonical_loader.is_file() else []
        valid_loader: list[tuple[datetime, Path, list[str]]] = []
        loader_errors: list[str] = []
        for path in app_loader_paths:
            try:
                raw = load_json(path, "登入 App loader 驗證")
                if (raw.get("kind") != "matha-private-app-loader-verification"
                        or raw.get("releaseId") != chain["plan"].get("releaseId")
                        or raw.get("deploymentRecordSha256") != sha256(chain["finalPath"])
                        or raw.get("storageRuntimeRecordSha256") != sha256(selected_runtime_path)):
                    continue
                evidence = validate_app_loader_verification(
                    path, chain["planPath"], chain["finalPath"], selected_runtime_path,
                    not_before=selected_runtime_time,
                )
                valid_loader.append((parse_timestamp(raw.get("verifiedAt"), "登入 App loader 驗證"),
                                     path, evidence))
            except ReadinessError as error:
                loader_errors.append(str(error))
        if not valid_loader:
            app_loader_gate = gate(
                "starter-authenticated-app-load", "Starter 登入使用者 App loader 實載",
                "fail" if loader_errors else "blocked",
                loader_errors[0] if loader_errors else "尚無綁定最終 Storage 證據的登入載入紀錄",
                blockers=[] if loader_errors else [
                    "用一般登入者執行 alias signed URL、全部題包 RLS 與題圖雙路徑 smoke test",
                ],
            )
        else:
            _, loader_path, evidence = max(valid_loader, key=lambda row: row[0])
            app_loader_gate = gate(
                "starter-authenticated-app-load", "Starter 登入使用者 App loader 實載", "pass",
                f"一般啟用使用者已經由 App 同路徑載入 {chain['plan']['summary']['contentFiles'] - 3} 題包、{chain['plan']['summary']['questions']} 題與跨單元題圖抽樣",
                evidence=[str(loader_path), *evidence],
            )
    return review, deployment_gate, runtime_gate, app_loader_gate


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    inventory = load_json(args.inventory, "完整卷清冊")
    selected_paper = str(inventory.get("selectedNextPaperId") or "paper-mock-3")
    evidence_roots = [args.downloads, args.private_root]
    paper_engineering, calibration = audit_full_papers(
        args.inventory, args.private_root, evidence_roots, args.capability_evidence,
    )
    gates = [paper_engineering, *audit_core_feature_contracts()]
    gates.append(audit_device([args.downloads, args.private_root], selected_paper, args.device_audit))
    gates.append(calibration)
    gates.append(audit_score_stability(
        evidence_roots, args.capability_evidence,
    ))
    detail, scale = audit_detail(args.private_eval_root, args.detail_gold, args.detail_prediction)
    gates.extend([detail, scale])
    review, deployment_gate, runtime_gate, app_loader_gate = audit_starter(
        args.release_work_root,
    )
    gates.extend([review, deployment_gate, runtime_gate, app_loader_gate])
    starter_count = 0
    for item in review.get("evidence") or []:
        match = re.fullmatch(r"questions:(\d+):unique=\1", str(item))
        if match:
            starter_count = int(match.group(1))
            break
    if starter_count >= STARTER_CAPACITY_MINIMUM and all(
        row["status"] == "pass"
        for row in (review, deployment_gate, runtime_gate, app_loader_gate)
    ):
        starter_capacity = gate(
            "starter-capacity", "Starter 題庫容量與難度平衡", "pass",
            f"正式庫 {starter_count} 題，已達藍圖 M4 的 {STARTER_CAPACITY_MINIMUM:,} 題最低門檻",
            evidence=[f"current:{starter_count}",
                      f"targetMinimum:{STARTER_CAPACITY_MINIMUM}", "remainingMinimum:0"],
            required_for_delivery=False,
        )
    elif starter_count >= STARTER_CAPACITY_MINIMUM:
        blocked_gates = [
            row["label"] for row in (review, deployment_gate, runtime_gate, app_loader_gate)
            if row["status"] != "pass"
        ]
        starter_capacity = gate(
            "starter-capacity", "Starter 題庫容量與難度平衡", "blocked",
            f"正式庫容量已達 {starter_count} 題；仍待題庫發布證據鏈通過，不能把容量達標誤報成完整交付",
            evidence=[f"current:{starter_count}",
                      f"targetMinimum:{STARTER_CAPACITY_MINIMUM}", "remainingMinimum:0"],
            blockers=[f"先完成：{'、'.join(blocked_gates)}"],
            required_for_delivery=False,
        )
    else:
        remaining = max(0, STARTER_CAPACITY_MINIMUM - starter_count)
        starter_capacity = gate(
            "starter-capacity", "Starter 題庫容量與難度平衡", "blocked",
            f"目前可驗證正式庫 {starter_count} 題，尚未達藍圖 M4 的 {STARTER_CAPACITY_MINIMUM:,} 題",
            evidence=[f"current:{starter_count}", f"targetMinimum:{STARTER_CAPACITY_MINIMUM}",
                      f"remainingMinimum:{remaining}"],
            blockers=["從既有候選繼續逐題像素與官方答案 QA，不重跑付費 OCR"],
            required_for_delivery=False,
        )
    gates.append(starter_capacity)
    gates.append(audit_github_delivery(
        [args.private_root, args.downloads], args.github_delivery,
    ))
    gates.append(audit_supabase_delivery(
        [args.private_root, args.downloads], args.supabase_delivery,
    ))
    engineering = [row for row in gates if row["phase"] == "engineering"]
    post_delivery = [row for row in gates if row["phase"] == "post-delivery"]
    core_delivery_ready = all(
        row["status"] == "pass" for row in engineering if row["requiredForDelivery"]
    )
    construction_complete = all(row["status"] == "pass" for row in engineering)
    capability_validated = all(row["status"] == "pass" for row in post_delivery)
    all_goals_complete = construction_complete and capability_validated
    return {
        "kind": "matha-system-blueprint-readiness-v3",
        "generatedAt": datetime.now(timezone(timedelta(hours=8))).isoformat(),
        "appVersion": current_app_version(),
        "complete": all_goals_complete,
        "coreDeliveryReady": core_delivery_ready,
        "engineeringComplete": construction_complete,
        "constructionComplete": construction_complete,
        "capabilityValidated": capability_validated,
        "allGoalsComplete": all_goals_complete,
        "counts": {
            "pass": sum(row["status"] == "pass" for row in gates),
            "blocked": sum(row["status"] == "blocked" for row in gates),
            "fail": sum(row["status"] == "fail" for row in gates),
            "total": len(gates),
        },
        "engineeringCounts": {
            "pass": sum(row["status"] == "pass" for row in engineering),
            "blocked": sum(row["status"] == "blocked" for row in engineering),
            "fail": sum(row["status"] == "fail" for row in engineering),
            "total": len(engineering),
        },
        "postDeliveryCounts": {
            "pass": sum(row["status"] == "pass" for row in post_delivery),
            "blocked": sum(row["status"] == "blocked" for row in post_delivery),
            "fail": sum(row["status"] == "fail" for row in post_delivery),
            "total": len(post_delivery),
        },
        "gates": gates,
    }


def markdown(report: dict[str, Any]) -> str:
    status_label = {"pass": "通過", "blocked": "尚未完成", "fail": "不通過"}
    lines = [
        "# 數A系統完工稽核",
        "",
        f"產生時間：{report['generatedAt']}  ",
        f"App 版本：{report['appVersion']}  ",
        f"目前核心可交付：{'是' if report['coreDeliveryReady'] else '否'}  ",
        f"藍圖工程全數完成：{'是' if report['engineeringComplete'] else '否'}  ",
        f"能力驗證：{'已完成' if report['capabilityValidated'] else '待真實使用累積'}",
        f"整體目標完成：{'是' if report['complete'] else '否'}",
        "",
        "| 階段 | 關卡 | 狀態 | 證據結論 |",
        "|---|---|---|---|",
    ]
    for row in report["gates"]:
        summary = str(row["summary"]).replace("|", "／").replace("\n", " ")
        phase_label = "工程施工" if row["phase"] == "engineering" else "交付後證據"
        lines.append(f"| {phase_label} | {row['label']} | {status_label[row['status']]} | {summary} |")
    for row in report["gates"]:
        lines.extend(["", f"## {row['label']}", "", f"狀態：{status_label[row['status']]}。{row['summary']}"])
        if row["blockers"]:
            lines.extend(["", "仍缺：", *[f"- {item}" for item in row["blockers"]]])
        if row["evidence"]:
            lines.extend(["", "證據：", *[f"- `{item}`" for item in row["evidence"]]])
    lines.extend(["", "此報告只接受 exact-hash、真機、真實作答與透明授權鏈證據；測試通過不能代替交付後實證。", ""])
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    desktop = Path.home() / "Desktop"
    private_root = desktop / "數學檔案"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, default=REPO_ROOT / "docs" / "full-paper-inventory.json")
    parser.add_argument("--private-root", type=Path, default=private_root)
    parser.add_argument("--downloads", type=Path, default=Path.home() / "Downloads")
    parser.add_argument("--device-audit", type=Path, action="append")
    parser.add_argument("--capability-evidence", type=Path, action="append")
    parser.add_argument("--github-delivery", type=Path, action="append")
    parser.add_argument("--supabase-delivery", type=Path, action="append")
    parser.add_argument("--private-eval-root", type=Path, default=private_root / "matha-private-evals")
    parser.add_argument("--detail-gold", type=Path, default=private_root / "matha-private-evals" / "paper-mock-1-detail-gold-v1.json")
    parser.add_argument("--detail-prediction", type=Path)
    parser.add_argument("--release-work-root", type=Path, default=private_root / "matha-starter-v4-batch-01-release-workflow-20260829")
    parser.add_argument("--output", type=Path, default=desktop / "數學系統完工稽核.json")
    parser.add_argument("--require-delivery-ready", action="store_true")
    parser.add_argument("--require-complete", action="store_true",
                        help="require the whole blueprint, including M4 and real-use outcomes")
    args = parser.parse_args(argv)
    report = build_report(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path = args.output.with_suffix(".md")
    md_path.write_text(markdown(report), encoding="utf-8")
    print(json.dumps({"complete": report["complete"], "coreDeliveryReady": report["coreDeliveryReady"],
                      "engineeringComplete": report["engineeringComplete"],
                      "capabilityValidated": report["capabilityValidated"], "counts": report["counts"],
                      "json": str(args.output), "markdown": str(md_path)}, ensure_ascii=False))
    if args.require_delivery_ready and not report["coreDeliveryReady"]:
        return 1
    return 1 if args.require_complete and not report["complete"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
