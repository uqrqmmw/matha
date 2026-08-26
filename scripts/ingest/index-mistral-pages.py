#!/usr/bin/env python3
"""Build page indexes from the completed Mistral OCR corpus.

Mistral text and block coordinates are index-only metadata.  Every page is
re-rendered from the catalogued PDF for layout analysis, and later student
display still comes from a separately reviewed original-PDF crop.  No scan,
page render, OCR response or derived record may be written inside the public
Git repository.

The loop is sequential and resumable.  An existing page is reused only when
the PDF hash, Mistral response hash and this index format all still match.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import cv2
import fitz
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("matha_index_pages", SCRIPT_DIR / "index-pages.py")
indexer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = indexer
SPEC.loader.exec_module(indexer)

SCHEMA_VERSION = 11
INDEX_VERSION = 1
MISTRAL_MODEL = "mistral-ocr-latest"
REVIEW_DPI = 150
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s*")


class MistralIndexError(RuntimeError):
    """Fail-closed Mistral index error."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MistralIndexError(f"Cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise MistralIndexError(f"Expected a JSON object: {path}")
    return value


def catalog_books(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        raw = json.loads(text)
        rows = [*(raw.get("books") or []), *(raw.get("supplemental") or [])]
        return {str(row["id"]): str(row["pdfSha256"])
                for row in rows if row.get("id") and row.get("pdfSha256")}
    return {match.group(1): match.group(2) for match in re.finditer(
        r"\{\s*id:'([^']+)'[^\n]*?pdfSha256:'([a-f0-9]{64})'", text)}


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def clean_content(value: Any) -> str:
    return HEADING_RE.sub("", str(value or "").strip(), count=1).strip()


def scaled_box(block: dict[str, Any], source_width: int, source_height: int,
               width: int, height: int) -> list[int]:
    values = [block.get("top_left_x"), block.get("top_left_y"),
              block.get("bottom_right_x"), block.get("bottom_right_y")]
    if any(not isinstance(value, int) for value in values):
        raise MistralIndexError("Mistral block has no integer bounding box")
    x0, y0, x1, y1 = values
    if x0 < 0 or y0 < 0 or x1 <= x0 or y1 <= y0 or x1 > source_width or y1 > source_height:
        raise MistralIndexError(f"Mistral block lies outside page dimensions: {values}")
    scaled = [round(x0 * width / source_width), round(y0 * height / source_height),
              round(x1 * width / source_width), round(y1 * height / source_height)]
    scaled[0] = max(0, min(scaled[0], width - 1))
    scaled[1] = max(0, min(scaled[1], height - 1))
    scaled[2] = max(scaled[0] + 1, min(scaled[2], width))
    scaled[3] = max(scaled[1] + 1, min(scaled[3], height))
    return scaled


def confidence(block: dict[str, Any], page: dict[str, Any]) -> float:
    scores = block.get("confidence_scores") or {}
    page_scores = page.get("confidence_scores") or {}
    for value in (scores.get("average_content_confidence_score"),
                  scores.get("block_type_confidence_score"),
                  page_scores.get("average_page_confidence_score")):
        if isinstance(value, (int, float)):
            return round(float(value), 6)
    return 0.0


def merge_regions(regions: list[list[int]]) -> list[list[int]]:
    unique: list[list[int]] = []
    seen: set[tuple[int, int, int, int]] = set()
    for region in sorted(regions, key=lambda box: (box[1], box[0], box[3], box[2])):
        key = tuple(region)
        if key not in seen:
            seen.add(key)
            unique.append(region)
    return unique


def convert_page(raw: dict[str, Any], pdf_hash: str, pdf_name: str, page_number: int,
                 image: np.ndarray, response_hash: str, book_id: str) -> dict[str, Any]:
    if raw.get("sourceSha256") != pdf_hash or raw.get("sourceFile") != pdf_name:
        raise MistralIndexError(f"Mistral source binding differs on PDF page {page_number}")
    if raw.get("sourcePageNumber") != page_number or raw.get("sourcePageIndex") != page_number - 1:
        raise MistralIndexError(f"Mistral page binding differs on PDF page {page_number}")
    if raw.get("model") != MISTRAL_MODEL:
        raise MistralIndexError(f"Unexpected OCR model on PDF page {page_number}")
    page = raw.get("page") or {}
    dimensions = page.get("dimensions") or {}
    source_width, source_height = dimensions.get("width"), dimensions.get("height")
    blocks = page.get("blocks")
    if not isinstance(source_width, int) or not isinstance(source_height, int) \
            or source_width <= 0 or source_height <= 0 or not isinstance(blocks, list):
        raise MistralIndexError(f"Mistral page dimensions/blocks are invalid on PDF page {page_number}")

    height, width = image.shape[:2]
    lines: list[dict[str, Any]] = []
    image_regions: list[list[int]] = []
    for block in blocks:
        if not isinstance(block, dict):
            raise MistralIndexError(f"Mistral block is invalid on PDF page {page_number}")
        bbox = scaled_box(block, source_width, source_height, width, height)
        block_type = str(block.get("type") or "unknown")
        if block_type == "image":
            image_regions.append(bbox)
            continue
        content = clean_content(block.get("content"))
        if not content:
            continue
        lines.append({"bbox": bbox, "text": content, "score": confidence(block, page),
                      "blockType": block_type})
    lines.sort(key=lambda line: (line["bbox"][1], line["bbox"][0]))

    banner = [{"bbox": list(line["bbox"]), "text": line["text"], "score": line["score"]}
              for line in lines if line["bbox"][1] <= 0.13 * height
              and line["bbox"][0] <= 0.50 * width]
    indexer.annotate_banner_backgrounds(image, banner)
    layout = indexer.detect_layout(image, [line["bbox"] for line in lines])
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    nontext_regions = merge_regions([*layout.nontext_regions, *image_regions])
    nontext_dark = [round(indexer.dark_fraction(gray, box) or 0.0, 4) for box in nontext_regions]
    page_confidence = (page.get("confidence_scores") or {}).get("average_page_confidence_score")
    return {
        "schema": SCHEMA_VERSION, "kind": "textbook-page-index",
        "mistralIndexVersion": INDEX_VERSION, "bookId": book_id,
        "pdfSha256": pdf_hash, "pdfPage": page_number, "dpi": REVIEW_DPI,
        "width": width, "height": height,
        "imageSha256": hashlib.sha256(image.tobytes()).hexdigest(),
        "ocrEngine": MISTRAL_MODEL, "ocrProvider": "mistral",
        "ocrSourceSha256": response_hash,
        "ocrAveragePageConfidence": round(float(page_confidence), 6)
        if isinstance(page_confidence, (int, float)) else None,
        "displayTruth": "original-pdf-crop", "ocrIsIndexOnly": True,
        "ocr": lines, "bannerOcr": banner,
        "layout": {
            "frameBoxes": layout.frame_boxes, "labelBoxes": layout.label_boxes,
            "nonTextRegions": nontext_regions, "nonTextDarkFraction": nontext_dark,
            "printedDarkFraction": layout.printed_dark,
            "inkRows": layout.ink_rows, "solidRows": layout.solid_rows,
            "mistralImageRegions": image_regions,
        },
    }


def index_book(pdf_file: Path, book_id: str, ocr_root: Path, work_root: Path,
               catalog_file: Path, force: bool = False, limit: int | None = None) -> dict[str, Any]:
    indexer.ensure_outside_repo(work_root)
    indexer.ensure_outside_repo(ocr_root)
    if not pdf_file.is_file():
        raise MistralIndexError(f"PDF not found: {pdf_file}")
    pdf_hash = sha256(pdf_file)
    if catalog_books(catalog_file).get(book_id) != pdf_hash:
        raise MistralIndexError("Book/PDF does not match the trusted textbook catalog")
    source_dir = ocr_root / "outputs" / "pages" / pdf_hash[:16]
    if not source_dir.is_dir():
        raise MistralIndexError(f"Mistral page output not found: {source_dir}")

    document = fitz.open(str(pdf_file))
    total_pages = document.page_count
    page_files = sorted(source_dir.glob("*.json"))
    if len(page_files) != total_pages:
        document.close()
        raise MistralIndexError(
            f"Mistral corpus has {len(page_files)} pages but source PDF has {total_pages}")
    total = min(total_pages, limit) if limit else total_pages
    pages_dir = work_root / book_id / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    written = skipped = 0
    started = time.time()
    try:
        for page_number in range(1, total + 1):
            response_file = source_dir / f"{page_number:04d}.json"
            response_hash = sha256(response_file)
            record_file = pages_dir / f"p{page_number:04d}.json"
            if record_file.is_file() and not force:
                existing = read_json(record_file)
                if existing.get("schema") == SCHEMA_VERSION \
                        and existing.get("mistralIndexVersion") == INDEX_VERSION \
                        and existing.get("pdfSha256") == pdf_hash \
                        and existing.get("ocrSourceSha256") == response_hash:
                    skipped += 1
                    continue
            pixmap = document[page_number - 1].get_pixmap(dpi=REVIEW_DPI, alpha=False)
            encoded = np.frombuffer(pixmap.tobytes("png"), dtype=np.uint8)
            image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
            if image is None:
                raise MistralIndexError(f"Cannot render PDF page {page_number}")
            record = convert_page(read_json(response_file), pdf_hash, pdf_file.name,
                                  page_number, image, response_hash, book_id)
            atomic_json(record_file, record)
            written += 1
            if page_number % 25 == 0 or page_number == total:
                print(f"  page {page_number}/{total} written={written} skipped={skipped}", flush=True)
    finally:
        document.close()

    summary = {
        "schema": SCHEMA_VERSION, "kind": "textbook-page-index-summary",
        "mistralIndexVersion": INDEX_VERSION, "bookId": book_id,
        "pdfFileName": pdf_file.name, "pdfSha256": pdf_hash,
        "pageCount": total_pages, "indexedPages": total, "dpi": REVIEW_DPI,
        "ocrProvider": "mistral", "ocrModel": MISTRAL_MODEL,
        "pageImagesPersisted": False, "pagesWritten": written, "pagesSkipped": skipped,
        "elapsedSeconds": round(time.time() - started, 1),
    }
    atomic_json(work_root / book_id / "index-summary.json", summary)
    return summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--ocr-root", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--catalog", type=Path, default=indexer.REPO_ROOT / "textbook-catalog.js")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args(argv)
    try:
        result = index_book(args.pdf, args.book, args.ocr_root, args.work,
                            args.catalog, args.force, args.limit)
    except (MistralIndexError, indexer.IngestError, OSError, ValueError) as error:
        print(f"index-mistral-pages: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
