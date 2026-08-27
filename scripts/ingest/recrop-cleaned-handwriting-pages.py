#!/usr/bin/env python3
"""Recrop question candidates from normalized cleaned full-page images."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


class RecropError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def recrop(
    work: Path,
    page_queue: Path,
    cleaned_manifest: Path,
    output: Path,
    *,
    quarantine_incomplete: bool = False,
    fallback_cleanup_manifest: Path | None = None,
) -> dict:
    queue = json.loads(page_queue.read_text(encoding="utf-8"))
    cleaned = json.loads(cleaned_manifest.read_text(encoding="utf-8"))
    cleaned_items = {
        item["id"]: item
        for item in (cleaned.get("cacheItems") or cleaned.get("items") or [])
        if item.get("cleaned")
    }
    fallback = (
        json.loads(fallback_cleanup_manifest.read_text(encoding="utf-8"))
        if fallback_cleanup_manifest is not None
        else {}
    )
    fallback_items = {
        item["id"]: item
        for item in (fallback.get("cacheItems") or fallback.get("items") or [])
        if item.get("id") and item.get("cleaned")
    }
    queue_items = queue.get("items") or []
    failures_by_id = {
        str(item.get("id")): item
        for item in (cleaned.get("cacheFailures") or cleaned.get("failures") or [])
        if item.get("id")
    }
    missing_pages = [
        str(page.get("id"))
        for page in queue_items
        if page.get("id") not in cleaned_items
    ]
    rescued_pages = [
        str(page.get("id"))
        for page in queue_items
        if page.get("id") in missing_pages
        and page.get("questionIds")
        and all(question_id in fallback_items for question_id in page.get("questionIds") or [])
    ]
    unresolved_pages = [page_id for page_id in missing_pages if page_id not in rescued_pages]
    if unresolved_pages and not quarantine_incomplete:
        raise RecropError(
            f"Cleaned manifest is incomplete: {len(unresolved_pages)} page(s) missing; "
            f"first={unresolved_pages[0]}"
        )
    output.mkdir(parents=True, exist_ok=True)
    crop_manifests = {}
    question_records = []
    for page in queue_items:
        page_id = str(page["id"])
        cleaned_item = cleaned_items.get(page_id)
        if cleaned_item is None:
            if page_id in rescued_pages:
                for question_id in page.get("questionIds") or []:
                    fallback_item = fallback_items[question_id]
                    book_id = str(page["bookId"])
                    if book_id not in crop_manifests:
                        path = work / book_id / "crops-manifest.json"
                        crop_manifests[book_id] = json.loads(path.read_text(encoding="utf-8"))
                    crop_manifest = crop_manifests[book_id]
                    crop = (crop_manifest.get("crops") or {}).get(question_id) or {}
                    region = crop.get("stemRegion")
                    crop_dpi = int(crop_manifest.get("cropDpi") or 300)
                    if not region:
                        raise RecropError(f"Fallback question has no source crop region: {question_id}")
                    source = work / book_id / "crops" / question_id / "stem.png"
                    fallback_cleaned = Path(fallback_item["cleaned"])
                    if not source.is_file() or sha256(source) != fallback_item.get("sourceSha256"):
                        raise RecropError(f"Fallback cleanup source hash mismatch for {question_id}")
                    if (
                        not fallback_cleaned.is_file()
                        or sha256(fallback_cleaned) != fallback_item.get("cleanedSha256")
                    ):
                        raise RecropError(f"Fallback cleaned artifact hash mismatch for {question_id}")
                    with Image.open(source) as original_crop, Image.open(fallback_cleaned) as cleaned_crop:
                        if cleaned_crop.size != original_crop.size:
                            raise RecropError(
                                f"Fallback cleaned geometry mismatch for {question_id}: "
                                f"{cleaned_crop.size} vs {original_crop.size}"
                            )
                    target = output / question_id / "cleaned.png"
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(fallback_cleaned, target)
                    question_records.append({
                        "id": question_id,
                        "bookId": book_id,
                        "pdfPage": page["pdfPage"],
                        "pageId": page_id,
                        "source": str(source.resolve()),
                        "sourceSha256": sha256(source),
                        "cleaned": str(target.resolve()),
                        "cleanedSha256": sha256(target),
                        "cleanupMode": "question-fallback",
                        "fallbackCleanupSourceSha256": fallback_item.get("sourceSha256"),
                        "stemRegion": region,
                        "cropDpi": crop_dpi,
                    })
            continue
        render = Path(page["render"])
        if not render.is_file() or sha256(render) != page.get("renderSha256"):
            raise RecropError(f"Rendered source hash mismatch for {page_id}")
        if cleaned_item.get("sourceSha256") != page.get("renderSha256"):
            raise RecropError(f"Cleanup result is bound to the wrong source for {page_id}")
        book_id = str(page["bookId"])
        if book_id not in crop_manifests:
            path = work / book_id / "crops-manifest.json"
            crop_manifests[book_id] = json.loads(path.read_text(encoding="utf-8"))
        crop_manifest = crop_manifests[book_id]
        review_dpi = 150
        crop_dpi = int(crop_manifest.get("cropDpi") or 300)
        scale = crop_dpi / review_dpi
        cleaned_path = Path(cleaned_item["cleaned"])
        if not cleaned_path.is_file() or sha256(cleaned_path) != cleaned_item.get("cleanedSha256"):
            raise RecropError(f"Cleaned artifact hash mismatch for {page_id}")
        with Image.open(cleaned_path) as image:
            cleaned_page = image.convert("RGB")
            cleaned_page.load()
        with Image.open(render) as image:
            render_size = image.size
        if cleaned_page.size != render_size:
            raise RecropError(
                f"Cleaned page geometry mismatch for {page_id}: "
                f"{cleaned_page.size} vs {render_size}"
            )
        for question_id in page.get("questionIds") or []:
            crop = (crop_manifest.get("crops") or {}).get(question_id) or {}
            region = crop.get("stemRegion")
            source = work / book_id / "crops" / question_id / "stem.png"
            if not region or not source.is_file():
                continue
            with Image.open(source) as image:
                target_size = image.size
            box = tuple(round(value * scale) for value in region)
            candidate = cleaned_page.crop(box)
            if candidate.size != target_size:
                source_aspect = target_size[0] / target_size[1]
                candidate_aspect = candidate.width / candidate.height
                if abs(candidate_aspect / source_aspect - 1) > 0.01:
                    raise RecropError(
                        f"Crop geometry mismatch for {question_id}: {candidate.size} vs {target_size}"
                    )
                candidate = candidate.resize(target_size, Image.Resampling.LANCZOS)
            target = output / question_id / "cleaned.png"
            target.parent.mkdir(parents=True, exist_ok=True)
            candidate.save(target, format="PNG", optimize=True)
            question_records.append({
                "id": question_id,
                "bookId": book_id,
                "pdfPage": page["pdfPage"],
                "pageId": page_id,
                "source": str(source.resolve()),
                "sourceSha256": sha256(source),
                "cleaned": str(target.resolve()),
                "cleanedSha256": sha256(target),
                "pageRenderSha256": page.get("renderSha256"),
                "pageCleanedSha256": cleaned_item.get("cleanedSha256"),
                "cleanupMode": "full-page-recrop",
                "stemRegion": region,
                "cropDpi": crop_dpi,
            })
    result = {
        "schema": 1,
        "kind": "cleaned-page-question-candidates",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "pageQueueSha256": sha256(page_queue),
        "cleanupManifestSha256": sha256(cleaned_manifest),
        "fallbackCleanupManifestSha256": (
            sha256(fallback_cleanup_manifest) if fallback_cleanup_manifest is not None else None
        ),
        "cleanupService": cleaned.get("service"),
        "fallbackCleanupService": fallback.get("service"),
        "releaseAuthority": False,
        "humanPixelReviewRequired": True,
        "pageSelectionCount": len(queue_items),
        "cleanedPageCount": len(queue_items) - len(missing_pages),
        "rescuedPageCount": len(rescued_pages),
        "fallbackQuestionCount": sum(
            1 for item in question_records if item.get("cleanupMode") == "question-fallback"
        ),
        "quarantinedPageCount": len(unresolved_pages),
        "quarantinedPages": [
            {
                "id": page_id,
                "reason": str((failures_by_id.get(page_id) or {}).get("error") or "missing-cleaned-page"),
            }
            for page_id in unresolved_pages
        ],
        "questions": len(question_records),
        "items": question_records,
    }
    manifest = output / "cleaned-question-candidates.json"
    manifest.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"questions": len(question_records), "manifest": str(manifest.resolve())}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--page-queue", type=Path, required=True)
    parser.add_argument("--cleaned-manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--quarantine-incomplete",
        action="store_true",
        help="recrop verified pages and explicitly quarantine missing/failed pages",
    )
    parser.add_argument(
        "--fallback-cleanup-manifest",
        type=Path,
        help="question-level YesScanner manifest used only for failed full pages",
    )
    args = parser.parse_args()
    try:
        print(json.dumps(recrop(
            args.work,
            args.page_queue,
            args.cleaned_manifest,
            args.out,
            quarantine_incomplete=args.quarantine_incomplete,
            fallback_cleanup_manifest=args.fallback_cleanup_manifest,
        ), ensure_ascii=False))
        return 0
    except (OSError, ValueError, RecropError) as error:
        print(f"recrop-cleaned-handwriting-pages: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
