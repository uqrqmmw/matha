#!/usr/bin/env python3
"""Render, OCR-index and layout-scan one scanned textbook, one page at a time.

Fail-closed and *index only*.  Nothing this program writes is student-facing
truth: the OCR text is a search/segmentation aid, the display truth stays the
original 300 dpi pixels.  It refuses to write anywhere inside the Git
repository because every byte it produces is derived from a copyrighted scan.

Resumable by design: one JSON per page, existing pages are skipped unless the
page image hash changed.  The machine running this has stalled under heavy
parallel work before, so the loop is strictly sequential.

    python scripts/ingest/index-pages.py \
        --pdf  "C:/.../114學測班直線與二元一次不等式.pdf" \
        --book matha-114-line-inequality \
        --work "C:/.../matha-ingest-work"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import fitz
import numpy as np

SCHEMA_VERSION = 10
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
REVIEW_DPI = 150
OCR_ENGINE = "rapidocr-onnxruntime-1.2.3"
# Width of the sample taken from a line's start, as a fraction of page width
# (about one inch at the 150 dpi review render).
BANNER_TAG_SAMPLE_RATIO = 0.145
BOOK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
# The scans are traditional Chinese; the OCR model emits simplified glyphs for
# some of them.  Marker matching must survive that, so normalise before compare.
SIMPLIFIED_TO_MARKER = str.maketrans({
    "题": "題", "图": "圖", "习": "習", "练": "練", "综": "綜", "难": "難",
    "简": "簡", "单": "單", "择": "擇", "选": "選", "数": "數", "学": "學",
    "测": "測", "应": "應", "关": "關", "标": "標", "线": "線", "点": "點",
    "过": "過", "长": "長", "为": "為", "则": "則", "样": "樣", "区": "區",
})


class IngestError(RuntimeError):
    """A fail-closed validation error."""


def ensure_outside_repo(path: Path) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return
    raise IngestError(f"Scan-derived output must stay outside the Git repository: {resolved}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalise_marker_text(value: str) -> str:
    return str(value or "").translate(SIMPLIFIED_TO_MARKER)


# --------------------------------------------------------------------------
# layout primitives
# --------------------------------------------------------------------------

@dataclass
class LayoutResult:
    frame_boxes: list[list[int]]
    label_boxes: list[list[int]]
    nontext_regions: list[list[int]]
    nontext_dark: list[float]
    printed_dark: float
    ink_rows: list[int]


INK_THRESHOLD = 170
SOLID_THRESHOLD = 110


def dark_fraction(gray: np.ndarray, box: list[int]) -> float | None:
    """How much of a region's ink is *solid* rather than faint.

    Printed line art and pencil are both lighter than body text, so median
    darkness confuses them — it flagged real trig graphs as handwriting.  What
    separates them is that print lays down solid ink and pencil almost never
    does: measured across four books, printed figures put 25-61% of their ink
    below 110, a previous owner's pencil 0-7%.
    """
    x0, y0, x1, y1 = box
    patch = gray[max(0, y0):y1, max(0, x0):x1]
    if patch.size == 0:
        return None
    ink = int((patch < INK_THRESHOLD).sum())
    if ink < 40:
        return None
    return float((patch < SOLID_THRESHOLD).sum()) / ink


def printed_dark_fraction(gray: np.ndarray, text_boxes: list[list[int]]) -> float:
    """The same measure over this page's printed text: the page's own baseline.

    Scan exposure varies book to book and page to page, so a fixed cut would be
    wrong somewhere; a ratio against the text on the same sheet is not.
    """
    values = [value for value in (dark_fraction(gray, box) for box in text_boxes) if value is not None]
    return round(float(np.median(values)), 4) if values else 0.0


def _ocr_fields(line: dict[str, Any]) -> dict[str, Any]:
    """Only the fields the OCR pass itself produced; derived ones are redone."""
    return {"bbox": list(line["bbox"]), "text": str(line["text"]), "score": line["score"]}


def _rect_list(contours: Any) -> list[tuple[int, int, int, int]]:
    out = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        out.append((x, y, x + w, y + h))
    return out


def is_closed_box(ink: np.ndarray, rect: list[int], coverage: float = 0.55) -> bool:
    """True when all four edges of ``rect`` are ruled.

    The 解答 / 解析 tags are closed rectangles, and they are the only reliable
    signal when OCR loses the word inside one.  A fraction bar in the left
    margin has the same bounding box but only one ruled edge, and trusting it
    would cut a question short — so every edge has to be there.
    """
    x0, y0, x1, y1 = rect
    if x1 - x0 < 6 or y1 - y0 < 6:
        return False
    band = 3
    top = ink[y0:y0 + band, x0:x1]
    bottom = ink[max(y0, y1 - band):y1, x0:x1]
    left = ink[y0:y1, x0:x0 + band]
    right = ink[y0:y1, max(x0, x1 - band):x1]
    edges = (
        (top > 0).any(axis=0).mean() if top.size else 0.0,
        (bottom > 0).any(axis=0).mean() if bottom.size else 0.0,
        (left > 0).any(axis=1).mean() if left.size else 0.0,
        (right > 0).any(axis=1).mean() if right.size else 0.0,
    )
    return all(edge >= coverage for edge in edges)


def detect_layout(image: np.ndarray, text_boxes: list[list[int]]) -> LayoutResult:
    """Find ruled rectangles and ink that no OCR line claims.

    ``frame_boxes`` are the wide ruled boxes this publisher draws around a
    question.  ``label_boxes`` are the small ruled tags in the left margin
    (解答 / 解析).  ``nontext_regions`` are figure *candidates*: ink that no OCR
    line covers, with the ruled lines themselves removed so a question frame
    does not masquerade as a diagram.
    """
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    ink = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)

    horiz_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, width // 25), 1))
    vert_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, height // 30)))
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, horiz_kernel)
    vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, vert_kernel)
    rules = cv2.dilate(cv2.bitwise_or(horiz, vert), np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(rules, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame_boxes: list[list[int]] = []
    for x0, y0, x1, y1 in _rect_list(contours):
        if (x1 - x0) >= 0.70 * width and (y1 - y0) >= 24:
            frame_boxes.append([x0, y0, x1, y1])

    # Small ruled tags live in the left margin and are much smaller than a frame.
    # They need their own kernels: the frame-sized vertical kernel is 50 px tall
    # and simply erases the 30 px sides of a 解答 tag, which is how the tag went
    # undetected and its answer ended up inside a rendered question.  The height
    # ceiling is generous because 解答 and 解析 stack into one merged contour —
    # its top is still the boundary we want.
    tag_horiz = cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(8, width // 90), 1))
    )
    tag_vert = cv2.morphologyEx(
        ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(10, height // 100)))
    )
    tag_rules = cv2.dilate(cv2.bitwise_or(tag_horiz, tag_vert), np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(tag_rules, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    label_boxes: list[list[int]] = []
    for x0, y0, x1, y1 in _rect_list(contours):
        w, h = x1 - x0, y1 - y0
        if x0 <= 0.30 * width and 0.035 * width <= w <= 0.20 * width and 16 <= h <= 130:
            if is_closed_box(ink, [x0, y0, x1, y1]):
                label_boxes.append([x0, y0, x1, y1])

    text_mask = np.zeros((height, width), np.uint8)
    for x0, y0, x1, y1 in text_boxes:
        cv2.rectangle(text_mask, (max(0, x0 - 6), max(0, y0 - 6)), (min(width, x1 + 6), min(height, y1 + 6)), 255, -1)

    # Subtract only the question-frame borders, not every long line.  A graph's
    # x-axis is also a long horizontal rule, and removing it left figure crops
    # with the axis sliced off — exactly the detail a figure question needs.
    frame_mask = np.zeros((height, width), np.uint8)
    for x0, y0, x1, y1 in frame_boxes:
        cv2.rectangle(frame_mask, (x0, y0), (x1 - 1, y1 - 1), 255, 7)

    nontext = cv2.bitwise_and(ink, cv2.bitwise_not(text_mask))
    nontext = cv2.bitwise_and(nontext, cv2.bitwise_not(frame_mask))
    glued = cv2.dilate(nontext, np.ones((11, 11), np.uint8), iterations=2)
    contours, _ = cv2.findContours(glued, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    found: list[tuple[list[int], int]] = []
    for x0, y0, x1, y1 in _rect_list(contours):
        w, h = x1 - x0, y1 - y0
        if w >= 0.06 * width and h >= 0.03 * height and int(nontext[y0:y1, x0:x1].sum() // 255) >= 350:
            box = [x0, y0, x1, y1]
            found.append((box, dark_fraction(gray, box) or 0.0))
    found.sort(key=lambda pair: (pair[0][1], pair[0][0]))

    ink_rows = (ink > 0).sum(axis=1).astype(int).tolist()
    return LayoutResult(
        frame_boxes=sorted(frame_boxes, key=lambda b: (b[1], b[0])),
        label_boxes=sorted(label_boxes, key=lambda b: (b[1], b[0])),
        nontext_regions=[box for box, _ in found],
        nontext_dark=[round(value, 4) for _, value in found],
        printed_dark=printed_dark_fraction(gray, text_boxes),
        ink_rows=ink_rows,
    )


# --------------------------------------------------------------------------
# per-page pipeline
# --------------------------------------------------------------------------

def banner_strip_gray(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    return cv2.cvtColor(image[0:max(1, int(0.11 * height)), 0:max(1, int(0.50 * width))], cv2.COLOR_BGR2GRAY)


def banner_strip_ocr(engine: Any, image: np.ndarray) -> list[dict[str, Any]]:
    """Re-read the top-left banner on a grey highlight.

    The publisher prints the difficulty tier (基礎實力養成 / 進階試題演練 /
    解題思維挑戰) reversed out of a grey block.  A straight page OCR loses that
    text on roughly half the pages, and the tier is the only printed evidence
    of difficulty there is — guessing it is exactly what must not happen.  So
    the strip is always normalised, binarised, upscaled and read again.  An
    earlier version gated this on a page-wide grey check, which skipped four
    real banners in the second book and let those blocks silently inherit the
    previous block's tier.
    """
    gray = banner_strip_gray(image)
    scale = 2.4
    normalised = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    _, binary = cv2.threshold(normalised, 150, 255, cv2.THRESH_BINARY)
    enlarged = cv2.cvtColor(
        cv2.resize(binary, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC), cv2.COLOR_GRAY2BGR
    )
    result, _ = engine(enlarged)
    lines = []
    for item in result or []:
        box, text, score = item[0], item[1], item[2]
        xs = [float(point[0]) / scale for point in box]
        ys = [float(point[1]) / scale for point in box]
        lines.append({
            "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            "text": str(text),
            "score": round(float(score), 4),
        })
    lines.sort(key=lambda line: (line["bbox"][1], line["bbox"][0]))
    return lines


def annotate_banner_backgrounds(image: np.ndarray, lines: list[dict[str, Any]]) -> None:
    """Record the paper level behind each banner line, in place.

    The 90th percentile is the background between the glyphs: it saturates at
    255 on white paper and caps around 225 inside a grey banner.  Measuring the
    *fraction* of mid-grey pixels instead did not separate the two — dense
    black text on white scored 0.18 against a banner's 0.22.

    Kept apart from the OCR pass so that changing this metric does not mean
    re-reading three thousand pages.
    """
    gray = banner_strip_gray(image)
    # Sample a fixed window from where the line starts, because that is where
    # the filled grey rectangle begins.  Measuring across the whole line failed:
    # OCR merges the banner with the chapter title beside it, and thirty pixels
    # of white paper are enough to pull the 90th percentile to 255 — which is
    # how a whole answer block failed to start and left its questions with
    # nowhere to find their printed answers.  Over four books this window reads
    # 224-230 inside a banner and 254-255 everywhere else.
    window = max(40, int(BANNER_TAG_SAMPLE_RATIO * image.shape[1]))
    for line in lines:
        x0, y0, x1, y1 = line["bbox"]
        patch = gray[max(0, y0):y1, max(0, x0):min(x1, max(0, x0) + window)]
        line["backgroundLevel"] = int(np.percentile(patch, 90)) if patch.size else 255


def ocr_page(engine: Any, image_path: Path) -> list[dict[str, Any]]:
    result, _ = engine(str(image_path))
    lines: list[dict[str, Any]] = []
    for item in result or []:
        box, text, score = item[0], item[1], item[2]
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        lines.append({
            "bbox": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            "text": str(text),
            "score": round(float(score), 4),
        })
    lines.sort(key=lambda line: (line["bbox"][1], line["bbox"][0]))
    return lines


def index_book(pdf: Path, book_id: str, work_root: Path, dpi: int, force: bool, limit: int | None) -> dict[str, Any]:
    if not BOOK_ID_RE.match(book_id):
        raise IngestError(f"Unsafe book id: {book_id!r}")
    if not pdf.is_file():
        raise IngestError(f"PDF not found: {pdf}")
    ensure_outside_repo(work_root)

    book_dir = work_root / book_id
    pages_dir = book_dir / "pages"
    images_dir = book_dir / "page-images"
    pages_dir.mkdir(parents=True, exist_ok=True)
    images_dir.mkdir(parents=True, exist_ok=True)

    from rapidocr_onnxruntime import RapidOCR  # imported late: heavy, and only needed here

    engine = RapidOCR()
    document = fitz.open(str(pdf))
    pdf_sha = sha256_file(pdf)
    total = document.page_count if limit is None else min(limit, document.page_count)

    started = time.time()
    written = 0
    skipped = 0
    reused = 0
    for number in range(1, total + 1):
        image_path = images_dir / f"p{number:04d}.png"
        record_path = pages_dir / f"p{number:04d}.json"

        if not image_path.exists() or force:
            pixmap = document[number - 1].get_pixmap(dpi=dpi)
            pixmap.save(str(image_path))
        image_sha = sha256_file(image_path)

        existing: dict[str, Any] = {}
        if record_path.exists() and not force:
            try:
                existing = json.loads(record_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                existing = {}
            if existing.get("imageSha256") == image_sha and existing.get("schema") == SCHEMA_VERSION:
                skipped += 1
                continue

        # The OCR pass costs about 2 s a page; the layout scan and the banner
        # background level cost a fraction of that.  Keeping the two apart means
        # changing a derived rule re-reads nothing — over the remaining eleven
        # books that is hours rather than minutes.
        reusable = (
            not force
            and existing.get("imageSha256") == image_sha
            and existing.get("ocrEngine") == OCR_ENGINE
            and isinstance(existing.get("ocr"), list)
            and isinstance(existing.get("bannerOcr"), list)
        )

        image = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise IngestError(f"Cannot decode rendered page: {image_path}")
        if reusable:
            lines = [_ocr_fields(line) for line in existing["ocr"]]
            banner = [_ocr_fields(line) for line in existing["bannerOcr"]]
            reused += 1
        else:
            lines = ocr_page(engine, image_path)
            banner = banner_strip_ocr(engine, image)
        annotate_banner_backgrounds(image, banner)
        layout = detect_layout(image, [line["bbox"] for line in lines])

        record = {
            "schema": SCHEMA_VERSION,
            "kind": "textbook-page-index",
            "bookId": book_id,
            "pdfSha256": pdf_sha,
            "pdfPage": number,
            "dpi": dpi,
            "width": int(image.shape[1]),
            "height": int(image.shape[0]),
            "imageSha256": image_sha,
            "ocrEngine": OCR_ENGINE,
            "displayTruth": "original-pdf-crop",
            "ocrIsIndexOnly": True,
            "ocr": lines,
            "bannerOcr": banner,
            "layout": {
                "frameBoxes": layout.frame_boxes,
                "labelBoxes": layout.label_boxes,
                "nonTextRegions": layout.nontext_regions,
                "nonTextDarkFraction": layout.nontext_dark,
                "printedDarkFraction": layout.printed_dark,
                "inkRows": layout.ink_rows,
            },
        }
        record_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        written += 1
        if number % 10 == 0 or number == total:
            rate = (time.time() - started) / max(1, written) if written else 0.0
            print(f"  page {number}/{total}  written={written} reusedOcr={reused} "
                  f"skipped={skipped}  {rate:.1f}s/page", flush=True)

    summary = {
        "schema": SCHEMA_VERSION,
        "kind": "textbook-page-index-summary",
        "bookId": book_id,
        "pdfFileName": pdf.name,
        "pdfSha256": pdf_sha,
        "pageCount": document.page_count,
        "indexedPages": total,
        "dpi": dpi,
        "pagesWritten": written,
        "pagesReusedOcr": reused,
        "pagesSkipped": skipped,
        "elapsedSeconds": round(time.time() - started, 1),
    }
    (book_dir / "index-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--dpi", type=int, default=REVIEW_DPI)
    parser.add_argument("--limit", type=int, default=None, help="index only the first N pages (smoke runs)")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    try:
        summary = index_book(args.pdf, args.book, args.work, args.dpi, args.force, args.limit)
    except IngestError as error:
        print(f"index-pages: {error}", file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
