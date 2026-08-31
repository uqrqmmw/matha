#!/usr/bin/env python3
"""Build exact, original-pixel question bands for the paper workspace.

This does not OCR or rewrite any mathematics.  It reads the question-number
anchors already embedded in the source PDFs and emits normalized page bands;
the browser still displays the reviewed PNG pixels from private Storage.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import fitz


QUESTION_LABEL = re.compile(r"^((?:[1-9]|1[0-9]|20))\.")

# The publisher's three legacy papers are image-only double-page scans.  These
# are the visually verified question-number baselines at the script's 2x
# render (1190 px tall).  They locate pixels only; no OCR text is trusted or
# emitted.  Each tuple is one logical app page in scan order.
LEGACY_PIXEL_ROWS = {
    "paper-mock-1": [
        [204, 365, 600, 776, 908], [145, 409, 681], [138, 475, 717],
        [139, 393, 764], [139, 552, 670], [154, 328, 529],
    ],
    "paper-mock-2": [
        [208, 558, 847], [151, 271, 531, 676], [182, 358, 574],
        [139, 414, 650], [174, 445, 601, 771], [176, 471],
    ],
    "paper-mock-3": [
        [206, 357, 508, 610, 816], [149, 357, 706], [144, 404, 654, 745, 953],
        [211, 280, 406, 514, 659, 800, 980],
    ],
}


def desktop() -> Path:
    return Path.home() / "Desktop"


def resolve_hint(value: str) -> Path:
    return Path(value.replace("%DESKTOP%", str(desktop())))


def label_anchors(pdf: Path, logical_pages: list[tuple[int, str]]) -> dict[int, tuple[int, float]]:
    """Return question number -> (logical app page, normalized top)."""
    doc = fitz.open(pdf)
    found: dict[int, tuple[int, float]] = {}
    for app_page, (pdf_page, side) in enumerate(logical_pages):
        page = doc[pdf_page - 1]
        width, height = page.rect.width, page.rect.height
        if side == "left":
            x0, x1 = 0.0, width / 2
        elif side == "right":
            x0, x1 = width / 2, width
        else:
            x0, x1 = 0.0, width
        local_width = x1 - x0
        candidates: dict[int, list[tuple[float, float]]] = {}
        for word in page.get_text("words"):
            text = str(word[4]).strip()
            match = QUESTION_LABEL.match(text)
            if not match:
                continue
            center_x = (float(word[0]) + float(word[2])) / 2
            if not (x0 <= center_x < x1):
                continue
            local_x = float(word[0]) - x0
            # True question labels sit in the outer text gutter.  Numbered
            # definitions inside a long stem are indented and therefore lose.
            if local_x < 0 or local_x > local_width * 0.22:
                continue
            number = int(match.group(1))
            candidates.setdefault(number, []).append((local_x, float(word[1]) / height))
        for number, rows in candidates.items():
            local_x, top = min(rows, key=lambda row: (row[0], row[1]))
            old = found.get(number)
            if old is None or (app_page, top) < old:
                found[number] = (app_page, top)
    return found


def question_segments(anchors: dict[int, tuple[int, float]], count: int) -> dict[str, list[dict[str, float | int]]]:
    missing = [number for number in range(1, count + 1) if number not in anchors]
    if missing:
        raise ValueError(f"missing question anchors: {missing}")
    result: dict[str, list[dict[str, float | int]]] = {}
    content_top, content_bottom, pad = 0.045, 0.955, 0.012
    for number in range(1, count + 1):
        start_page, start_top = anchors[number]
        if number < count:
            end_page, end_top = anchors[number + 1]
        else:
            end_page, end_top = start_page, content_bottom
        segments: list[dict[str, float | int]] = []
        for page in range(start_page, end_page + 1):
            top = max(content_top, start_top - pad) if page == start_page else content_top
            bottom = min(content_bottom, end_top - pad) if page == end_page else content_bottom
            if bottom - top < 0.025:
                continue
            segments.append({"page": page, "top": round(top, 6), "bottom": round(bottom, 6)})
        if not segments:
            raise ValueError(f"question {number} produced no visible segment")
        result[str(number)] = segments
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = (args.output or repo / "paper-question-crops.js").resolve()
    inventory = json.loads((repo / "docs" / "full-paper-inventory.json").read_text(encoding="utf-8"))
    manifest_path = resolve_hint(inventory["privateAppIntegration"]["assetManifestPathHint"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    documents = {row["id"]: resolve_hint(row["pathHint"]) for row in inventory["sourceDocuments"]}

    papers: dict[str, dict[str, object]] = {}
    for paper in manifest["papers"]:
        logical_pages = [(int(asset["pdfPage"]), "full") for asset in paper["assets"]]
        anchors = label_anchors(documents[paper["sourceId"]], logical_pages)
        try:
            questions = question_segments(anchors, 20)
        except ValueError as error:
            raise ValueError(f'{paper["appSourceId"]}: {error}; found={sorted(anchors)}') from error
        papers[paper["appSourceId"]] = {
            "sourceSha256": paper["sourceSha256"],
            "questions": questions,
        }

    publisher = documents["publisher-question"]
    legacy = {
        "paper-mock-1": ([2, 3, 4], 20),
        "paper-mock-2": ([6, 7, 8], 19),
        "paper-mock-3": ([10, 11], 20),
    }
    publisher_sha = next(row["sha256"] for row in inventory["sourceDocuments"] if row["id"] == "publisher-question")
    for source_id, (pdf_pages, count) in legacy.items():
        rows = LEGACY_PIXEL_ROWS[source_id]
        anchors: dict[int, tuple[int, float]] = {}
        number = 1
        for app_page, page_rows in enumerate(rows):
            for top in page_rows:
                anchors[number] = (app_page, top / 1190)
                number += 1
        if number - 1 != count:
            raise ValueError(f"{source_id}: expected {count} legacy anchors, got {number - 1}")
        papers[source_id] = {
            "sourceSha256": publisher_sha,
            "questions": question_segments(anchors, count),
        }

    payload = {"schema": 1, "method": "original-pixel-question-anchors", "papers": papers}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    output.write_text(
        "/* Generated by scripts/generate-paper-question-crops.py; original pixels only. */\n"
        f"window.PAPER_QUESTION_CROPS=Object.freeze({body});\n",
        encoding="utf-8",
    )
    print(json.dumps({"output": str(output), "papers": len(papers), "questions": sum(len(p["questions"]) for p in papers.values())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
