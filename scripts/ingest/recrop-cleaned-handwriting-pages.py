#!/usr/bin/env python3
"""Recrop question candidates from normalized cleaned full-page images."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
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


def recrop(work: Path, page_queue: Path, cleaned_manifest: Path, output: Path) -> dict:
    queue = json.loads(page_queue.read_text(encoding="utf-8"))
    cleaned = json.loads(cleaned_manifest.read_text(encoding="utf-8"))
    cleaned_items = {
        item["id"]: item
        for item in (cleaned.get("cacheItems") or cleaned.get("items") or [])
        if item.get("cleaned")
    }
    queue_items = queue.get("items") or []
    missing_pages = [str(page.get("id")) for page in queue_items if page.get("id") not in cleaned_items]
    if missing_pages:
        raise RecropError(
            f"Cleaned manifest is incomplete: {len(missing_pages)} page(s) missing; "
            f"first={missing_pages[0]}"
        )
    output.mkdir(parents=True, exist_ok=True)
    crop_manifests = {}
    question_records = []
    for page in queue_items:
        page_id = str(page["id"])
        cleaned_item = cleaned_items.get(page_id)
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
                "cleaned": str(target.resolve()),
                "stemRegion": region,
                "cropDpi": crop_dpi,
            })
    result = {
        "schema": 1,
        "kind": "cleaned-page-question-candidates",
        "releaseAuthority": False,
        "humanPixelReviewRequired": True,
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
    args = parser.parse_args()
    try:
        print(json.dumps(recrop(args.work, args.page_queue, args.cleaned_manifest, args.out), ensure_ascii=False))
        return 0
    except (OSError, ValueError, RecropError) as error:
        print(f"recrop-cleaned-handwriting-pages: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
