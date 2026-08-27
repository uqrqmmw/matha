#!/usr/bin/env python3
"""Find likely pencil handwriting locally before using a paid eraser API.

This is a conservative pre-filter, not a release decision. It combines OCR
signals (filled answer blanks, trailing answers, isolated low-confidence math)
with grey-pencil pixels that are spatially separated from dark printed ink.
False positives may be sent for cleaning; false negatives are reduced by using
lower thresholds on questions whose printed source contains a figure.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image


FILLED_ARRAY = re.compile(
    r"\\begin\{array\}\{c\}\s*(?!\\end)(.+?)\s*\\end\{array\}", re.S
)
FILLED_BRACKET = re.compile(r"【\s*[^】\s][^】]*】")
TRAILING_ANSWER = re.compile(
    r"[？?。]\s*(?:[-+]?\d+(?:\.\d+)?|[A-E](?:\s*[A-E])*)\s*$", re.I
)
ANSWER_PREFIX = re.compile(r"^\s*(?:[A-E]\s*){2,}(?=\(?[1-9A-E]\)?)", re.I)
ANSWERISH = re.compile(r"^[\s0-9A-E+\-×÷=√^()./\\{}\[\]]+$", re.I)


class DetectError(RuntimeError):
    pass


def core_books(catalog: Path) -> list[str]:
    books = []
    for line in catalog.read_text(encoding="utf-8").splitlines():
        book_id = re.search(r"\bid:'([\w-]+)'", line)
        kind = re.search(r"\bkind:'([^']+)'", line)
        eligibility = re.search(r"\beligibility:'([^']+)'", line)
        if (
            book_id and kind and eligibility
            and kind.group(1) == "chapter"
            and eligibility.group(1) == "core"
        ):
            books.append(book_id.group(1))
    if not books or len(books) != len(set(books)):
        raise DetectError("Catalog did not yield unique core chapter books")
    return sorted(books)


def pencil_features(path: Path) -> dict[str, Any]:
    image = np.asarray(Image.open(path).convert("L"), dtype=np.uint8)
    # Flatten page shading while retaining both black print and light graphite.
    background = cv2.GaussianBlur(image, (0, 0), 21)
    normalized = np.clip(image.astype(np.int16) + 255 - background.astype(np.int16), 0, 255).astype(np.uint8)
    dark = normalized < 72
    grey = (normalized >= 82) & (normalized < 225)
    near_dark = cv2.dilate(dark.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    isolated = (grey & ~near_dark).astype(np.uint8)
    isolated[:3, :] = 0
    isolated[-3:, :] = 0
    isolated[:, :3] = 0
    isolated[:, -3:] = 0
    count, _, stats, _ = cv2.connectedComponentsWithStats(isolated, 8)
    components = []
    for index in range(1, count):
        area = int(stats[index, cv2.CC_STAT_AREA])
        width = int(stats[index, cv2.CC_STAT_WIDTH])
        height = int(stats[index, cv2.CC_STAT_HEIGHT])
        if area < 8:
            continue
        components.append((area, width, height))
    kept = [area for area, _, _ in components]
    # A scanned rule or crop border can be a large grey component despite
    # being completely clean. Require two-dimensional stroke extent before a
    # component can vote for handwriting. This retains numerals, circles and
    # pencil calculations while rejecting 2--3 px horizontal box edges.
    stroke_components = [
        area
        for area, width, height in components
        if min(width, height) >= 5 and max(width, height) / min(width, height) <= 12
    ]
    pixels = sum(kept)
    return {
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "isolatedGreyPixels": pixels,
        "isolatedGreyFraction": round(pixels / image.size, 7),
        "greyComponents": len(kept),
        "largeGreyComponents": sum(area >= 30 for area in kept),
        "maxGreyComponent": max(kept, default=0),
        "strokeGreyComponents": len(stroke_components),
        "maxStrokeGreyComponent": max(stroke_components, default=0),
    }


def overlap_center(block: dict[str, Any], box: list[int]) -> bool:
    left, top, right, bottom = block.get("bbox") or (0, 0, 0, 0)
    x = (left + right) / 2
    y = (top + bottom) / 2
    return box[0] <= x <= box[2] and box[1] <= y <= box[3]


def ocr_features(question: dict[str, Any], page: dict[str, Any]) -> dict[str, Any]:
    index = question.get("ocrIndex") or {}
    text = " ".join([str(index.get("stem") or ""), *map(str, index.get("options") or [])]).strip()
    filled_array = any(match.group(1).strip() for match in FILLED_ARRAY.finditer(text))
    filled_bracket = bool(FILLED_BRACKET.search(text))
    trailing_answer = bool(TRAILING_ANSWER.search(text))
    answer_prefix = False
    isolated = []
    box = (question.get("regions") or {}).get("contentBox") or [0, 0, 0, 0]
    for block in page.get("ocr") or []:
        if not overlap_center(block, box):
            continue
        value = " ".join(str(block.get("text") or "").split())
        if ANSWER_PREFIX.search(value):
            answer_prefix = True
        if (
            0 < len(value) <= 24
            and float(block.get("score") or 0) < 0.92
            and ANSWERISH.fullmatch(value)
        ):
            isolated.append({
                "text": value,
                "score": round(float(block.get("score") or 0), 6),
                "bbox": block.get("bbox"),
            })
    return {
        "filledAnswerArray": filled_array,
        "filledAnswerBracket": filled_bracket,
        "trailingAnswer": trailing_answer,
        "answerPrefix": answer_prefix,
        "isolatedAnswerBlocks": isolated,
    }


def detect(work: Path, catalog: Path) -> dict[str, Any]:
    items = []
    for book_id in core_books(catalog):
        book = work / book_id
        questions_file = book / "questions.pending-review.json"
        if not questions_file.is_file():
            raise DetectError(f"Missing question index: {questions_file}")
        questions = json.loads(questions_file.read_text(encoding="utf-8")).get("questions") or []
        pages: dict[int, dict[str, Any]] = {}
        for question in questions:
            question_id = str(question.get("id") or "")
            stem = book / "crops" / question_id / "stem.png"
            if not stem.is_file():
                continue
            page_number = int(question["pdfPage"])
            if page_number not in pages:
                page_file = book / "pages" / f"p{page_number:04d}.json"
                pages[page_number] = json.loads(page_file.read_text(encoding="utf-8"))
            pencil = pencil_features(stem)
            ocr = ocr_features(question, pages[page_number])
            has_figure = bool((question.get("regions") or {}).get("figures"))
            reasons = []
            for key in ("filledAnswerArray", "filledAnswerBracket", "trailingAnswer", "answerPrefix"):
                if ocr[key]:
                    reasons.append(key)
            if ocr["isolatedAnswerBlocks"]:
                reasons.append("isolatedAnswerBlock")
            # Calibration against known clean and handwritten crops showed
            # anti-aliased print creates many small grey components, while a
            # continuous pencil stroke produces a materially larger component.
            # 250 retains all six known handwriting cases (including writing
            # inside a diagram) and rejects the clean boxed examples sampled.
            grey_candidate = (
                pencil["maxStrokeGreyComponent"] >= 250
                and pencil["strokeGreyComponents"] >= 1
            )
            if grey_candidate:
                reasons.append("isolatedGreyPencil")
            if reasons:
                items.append({
                    "id": question_id,
                    "bookId": book_id,
                    "pdfPage": page_number,
                    "source": str(stem.resolve()),
                    "hasFigure": has_figure,
                    "reasons": reasons,
                    "pencil": pencil,
                    "ocr": ocr,
                })
    pages: dict[tuple[str, int], dict[str, Any]] = {}
    for item in items:
        key = (item["bookId"], item["pdfPage"])
        page = pages.setdefault(key, {
            "id": f"{item['bookId']}-pdf-{item['pdfPage']:04d}",
            "bookId": item["bookId"],
            "pdfPage": item["pdfPage"],
            "questionIds": [],
            "reasons": [],
            "strongestGreyComponent": 0,
        })
        page["questionIds"].append(item["id"])
        page["reasons"] = sorted(set(page["reasons"] + item["reasons"]))
        page["strongestGreyComponent"] = max(
            page["strongestGreyComponent"], item["pencil"]["maxStrokeGreyComponent"]
        )
    page_items = [pages[key] for key in sorted(pages)]
    return {
        "schema": 1,
        "kind": "local-handwriting-candidate-prefilter",
        "paidServiceUsed": False,
        "summary": {
            "candidateQuestions": len(items),
            "candidatePages": len(page_items),
        },
        "items": items,
        "pages": page_items,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = detect(args.work, args.catalog)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps({
            "candidateQuestions": len(result["items"]),
            "candidatePages": len(result["pages"]),
            "out": str(args.out.resolve()),
        }, ensure_ascii=False))
        return 0
    except (OSError, ValueError, DetectError) as error:
        print(f"detect-handwriting-candidates: {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
