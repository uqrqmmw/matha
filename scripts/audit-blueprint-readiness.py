#!/usr/bin/env python3
"""Produce a fail-closed completion audit for the MathA construction blueprint.

The report only accepts exact local evidence.  It does not call a browser, OCR,
OpenAI, Supabase, or any other paid service.  Missing human/device/source
evidence remains blocked instead of being inferred from tests or filenames.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
REQUIRED_DETAIL_NOS = {3, 4, 11, 12, 13, 14, 16}
NON_HUMAN = re.compile(r"(?:^|\b)(?:ai|bot|agent|codex|claude|chatgpt|openai)(?:\b|$)", re.I)
DEVICE_MODEL = "Samsung Galaxy Tab S10 Ultra"


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


def gate(identifier: str, label: str, status: str, summary: str,
         *, evidence: list[str] | None = None,
         blockers: list[str] | None = None) -> dict[str, Any]:
    if status not in {"pass", "blocked", "fail"}:
        raise ValueError(f"invalid gate status: {status}")
    return {
        "id": identifier,
        "label": label,
        "status": status,
        "summary": summary,
        "evidence": evidence or [],
        "blockers": blockers or [],
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


def validate_private_app_integration(row: dict[str, Any], private_root: Path) -> list[str]:
    if not isinstance(row, dict):
        raise ReadinessError("完整卷缺少私有 App 整合證據")
    expected_version = current_app_version()
    expected_values = {
        "status": "deployed-and-hash-verified",
        "appVersion": expected_version,
        "supabaseProjectRef": "rrihysbxhsbxjteqmtdu",
        "bucket": "matha-papers",
        "officialPapers": 6,
        "officialPages": 48,
        "remoteHashMismatches": 0,
        "answerKeyPapersBehindPostSubmitGate": 7,
        "officialDetailedSolutionPapers": 1,
        "officialSolutionPages": 8,
        "solutionStorageHashMismatches": 0,
        "freshnessStillRequiresUserConfirmation": True,
    }
    for key, expected in expected_values.items():
        if row.get(key) != expected:
            raise ReadinessError(f"私有 App 整合證據不符：{key}")
    if int(row.get("edgeFunctionVersion") or 0) < 31:
        raise ReadinessError("私有 App Edge Function 版本尚未包含正式卷安全閘門")

    paths = {
        "assets": resolve_private_hint(str(row.get("assetManifestPathHint") or ""), private_root),
        "visual": resolve_private_hint(str(row.get("visualReviewPathHint") or ""), private_root),
        "storage": resolve_private_hint(str(row.get("storageVerificationPathHint") or ""), private_root),
        "solutions": resolve_private_hint(str(row.get("solutionManifestPathHint") or ""), private_root),
    }
    hashes = {
        "assets": str(row.get("assetManifestSha256") or "").lower(),
        "visual": str(row.get("visualReviewSha256") or "").lower(),
        "storage": str(row.get("storageVerificationSha256") or "").lower(),
        "solutions": str(row.get("solutionManifestSha256") or "").lower(),
    }
    for key, path in paths.items():
        if not path.is_file() or sha256(path) != hashes[key]:
            raise ReadinessError(f"私有 App {key} 證據不存在或雜湊漂移")

    assets = load_json(paths["assets"], "官方卷 App 資產 manifest")
    visual = load_json(paths["visual"], "官方卷 App 視覺複核")
    storage = load_json(paths["storage"], "官方卷 Storage 回讀驗證")
    solutions = load_json(paths["solutions"], "官方完整詳解 Storage 回讀驗證")
    if (assets.get("kind") != "matha-official-paper-assets-v1"
            or assets.get("releaseAuthority") is not False
            or int(assets.get("paperCount") or 0) != 6
            or int(assets.get("assetCount") or 0) != 48):
        raise ReadinessError("官方卷 App 資產 manifest 不合法")
    checks = visual.get("checks") or {}
    if (visual.get("schema") != 1 or visual.get("releaseAuthority") is not False
            or int(visual.get("papersReviewed") or 0) != 6
            or int(visual.get("pagesReviewed") or 0) != 48
            or any(checks.get(key) != "pass" for key in (
                "pageOrder", "cropCompleteness", "chineseReadability",
                "formulaReadability", "diagramPreservation", "grayscalePreservation",
            ))
            or checks.get("handwritingPresent") is not False
            or checks.get("answerLeakageInQuestionPages") is not False):
        raise ReadinessError("官方卷 App 視覺複核不完整")
    if (storage.get("kind") != "matha-official-paper-storage-verification-v1"
            or storage.get("releaseAuthority") is not False
            or storage.get("readOnlyVerification") is not True
            or storage.get("projectRef") != row["supabaseProjectRef"]
            or storage.get("bucket") != row["bucket"]
            or storage.get("sourceManifestSha256") != hashes["assets"]
            or int(storage.get("paperCount") or 0) != 6
            or int(storage.get("assetCount") or 0) != 48
            or int(storage.get("remoteHashMismatches", -1)) != 0):
        raise ReadinessError("官方卷 Storage 回讀驗證不合法")

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
    edge_source = (REPO_ROOT / "supabase/functions/openai-proxy/lib.ts").read_text(encoding="utf-8")
    for asset in solution_rows:
        relative = str(asset.get("file") or "").replace("\\", "/")
        path = paths["solutions"].parent / Path(relative)
        if (not relative.startswith("paper-official-110-trial/")
                or not path.is_file()
                or sha256(path) != str(asset.get("sha256") or "").lower()
                or path.stat().st_size != int(asset.get("bytes") or -1)
                or relative not in edge_source):
            raise ReadinessError(f"官方完整詳解雜湊或 Edge 引用不符：{relative}")

    app_source = (REPO_ROOT / "app.js").read_text(encoding="utf-8")
    asset_rows: dict[str, dict[str, Any]] = {}
    expected_papers = {
        "official-110-trial-matha",
        *(f"official-{year}-matha" for year in range(111, 116)),
    }
    manifest_papers = {str(paper.get("paperId") or "") for paper in assets.get("papers") or []}
    if manifest_papers != expected_papers:
        raise ReadinessError("官方卷 App 資產年度不完整")
    for paper in assets.get("papers") or []:
        paper_id = str(paper.get("paperId"))
        year = paper_id.split("-")[1]
        rows = paper.get("assets") or []
        page_map = paper.get("questionPageMap") or []
        if (len(rows) != 8 or len(page_map) != 20
                or any(not isinstance(page, int) or page < 2 or page > 7 for page in page_map)
                or f"officialPaperSource({year}" not in app_source):
            raise ReadinessError(f"官方卷 {year} 頁面或題號綁定不完整")
        for asset in rows:
            relative = str(asset.get("file") or "").replace("\\", "/")
            path = paths["assets"].parent / Path(relative)
            if (not relative.startswith(f"{paper_id}/") or relative in asset_rows
                    or not path.is_file()
                    or sha256(path) != str(asset.get("sha256") or "").lower()
                    or path.stat().st_size != int(asset.get("bytes") or -1)
                    or relative not in app_source):
                raise ReadinessError(f"官方卷 App 頁面雜湊或引用不符：{relative}")
            asset_rows[relative] = asset
    remote_rows = {
        str(asset.get("file") or ""): asset for asset in storage.get("assets") or []
        if isinstance(asset, dict)
    }
    if (set(remote_rows) != set(asset_rows)
            or any(remote_rows[path].get("sha256") != asset_rows[path].get("sha256")
                   for path in asset_rows)):
        raise ReadinessError("Storage 回讀資產未與 App manifest 全數綁定")
    return [
        f"officialAppAssets:{hashes['assets']}:48",
        f"officialVisualReview:{hashes['visual']}:48",
        f"officialStorageReadback:{hashes['storage']}:48:mismatch=0",
        f"officialDetailedSolutions:{hashes['solutions']}:8:mismatch=0",
        f"officialAppVersion:{expected_version}:edge={row['edgeFunctionVersion']}:serverKeys=7",
    ]


def audit_full_papers(inventory_path: Path, private_root: Path) -> dict[str, Any]:
    try:
        inventory = load_json(inventory_path, "完整卷清冊")
        if inventory.get("schema") != 1 or not isinstance(inventory.get("papers"), list):
            raise ReadinessError("完整卷清冊 schema 不合法")
        files = source_index(private_root)
        verified = []
        source_document_count = 0
        for row in inventory.get("sourceDocuments") or []:
            path = resolve_source(row, private_root, files)
            if path is None:
                raise ReadinessError(f"完整卷來源不存在或雜湊不符：{row.get('fileName')}")
            verified.append(f"{row.get('id')}:{sha256(path)}")
            source_document_count += 1
        discovery = inventory.get("localDiscoveryAudit")
        if isinstance(discovery, dict):
            verified.extend(validate_local_discovery(discovery, private_root))
        verified.extend(validate_private_app_integration(
            inventory.get("privateAppIntegration"), private_root,
        ))
        ready = [row for row in inventory["papers"] if
                 int(row.get("questions") or 0) == 20
                 and int(row.get("minutes") or 0) == 100
                 and str(row.get("freshness") or "") in {"confirmed-unseen", "unseen-confirmed"}
                 and str(row.get("calibrationStatus") or "") in {
                     "ready", "ready-fresh", "eligible-fresh"
                 }]
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
        if len(ready) < 6:
            needed = 6 - len(ready)
            pending = min(needed, len([row for row in potential if row not in ready]))
            additional = max(0, needed - pending)
            blockers = []
            if pending:
                blockers.append(f"{pending} 回既有候選仍需本人確認未看過並完成 Galaxy Tab 真機開考驗收")
            if additional:
                blockers.append(f"仍需 {additional} 回額外的 20 題、100 分鐘且答案完整新來源")
            return gate(
                "full-papers", "正式校準卷庫存", "blocked",
                f"已驗證 {source_document_count} 份題本／答案來源；6 / 6 回已接入 App 且私有資產回讀雜湊一致，正式新鮮校準證據為 {len(ready)} / 6 回",
                evidence=verified,
                blockers=blockers,
            )
        return gate(
            "full-papers", "正式校準卷庫存", "pass",
            f"已有 {len(ready)} 回 hash-bound 新鮮正式卷",
            evidence=[str(row.get("id")) for row in ready],
        )
    except ReadinessError as error:
        return gate("full-papers", "正式校準卷庫存", "fail", str(error))


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


def validate_device_audit(path: Path, selected_paper: str, app_version: str) -> list[str]:
    value = load_json(path, "真機驗收")
    run, summary, audit = value.get("run") or {}, value.get("summary") or {}, value.get("audit") or {}
    if value.get("kind") != "matha-paper-runtime-audit-v1" or int(audit.get("schema") or 0) != 1:
        raise ReadinessError("真機驗收 kind/schema 不合法")
    if value.get("appVersion") != app_version or audit.get("appVersion") != app_version:
        raise ReadinessError(f"真機驗收不是目前版本 {app_version}")
    if run.get("sourceId") != selected_paper or run.get("status") in {None, "active", "paused", "discarded"}:
        raise ReadinessError("真機驗收不是指定第三回的已交卷紀錄")
    attestation = value.get("deviceAttestation") or {}
    if (attestation.get("confirmed") is not True
            or attestation.get("model") != DEVICE_MODEL
            or attestation.get("source") != "user-confirmation"):
        raise ReadinessError("缺少 Galaxy Tab S10 Ultra 使用者裝置確認")
    device = audit.get("device") or {}
    user_agent = str(device.get("userAgent") or "")
    reported_model = str(attestation.get("browserReportedModel") or "")
    width, height = float(device.get("screenWidth") or 0), float(device.get("screenHeight") or 0)
    if "Android" not in user_agent:
        raise ReadinessError("裝置 UA 不是 Android")
    if reported_model and not re.search(r"SM-X9", reported_model, re.I):
        raise ReadinessError("瀏覽器回報型號不是 Samsung Galaxy Tab Ultra")
    if not reported_model and not re.search(r"SM-X9", user_agent, re.I) \
            and (max(width, height) < 1100 or min(width, height) < 700):
        raise ReadinessError("瀏覽器未回報型號，螢幕資料也不能支持大型 Samsung 平板證據")
    required_checks = {"duration", "page", "save", "canvas", "resume", "pdf"}
    check_rows = {str(row.get("id")): row for row in summary.get("checks") or [] if isinstance(row, dict)}
    if summary.get("passed") is not True or any((check_rows.get(key) or {}).get("status") != "pass" for key in required_checks):
        raise ReadinessError("真機必要量測沒有全部通過")
    elapsed = float(audit.get("activeElapsedMs") or 0)
    switches = audit.get("pageSwitches") or []
    if elapsed < 5_999_000 or int(audit.get("strokesCommitted") or 0) < 1:
        raise ReadinessError("未證明完整 100 分鐘與實際手寫")
    if int(audit.get("sessions") or 0) < 2 or not any(row.get("method") == "swipe" for row in switches if isinstance(row, dict)):
        raise ReadinessError("未證明暫停恢復與手指滑動翻頁")
    if int(audit.get("pendingAtSubmit") or 0) != 0 or int(audit.get("localSaveFailures") or 0) != 0:
        raise ReadinessError("交卷仍有待保存筆跡或本機保存失敗")
    return [
        f"file:{path}", f"sha256:{sha256(path)}", f"run:{run.get('id')}",
        f"pageP95Ms:{summary.get('pageP95Ms')}",
        f"localSaveP95Ms:{summary.get('localSaveP95Ms')}",
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
        )
    errors = []
    version = current_app_version()
    for path in candidates:
        try:
            evidence = validate_device_audit(path, selected_paper, version)
            return gate("galaxy-tab", "Galaxy Tab 100 分鐘真機驗收", "pass", "真機必要證據全部通過", evidence=evidence)
        except ReadinessError as error:
            errors.append(f"{path.name}: {error}")
    return gate("galaxy-tab", "Galaxy Tab 100 分鐘真機驗收", "fail", "找到驗收檔但沒有一份可通過", evidence=errors)


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
        failed = gate("detail-eval", "7 題 GPT-5.5 詳批評測", "fail", str(error))
        scale = gate("detail-gold-scale", "30 題真實詳批 gold", "fail", str(error))
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
        )
    else:
        command = ["node", str(REPO_ROOT / "scripts" / "evaluate-paper-detail-gold.js"),
                   "--gold", str(gold_path), "--prediction", str(prediction_path), "--allow-fail"]
        completed = subprocess.run(command, cwd=REPO_ROOT, text=True, encoding="utf-8",
                                   capture_output=True, check=False)
        if completed.returncode:
            detail_gate = gate("detail-eval", "7 題 GPT-5.5 詳批評測", "fail", completed.stderr.strip()[:800])
        else:
            result = json.loads(completed.stdout)
            if result.get("safeToShip") is True and approved_gold(gold, gold_path):
                detail_gate = gate("detail-eval", "7 題 GPT-5.5 詳批評測", "pass", "詳批門檻與具名真人簽核皆通過", evidence=[str(prediction_path), json.dumps(result.get("metrics"), ensure_ascii=False)])
            else:
                detail_gate = gate("detail-eval", "7 題 GPT-5.5 詳批評測", "blocked", "prediction 已評測但正式門檻或具名真人簽核未完成", evidence=[json.dumps(result.get("gates"), ensure_ascii=False)], blockers=["修正未通過門檻，並完成 exact-hash 具名真人 gold 簽核"])

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
        scale_gate = gate("detail-gold-scale", "30 題真實詳批 gold", "pass", f"已有 {len(released_cases)} 題具名真人簽核 gold")
    else:
        scale_gate = gate("detail-gold-scale", "30 題真實詳批 gold", "blocked", f"目前具名真人簽核 gold {len(released_cases)} / 30 題", blockers=[f"仍需 {30 - len(released_cases)} 題真實錯題 gold"])
    return detail_gate, scale_gate


def audit_starter(work_root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    dual_path = work_root / "dual-review.json"
    signed_path = work_root / "signed-private-question-source.json"
    plan_path = work_root / "private-bundle" / "upload-plan.json"
    deployment_paths = [work_root / "deployment.json", work_root / "deployment-final.json"]
    if not dual_path.is_file():
        review = gate("starter-human-review", "Batch 01 真人雙 QA 與發布簽核", "blocked", "尚未產生 Batch 01 雙審核交集", blockers=["具名真人完成 35 題像素 QA、答案 QA 與正解輸入"])
    else:
        try:
            dual = load_json(dual_path, "雙審核交集")
            counts = dual.get("counts") or {}
            if (dual.get("kind") != "matha-private-cleaned-dual-review-candidates"
                    or int(counts.get("totalCandidates") or 0) != 35
                    or not identifiable_human(dual.get("pixelReviewer"))
                    or not identifiable_human(dual.get("answerReviewer"))):
                raise ReadinessError("雙審核交集缺 35 題完整性或具名真人")
            signed = load_json(signed_path, "簽核題源")
            approval = signed.get("releaseApproval") or {}
            if (not identifiable_human(signed.get("releaseApprovedBy"))
                    or approval.get("kind") != "named-human-starter-private-release-signoff"):
                raise ReadinessError("尚未完成十題具名真人發布簽核")
            review = gate("starter-human-review", "Batch 01 真人雙 QA 與發布簽核", "pass", "35 題雙 QA 與十題發布簽核已通過", evidence=[f"dual:{sha256(dual_path)}", f"signed:{sha256(signed_path)}"])
        except ReadinessError as error:
            review = gate("starter-human-review", "Batch 01 真人雙 QA 與發布簽核", "fail", str(error))

    record_path = next((path for path in deployment_paths if path.is_file()), None)
    if not plan_path.is_file() or record_path is None:
        deployment_gate = gate("starter-deployment", "Batch 01 Supabase 私有發布與回滾驗證", "blocked", "尚無正式部署記錄", blockers=["真人簽核後建立 bundle、上傳回讀驗 hash、切換 alias 並完成回滾演練"])
    else:
        try:
            plan = load_json(plan_path, "上傳計畫")
            record = load_json(record_path, "部署記錄")
            alias = record.get("alias") or {}
            if (record.get("kind") != "matha-private-storage-deployment"
                    or record.get("rollbackAvailable") is not True
                    or record.get("releaseId") != plan.get("releaseId")
                    or record.get("uploadPlanSha256") != sha256(plan_path)
                    or not alias.get("newSha256")):
                raise ReadinessError("部署記錄與 bundle 不一致")
            rollback = work_root / "rollback-drill.json"
            if not rollback.is_file():
                raise ReadinessError("缺少正式 alias 回滾演練記錄")
            rollback_value = load_json(rollback, "回滾演練")
            if (rollback_value.get("kind") != "matha-private-storage-rollback"
                    or rollback_value.get("deploymentRecordSha256") != sha256(record_path)):
                raise ReadinessError("回滾演練記錄未綁定本次部署")
            deployment_gate = gate("starter-deployment", "Batch 01 Supabase 私有發布與回滾驗證", "pass", "部署、alias 與回滾記錄已 hash-bound", evidence=[str(record_path), str(rollback)])
        except ReadinessError as error:
            deployment_gate = gate("starter-deployment", "Batch 01 Supabase 私有發布與回滾驗證", "fail", str(error))
    return review, deployment_gate


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    inventory = load_json(args.inventory, "完整卷清冊")
    selected_paper = str(inventory.get("selectedNextPaperId") or "paper-mock-3")
    gates = [audit_full_papers(args.inventory, args.private_root)]
    gates.append(audit_device([args.downloads, args.private_root], selected_paper, args.device_audit))
    detail, scale = audit_detail(args.private_eval_root, args.detail_gold, args.detail_prediction)
    gates.extend([detail, scale])
    review, deployment_gate = audit_starter(args.release_work_root)
    gates.extend([review, deployment_gate])
    return {
        "kind": "matha-system-blueprint-readiness-v1",
        "generatedAt": datetime.now(timezone(timedelta(hours=8))).isoformat(),
        "appVersion": current_app_version(),
        "complete": all(row["status"] == "pass" for row in gates),
        "counts": {
            "pass": sum(row["status"] == "pass" for row in gates),
            "blocked": sum(row["status"] == "blocked" for row in gates),
            "fail": sum(row["status"] == "fail" for row in gates),
            "total": len(gates),
        },
        "gates": gates,
    }


def markdown(report: dict[str, Any]) -> str:
    status_label = {"pass": "通過", "blocked": "待外部證據", "fail": "不通過"}
    lines = [
        "# 數A系統完工稽核",
        "",
        f"產生時間：{report['generatedAt']}  ",
        f"App 版本：{report['appVersion']}  ",
        f"整體：{'已完成' if report['complete'] else '尚未完成'}",
        "",
        "| 關卡 | 狀態 | 證據結論 |",
        "|---|---|---|",
    ]
    for row in report["gates"]:
        summary = str(row["summary"]).replace("|", "／").replace("\n", " ")
        lines.append(f"| {row['label']} | {status_label[row['status']]} | {summary} |")
    for row in report["gates"]:
        lines.extend(["", f"## {row['label']}", "", f"狀態：{status_label[row['status']]}。{row['summary']}"])
        if row["blockers"]:
            lines.extend(["", "仍缺：", *[f"- {item}" for item in row["blockers"]]])
        if row["evidence"]:
            lines.extend(["", "證據：", *[f"- `{item}`" for item in row["evidence"]]])
    lines.extend(["", "此報告只接受 exact-hash、真機與具名真人證據；測試通過不能代替真實作答或簽核。", ""])
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
    parser.add_argument("--private-eval-root", type=Path, default=private_root / "matha-private-evals")
    parser.add_argument("--detail-gold", type=Path, default=private_root / "matha-private-evals" / "paper-mock-1-detail-gold-v1.json")
    parser.add_argument("--detail-prediction", type=Path)
    parser.add_argument("--release-work-root", type=Path, default=private_root / "matha-starter-v4-batch-01-release-workflow-20260829")
    parser.add_argument("--output", type=Path, default=desktop / "數學系統完工稽核.json")
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args(argv)
    report = build_report(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path = args.output.with_suffix(".md")
    md_path.write_text(markdown(report), encoding="utf-8")
    print(json.dumps({"complete": report["complete"], "counts": report["counts"],
                      "json": str(args.output), "markdown": str(md_path)}, ensure_ascii=False))
    return 1 if args.require_complete and not report["complete"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
