#!/usr/bin/env python3
"""Promote independently reviewed original-PDF question crops.

OCR and reviewer transcriptions are metadata only.  A scan-derived question is
student-visible only after this command proves that its stem crop was rendered
from the catalogued PDF, covers the full stem/options, excludes answers and
handwriting, and was approved by a reviewer distinct from the qpack producer.

All inputs and outputs are private and must remain outside the public repo.
The command never uploads anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import fitz

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
HEX64 = re.compile(r"^[a-f0-9]{64}$")


class PromotionError(RuntimeError):
    """A fail-closed promotion error."""


def ensure_outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
    raise PromotionError(f"Private scan-derived material must stay outside the public repository: {resolved}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PromotionError(f"Cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise PromotionError(f"Expected a JSON object: {path}")
    return value


def catalog_books(path: Path) -> dict[str, str]:
    """Read only id/pdfSha256 from either the JS catalog or a test JSON catalog."""
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        raw = json.loads(text)
        rows = [*(raw.get("books") or []), *(raw.get("supplemental") or [])]
        return {row["id"]: row["pdfSha256"] for row in rows if row.get("id") and row.get("pdfSha256")}
    books: dict[str, str] = {}
    for match in re.finditer(r"\{\s*id:'([^']+)'[^\n]*?pdfSha256:'([a-f0-9]{64})'", text):
        books[match.group(1)] = match.group(2)
    return books


def normalized_bbox(region: list[Any], page_width: int, page_height: int) -> list[float]:
    if len(region) != 4 or any(not isinstance(value, int) for value in region):
        raise PromotionError("stemRegion must contain four integer review-page coordinates")
    x0, y0, x1, y1 = region
    if x0 < 0 or y0 < 0 or x1 <= x0 or y1 <= y0 or x1 > page_width or y1 > page_height:
        raise PromotionError("stemRegion is outside its indexed source page")
    if x1 - x0 < 20 or y1 - y0 < 20:
        raise PromotionError("stemRegion is too small to be a complete question")
    return [round(x0 / page_width, 9), round(y0 / page_height, 9),
            round((x1 - x0) / page_width, 9), round((y1 - y0) / page_height, 9)]


def pdf_rect(region: list[int], review_dpi: int) -> fitz.Rect:
    scale = 72.0 / review_dpi
    return fitz.Rect(region[0] * scale, region[1] * scale,
                     region[2] * scale, region[3] * scale)


def pixmap_matches_original(crop_file: Path, document: fitz.Document, page_number: int,
                            region: list[int], review_dpi: int, crop_dpi: int) -> tuple[int, int]:
    if page_number < 1 or page_number > document.page_count:
        raise PromotionError(f"PDF page {page_number} is outside the source document")
    try:
        crop = fitz.Pixmap(str(crop_file))
        expected = document[page_number - 1].get_pixmap(
            dpi=crop_dpi, clip=pdf_rect(region, review_dpi), alpha=False)
    except Exception as error:  # PyMuPDF raises several concrete types across releases.
        raise PromotionError(f"Cannot decode/compare crop {crop_file}: {error}") from error
    if crop.width != expected.width or crop.height != expected.height or crop.n != expected.n:
        raise PromotionError(f"Crop dimensions/channels do not match a fresh render of source PDF: {crop_file}")
    if crop.samples != expected.samples:
        raise PromotionError(f"Crop pixels are not exactly the catalogued PDF region: {crop_file}")
    if crop.width < 80 or crop.height < 80:
        raise PromotionError(f"Crop rendition is too small for student use: {crop_file}")
    return crop.width, crop.height


def review_rows(review: dict[str, Any], expected_ids: set[str], source_hash: str,
                manifest_hash: str, producer: str) -> tuple[str, str, dict[str, dict[str, Any]]]:
    if review.get("kind") != "matha-private-stem-independent-review" or review.get("version") != 1:
        raise PromotionError("Independent stem review kind/version is invalid")
    reviewer = str(review.get("reviewer") or "").strip()
    reviewed_at = str(review.get("reviewedAt") or "").strip()
    if len(reviewer) < 3 or reviewer == producer or not reviewed_at:
        raise PromotionError("Stem reviewer must be named, timestamped, and distinct from the qpack producer")
    try:
        parsed_time = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise PromotionError("Stem review timestamp is not valid ISO-8601") from error
    if parsed_time.tzinfo is None:
        raise PromotionError("Stem review timestamp must include a timezone")
    if review.get("sourceSha256") != source_hash or review.get("cropManifestSha256") != manifest_hash:
        raise PromotionError("Independent review was performed against different source files")
    rows = review.get("questions")
    if not isinstance(rows, list):
        raise PromotionError("Independent review has no question list")
    by_id: dict[str, dict[str, Any]] = {}
    required_integrity = {"sourcePdfHash", "cropHash", "cropPixelsMatchPdf", "bookPageQuestionBinding"}
    required_visual_true = {"fullStemVerified"}
    required_visual_false = {"containsAnswer", "containsSolution", "containsHandwriting", "containsAdjacentQuestion"}
    for row in rows:
        qid = row.get("id") if isinstance(row, dict) else None
        if not isinstance(qid, str) or qid in by_id:
            raise PromotionError("Independent review has a missing/duplicate question id")
        integrity = row.get("integrity") or {}
        visual = row.get("visual") or {}
        if row.get("decision") != "pass" or any(integrity.get(key) is not True for key in required_integrity):
            raise PromotionError(f"Independent review did not pass every integrity gate for {qid}")
        if any(visual.get(key) is not True for key in required_visual_true):
            raise PromotionError(f"Independent review did not verify the full stem for {qid}")
        if any(visual.get(key) is not False for key in required_visual_false):
            raise PromotionError(f"Independent review found unsafe/adjacent content in {qid}")
        by_id[qid] = row
    if set(by_id) != expected_ids:
        raise PromotionError("Independent review must cover exactly every question in the qpack")
    passed = int((review.get("summary") or {}).get("passed", -1))
    failed = int((review.get("summary") or {}).get("failed", -1))
    if passed != len(expected_ids) or failed != 0:
        raise PromotionError("Independent review summary does not authorize the complete qpack")
    return reviewer, reviewed_at, by_id


def promote(source_file: Path, book_dir: Path, pdf_file: Path, crop_manifest_file: Path,
            review_file: Path, output_dir: Path, catalog_file: Path) -> dict[str, Any]:
    paths = [source_file, book_dir, pdf_file, crop_manifest_file, review_file, output_dir]
    source_file, book_dir, pdf_file, crop_manifest_file, review_file, output_dir = [
        ensure_outside_repo(path) for path in paths
    ]
    if output_dir.exists() and any(output_dir.iterdir()):
        raise PromotionError("Promotion output directory must be empty to prevent stale assets")
    output_dir.mkdir(parents=True, exist_ok=True)

    source = read_json(source_file)
    manifest = read_json(crop_manifest_file)
    review = read_json(review_file)
    if source.get("kind") != "private-question-source" or not isinstance(source.get("questions"), list):
        raise PromotionError("Source must be an apply-review private-question-source envelope")
    questions = source["questions"]
    qids = [row.get("id") for row in questions if isinstance(row, dict)]
    if len(qids) != len(questions) or len(set(qids)) != len(qids) or not qids:
        raise PromotionError("Source qpack has missing/duplicate/no question ids")
    book_id = str(source.get("bookId") or "")
    pdf_hash = sha256(pdf_file)
    catalog_hash = catalog_books(catalog_file).get(book_id)
    if not catalog_hash or pdf_hash != catalog_hash or source.get("pdfSha256") != pdf_hash:
        raise PromotionError("Source PDF/qpack does not match the trusted textbook catalog")
    if manifest.get("schema") != 11 or manifest.get("kind") != "textbook-crop-manifest" or manifest.get("bookId") != book_id \
            or manifest.get("pdfSha256") != pdf_hash or not isinstance(manifest.get("crops"), dict):
        raise PromotionError("Crop manifest is not bound to the same trusted textbook")
    crop_dpi = manifest.get("cropDpi")
    if not isinstance(crop_dpi, int) or crop_dpi < 150 or crop_dpi > 600:
        raise PromotionError("Crop manifest DPI is invalid")
    producer = str(source.get("reviewedBy") or "").strip()
    if len(producer) < 3:
        raise PromotionError("Reviewed qpack has no named producer")
    source_hash = sha256(source_file)
    manifest_hash = sha256(crop_manifest_file)
    reviewer, reviewed_at, review_by_id = review_rows(
        review, set(qids), source_hash, manifest_hash, producer)

    upload_root = output_dir / "stem-assets"
    upload_root.mkdir(parents=True, exist_ok=True)
    document = fitz.open(str(pdf_file))
    updated: list[dict[str, Any]] = []
    promoted: list[dict[str, Any]] = []
    try:
        for question in questions:
            qid = question["id"]
            if question.get("bookId") != book_id or question.get("displayTruth") != "original-pdf-crop" \
                    or question.get("needsStemAsset") is not True:
                raise PromotionError(f"Question {qid} did not arrive through the scan-review quarantine")
            page = question.get("page")
            if not isinstance(page, int) or page < 1:
                raise PromotionError(f"Question {qid} has no valid PDF page")
            entry = manifest["crops"].get(qid)
            region = (entry or {}).get("stemRegion")
            if not isinstance(region, list):
                raise PromotionError(f"Question {qid} has no rendered stem crop")
            page_index_file = book_dir / "pages" / f"p{page:04d}.json"
            page_index = read_json(page_index_file)
            if page_index.get("bookId") != book_id or page_index.get("pdfSha256") != pdf_hash \
                    or page_index.get("pdfPage") != page:
                raise PromotionError(f"Page index is not bound to the trusted PDF for {qid}")
            page_width, page_height, review_dpi = (
                page_index.get("width"), page_index.get("height"), page_index.get("dpi"))
            if not all(isinstance(value, int) and value > 0 for value in (page_width, page_height, review_dpi)):
                raise PromotionError(f"Page index geometry is invalid for {qid}")
            bbox = normalized_bbox(region, page_width, page_height)
            crop_file = book_dir / "crops" / qid / "stem.png"
            if not crop_file.is_file():
                raise PromotionError(f"Stem crop is missing for {qid}")
            width, height = pixmap_matches_original(
                crop_file, document, page, region, review_dpi, crop_dpi)
            crop_hash = sha256(crop_file)
            review_row = review_by_id[qid]
            if review_row.get("cropSha256") != crop_hash:
                raise PromotionError(f"Reviewed crop hash changed for {qid}")
            includes_options = question.get("type") == "fill" or review_row["visual"].get("allOptionsVerified") is True
            if question.get("type") != "fill" and not includes_options:
                raise PromotionError(f"Choice question crop does not include every option for {qid}")
            storage_path = f"{book_id}/{qid}-{crop_hash[:16]}.png"
            output_file = upload_root / storage_path
            output_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(crop_file, output_file)
            if sha256(output_file) != crop_hash:
                raise PromotionError(f"Copied stem crop changed for {qid}")
            stem_asset = {
                "path": storage_path, "sha256": crop_hash, "sourcePdfSha256": pdf_hash,
                "pageIndex": page, "bbox": bbox, "role": "question-stem",
                "assetStatus": "verified", "mime": "image/png", "width": width, "height": height,
                "containsAnswer": False, "containsSolution": False, "containsHandwriting": False,
                "includesOptions": includes_options, "questionIds": [qid], "bookId": book_id,
                "producer": producer,
                "verifier": {
                    "reviewer": reviewer, "reviewVersion": 1, "questionRoleVerified": True,
                    "safetyVerified": True, "assetHashVerified": True, "fullStemVerified": True,
                    "optionsVerified": includes_options, "verifiedAt": reviewed_at,
                },
            }
            row = {**question, "stemAsset": stem_asset}
            row.pop("needsStemAsset", None)
            row.pop("visualStatus", None)
            row.pop("visualPendingReason", None)
            updated.append(row)
            promoted.append({"id": qid, "page": page, "storagePath": storage_path, "sha256": crop_hash})
    finally:
        document.close()

    output_source = output_dir / "source-with-reviewed-stems.json"
    output_payload = {**source, "questions": updated, "stemReview": {
        "kind": "matha-private-stem-promotion", "version": 1,
        "reviewer": reviewer, "reviewedAt": reviewed_at,
        "sourceSha256": source_hash, "cropManifestSha256": manifest_hash,
    }}
    output_source.write_text(json.dumps(output_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    promotion = {
        "kind": "matha-private-stem-promotion", "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(), "uploadPerformed": False,
        "bookId": book_id, "sourcePdfSha256": pdf_hash,
        "sourceFileSha256": source_hash, "cropManifestSha256": manifest_hash,
        "independentReviewSha256": sha256(review_file), "outputSourceSha256": sha256(output_source),
        "summary": {"questions": len(promoted)}, "questions": promoted,
    }
    promotion_file = output_dir / "stem-promotion-manifest.json"
    promotion_file.write_text(json.dumps(promotion, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"questions": len(promoted), "sourceOutput": str(output_source),
            "assetRoot": str(upload_root), "promotionManifest": str(promotion_file)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--book-dir", required=True, type=Path)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--crop-manifest", required=True, type=Path)
    parser.add_argument("--review", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--catalog", type=Path, default=REPO_ROOT / "textbook-catalog.js")
    args = parser.parse_args(argv)
    try:
        result = promote(args.source, args.book_dir, args.pdf, args.crop_manifest,
                         args.review, args.output, args.catalog)
    except (PromotionError, OSError, ValueError) as error:
        print(f"promote-reviewed-stems: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
