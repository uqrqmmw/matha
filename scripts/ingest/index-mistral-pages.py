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
INDEX_VERSION = 2
MISTRAL_MODEL = "mistral-ocr-latest"
OPENAI_REPAIR_MODEL = "gpt-5.5"
REVIEW_DPI = 150
HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s*")
EMBEDDED_NUMBERED_RE = re.compile(r"(?m)^[ \t]*(\d{1,3})[ \t]*[.．、](?!\d)")


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


def dropout_pages(ocr_root: Path) -> set[tuple[str, int]]:
    path = ocr_root / "qa" / "manual-dispositions.json"
    try:
        rows = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MistralIndexError(f"Cannot read OCR dispositions {path}: {error}") from error
    if not isinstance(rows, list):
        raise MistralIndexError("OCR dispositions must be a JSON array")
    result: set[tuple[str, int]] = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("disposition") != "ocr-dropout":
            continue
        source_hash, page_number = row.get("sourceSha256"), row.get("sourcePageNumber")
        if not isinstance(source_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", source_hash) \
                or not isinstance(page_number, int) or page_number < 1:
            raise MistralIndexError("OCR dropout has invalid source binding")
        key = (source_hash, page_number)
        if key in result:
            raise MistralIndexError(f"Duplicate OCR dropout disposition: {key}")
        result.add(key)
    return result


def validate_repair_candidate(candidate_file: Path, ocr_root: Path, pdf_hash: str,
                              pdf_name: str, page_number: int) -> dict[str, Any]:
    candidate = read_json(candidate_file)
    if candidate.get("sourceSha256") != pdf_hash or candidate.get("sourceFile") != pdf_name \
            or candidate.get("sourcePageNumber") != page_number \
            or candidate.get("sourcePageIndex") != page_number - 1:
        raise MistralIndexError(f"Repair source binding differs on PDF page {page_number}")
    if candidate.get("repairReason") != "whole-document-ocr-dropout":
        raise MistralIndexError(f"Unexpected repair reason on PDF page {page_number}")
    provider = candidate.get("repairProvider") or (
        "mistral" if candidate.get("repairModel") == MISTRAL_MODEL else None)
    expected = {
        "mistral": (MISTRAL_MODEL, "single-page-jpeg-240dpi"),
        "openai": (OPENAI_REPAIR_MODEL, "single-page-jpeg-240dpi-structured-vision"),
    }
    actual = (candidate.get("repairModel"), candidate.get("repairMethod"))
    if provider not in expected or actual != expected[provider]:
        raise MistralIndexError(f"Untrusted repair provider/model/method on PDF page {page_number}")

    basename = f"{pdf_hash[:16]}-p{page_number:04d}"
    render_file = ocr_root / "repairs" / "dropouts" / "renders" / f"{basename}.jpg"
    if not render_file.is_file() or candidate.get("renderSha256") != sha256(render_file):
        raise MistralIndexError(f"Repair render hash differs on PDF page {page_number}")
    raw_root = ocr_root / "repairs" / "dropouts" / "raw"
    if provider == "openai":
        raw_file = raw_root / f"{basename}-openai.json"
        if not raw_file.is_file() or candidate.get("rawResponseSha256") != sha256(raw_file):
            raise MistralIndexError(f"OpenAI repair response hash differs on PDF page {page_number}")
        response = read_json(raw_file)
        resolved_model = candidate.get("repairResolvedModel")
        if not isinstance(resolved_model, str) or not (
            resolved_model == OPENAI_REPAIR_MODEL
            or resolved_model.startswith(OPENAI_REPAIR_MODEL + "-")
        ) or response.get("model") != resolved_model or response.get("status") != "completed" \
                or response.get("id") != candidate.get("responseId"):
            raise MistralIndexError(f"OpenAI repair response provenance differs on PDF page {page_number}")
        output_texts = [
            item.get("text")
            for output in response.get("output", []) if isinstance(output, dict)
            for item in output.get("content", []) if isinstance(item, dict)
            and item.get("type") == "output_text" and isinstance(item.get("text"), str)
        ]
        try:
            structured = json.loads(output_texts[0]) if len(output_texts) == 1 else None
        except json.JSONDecodeError as error:
            raise MistralIndexError(
                f"OpenAI repair output is not structured JSON on PDF page {page_number}") from error
        if not isinstance(structured, dict) or not isinstance(structured.get("blocks"), list):
            raise MistralIndexError(f"OpenAI repair output is invalid on PDF page {page_number}")
        expected_blocks = [{
            "top_left_x": block.get("bbox", [None] * 4)[0],
            "top_left_y": block.get("bbox", [None] * 4)[1],
            "bottom_right_x": block.get("bbox", [None] * 4)[2],
            "bottom_right_y": block.get("bbox", [None] * 4)[3],
            "content": block.get("text"), "type": block.get("blockType"),
        } for block in structured["blocks"] if isinstance(block, dict)]
        candidate_page = candidate.get("page") or {}
        if candidate_page.get("markdown") != structured.get("pageMarkdown") \
                or candidate_page.get("blocks") != expected_blocks \
                or candidate.get("qualityWarnings") != structured.get("qualityWarnings"):
            raise MistralIndexError(
                f"OpenAI repair candidate differs from raw response on PDF page {page_number}")
    else:
        raw_file = raw_root / f"{basename}.json"
        response = read_json(raw_file)
        pages = response.get("pages")
        if not isinstance(pages, list) or len(pages) != 1 or pages[0] != candidate.get("page"):
            raise MistralIndexError(f"Mistral repair response differs on PDF page {page_number}")
    page = candidate.get("page")
    if not isinstance(page, dict):
        raise MistralIndexError(f"Repair page payload is invalid on PDF page {page_number}")
    return {
        "candidate": candidate,
        "candidateSha256": sha256(candidate_file),
        "provider": provider,
        "model": candidate["repairModel"],
        "resolvedModel": candidate.get("repairResolvedModel") or candidate["repairModel"],
        "method": candidate["repairMethod"],
        "renderSha256": candidate["renderSha256"],
        "rawResponseSha256": sha256(raw_file),
    }


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


def embedded_numbered_segments(content: str) -> list[str]:
    """Split only a proven consecutive run of page-level numbered items.

    Mistral sometimes returns an entire textbook page as one block.  Internal
    item markers are accepted only at paragraph starts and only when every
    number is consecutive; this excludes decimals, option labels and most
    numbered prose.  Ambiguous blocks remain untouched for manual review.
    """
    matches = []
    for match in EMBEDDED_NUMBERED_RE.finditer(content):
        if match.start() == 0 or re.search(r"\n[ \t]*\n[ \t]*\Z", content[:match.start()]):
            matches.append(match)
    if len(matches) < 2 or matches[0].start() != 0:
        return [content]
    numbers = [int(match.group(1)) for match in matches]
    if numbers != list(range(numbers[0], numbers[0] + len(numbers))):
        return [content]
    return [content[match.start():matches[index + 1].start()].strip()
            if index + 1 < len(matches) else content[match.start():].strip()
            for index, match in enumerate(matches)]


def segment_weight(text: str) -> int:
    lines = sum(1 for line in text.splitlines() if line.strip())
    matrix_rows = text.count("\\\\")
    return max(1, lines + matrix_rows)


def blank_row_runs(gray: np.ndarray, box: list[int]) -> list[tuple[int, int]]:
    x0, y0, x1, y1 = box
    roi = gray[y0:y1, x0:x1]
    if roi.size == 0:
        return []
    # Scans are off-white.  A row with under 0.12% dark pixels is visually
    # blank even if it has a few compression specks.
    blank = np.mean(roi < 205, axis=1) < 0.0012
    runs: list[tuple[int, int]] = []
    start = None
    for index, is_blank in enumerate(blank):
        if is_blank and start is None:
            start = index
        if not is_blank and start is not None:
            if index - start >= 4:
                runs.append((y0 + start, y0 + index))
            start = None
    if start is not None and len(blank) - start >= 4:
        runs.append((y0 + start, y1))
    return runs


def split_block_regions(content: str, box: list[int], gray: np.ndarray) -> list[tuple[str, list[int]]]:
    segments = embedded_numbered_segments(content)
    if len(segments) == 1:
        return [(content, box)]
    x0, y0, x1, y1 = box
    height = y1 - y0
    weights = [segment_weight(segment) for segment in segments]
    total = sum(weights)
    estimates: list[int] = []
    cumulative = 0
    for weight in weights[:-1]:
        cumulative += weight
        estimates.append(round(y0 + height * cumulative / total))

    runs = blank_row_runs(gray, box)
    cuts: list[int] = []
    previous = y0
    for index, estimate in enumerate(estimates):
        remaining = len(estimates) - index
        lower = previous + 10
        upper = y1 - remaining * 10
        radius = max(35, round(height * 0.16))
        choices = [(start, end) for start, end in runs
                   if end >= estimate - radius and start <= estimate + radius
                   and (start + end) // 2 > lower and (start + end) // 2 < upper]
        if choices:
            # Prefer the nearest substantial whitespace; width is a tiebreaker.
            start, end = min(choices, key=lambda run:
                             (abs((run[0] + run[1]) // 2 - estimate),
                              -(run[1] - run[0])))
            cut = (start + end) // 2
        else:
            cut = max(lower, min(estimate, upper))
        cuts.append(cut)
        previous = cut
    edges = [y0, *cuts, y1]
    return [(segment, [x0, edges[index], x1, edges[index + 1]])
            for index, segment in enumerate(segments)]


def repair_record_matches(record: dict[str, Any], repair: dict[str, Any] | None) -> bool:
    fields = {
        "ocrRepairSourceSha256": "candidateSha256",
        "ocrRepairProvider": "provider",
        "ocrRepairEngine": "model",
        "ocrRepairResolvedEngine": "resolvedModel",
        "ocrRepairMethod": "method",
        "ocrRepairRenderSha256": "renderSha256",
        "ocrRepairRawResponseSha256": "rawResponseSha256",
    }
    if repair is None:
        return not any(field in record for field in fields)
    return all(record.get(field) == repair[source] for field, source in fields.items())


def convert_page(raw: dict[str, Any], pdf_hash: str, pdf_name: str, page_number: int,
                 image: np.ndarray, response_hash: str, book_id: str,
                 repair: dict[str, Any] | None = None) -> dict[str, Any]:
    if raw.get("sourceSha256") != pdf_hash or raw.get("sourceFile") != pdf_name:
        raise MistralIndexError(f"Mistral source binding differs on PDF page {page_number}")
    if raw.get("sourcePageNumber") != page_number or raw.get("sourcePageIndex") != page_number - 1:
        raise MistralIndexError(f"Mistral page binding differs on PDF page {page_number}")
    if repair is None and raw.get("model") != MISTRAL_MODEL:
        raise MistralIndexError(f"Unexpected OCR model on PDF page {page_number}")
    page = raw.get("page") or {}
    dimensions = page.get("dimensions") or {}
    source_width, source_height = dimensions.get("width"), dimensions.get("height")
    blocks = page.get("blocks")
    if not isinstance(source_width, int) or not isinstance(source_height, int) \
            or source_width <= 0 or source_height <= 0 or not isinstance(blocks, list):
        raise MistralIndexError(f"Mistral page dimensions/blocks are invalid on PDF page {page_number}")

    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
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
        for segment, segment_box in split_block_regions(content, bbox, gray):
            lines.append({"bbox": segment_box, "text": segment,
                          "score": confidence(block, page), "blockType": block_type})
    lines.sort(key=lambda line: (line["bbox"][1], line["bbox"][0]))

    banner = [{"bbox": list(line["bbox"]), "text": line["text"], "score": line["score"]}
              for line in lines if line["bbox"][1] <= 0.13 * height
              and line["bbox"][0] <= 0.50 * width]
    indexer.annotate_banner_backgrounds(image, banner)
    layout = indexer.detect_layout(image, [line["bbox"] for line in lines])
    nontext_regions = merge_regions([*layout.nontext_regions, *image_regions])
    nontext_dark = [round(indexer.dark_fraction(gray, box) or 0.0, 4) for box in nontext_regions]
    page_confidence = (page.get("confidence_scores") or {}).get("average_page_confidence_score")
    record = {
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
    if repair is not None:
        record.update({
            "ocrRepairSourceSha256": repair["candidateSha256"],
            "ocrRepairProvider": repair["provider"],
            "ocrRepairEngine": repair["model"],
            "ocrRepairResolvedEngine": repair["resolvedModel"],
            "ocrRepairMethod": repair["method"],
            "ocrRepairRenderSha256": repair["renderSha256"],
            "ocrRepairRawResponseSha256": repair["rawResponseSha256"],
        })
    return record


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
    reviewed_dropouts = dropout_pages(ocr_root)
    written = skipped = repairs_applied = 0
    started = time.time()
    try:
        for page_number in range(1, total + 1):
            response_file = source_dir / f"{page_number:04d}.json"
            response_hash = sha256(response_file)
            repair = None
            if (pdf_hash, page_number) in reviewed_dropouts:
                repair_file = (ocr_root / "repairs" / "dropouts" / "candidates" /
                               f"{pdf_hash[:16]}-p{page_number:04d}.json")
                if not repair_file.is_file():
                    raise MistralIndexError(
                        f"Reviewed OCR dropout has no repair candidate on PDF page {page_number}")
                repair = validate_repair_candidate(
                    repair_file, ocr_root, pdf_hash, pdf_file.name, page_number)
            record_file = pages_dir / f"p{page_number:04d}.json"
            if record_file.is_file() and not force:
                existing = read_json(record_file)
                if existing.get("schema") == SCHEMA_VERSION \
                        and existing.get("mistralIndexVersion") == INDEX_VERSION \
                        and existing.get("pdfSha256") == pdf_hash \
                        and existing.get("ocrSourceSha256") == response_hash \
                        and repair_record_matches(existing, repair):
                    skipped += 1
                    repairs_applied += int(repair is not None)
                    continue
            pixmap = document[page_number - 1].get_pixmap(dpi=REVIEW_DPI, alpha=False)
            encoded = np.frombuffer(pixmap.tobytes("png"), dtype=np.uint8)
            image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
            if image is None:
                raise MistralIndexError(f"Cannot render PDF page {page_number}")
            selected = repair["candidate"] if repair else read_json(response_file)
            record = convert_page(selected, pdf_hash, pdf_file.name,
                                  page_number, image, response_hash, book_id, repair)
            atomic_json(record_file, record)
            written += 1
            repairs_applied += int(repair is not None)
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
        "verifiedDropoutRepairsApplied": repairs_applied,
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
