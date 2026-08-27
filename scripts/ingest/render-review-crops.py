#!/usr/bin/env python3
"""Render the crops a human reviews, straight from the original PDF.

The question a student eventually sees is these pixels, not the OCR text, so
the crop is cut from the source PDF at full resolution rather than from the
150 dpi review render.  Stem, options, figures and the answer/solution are cut
as *separate* files: if a stem crop ever contained its own answer there would
be no way to run the app's delayed-solution workflow.

The separation is asserted here, not assumed.  A crop that would reach past
its question's answer boundary is refused and the question is marked
``crop-refused-crosses-answer-boundary`` instead of being written out.

This step never writes back into ``questions.pending-review.json``.  It used
to, and a later ``build-book-map`` run regenerated that file and silently
dropped every record that crops existed — the images were still on disk but
nothing knew.  What it produces goes in its own manifest instead.

Outputs (all outside the Git repository, all review-only):

    <work>/<bookId>/crops/<questionId>/stem.png · figure-N.png · answer.png
    <work>/<bookId>/crops-manifest.json
    <work>/<bookId>/review.html
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

import fitz

SCHEMA_VERSION = 11
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CROP_DPI = 300
# OCR/figure boxes already include the printed glyphs.  Eight pixels above the
# first box was enough to pull the tail of the preceding row into 9/42 pilot
# crops, so vertical padding is asymmetric: a tiny guard above, more room below
# for fraction denominators and radicals.
TOP_PAD = 2
BOTTOM_PAD = 8
ANSWER_GAP = 4   # review-dpi pixels kept clear of the answer boundary
# Figure boxes arrive already grown to their labels and clamped off the option
# rows, so padding them again only drags neighbouring text back into the crop.
FIGURE_PAD = 0
ANSWER_PAD_X = 8
ANSWER_PAD_Y = 3
ANSWER_MARKER_RE = re.compile(r"(?:答案|答|案)\s*[:：]")


class CropError(RuntimeError):
    """A fail-closed validation error."""


def ensure_outside_repo(path: Path) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return
    raise CropError(f"Scan-derived output must stay outside the Git repository: {resolved}")


def prepare_output_dir(book_dir: Path, crops_root: Path) -> None:
    """Create an empty crop directory without allowing an unsafe deletion.

    Crop IDs can change when segmentation improves.  Leaving the previous
    directory in place makes stale questions look current in a manual audit,
    so a render is a replacement rather than an incremental update.
    """
    resolved_book = book_dir.resolve()
    resolved_crops = crops_root.resolve()
    if resolved_crops.parent != resolved_book:
        raise CropError(f"Crop output must be a direct child of the book work directory: {resolved_crops}")
    ensure_outside_repo(resolved_crops)
    if resolved_crops.exists():
        shutil.rmtree(resolved_crops)
    resolved_crops.mkdir(parents=True, exist_ok=False)


def to_pdf_rect(bbox: list[int], review_dpi: int) -> fitz.Rect:
    scale = 72.0 / review_dpi
    return fitz.Rect(bbox[0] * scale, bbox[1] * scale, bbox[2] * scale, bbox[3] * scale)


def clamp(bbox: list[int], width: int, height: int) -> list[int]:
    x0 = max(0, min(bbox[0], width - 1))
    y0 = max(0, min(bbox[1], height - 1))
    x1 = max(x0 + 1, min(bbox[2], width))
    y1 = max(y0 + 1, min(bbox[3], height))
    return [x0, y0, x1, y1]


def question_region(question: dict[str, Any], width: int, height: int) -> tuple[list[int] | None, str | None]:
    """Full-width band covering stem + options + figures, cut above the answer."""
    boxes = [box for box in [question["regions"]["stem"], *question["regions"]["options"],
                             *question["regions"]["figures"]] if box]
    if not boxes:
        return None, "empty-region"
    top = min(box[1] for box in boxes) - TOP_PAD
    bottom = max(box[3] for box in boxes) + BOTTOM_PAD
    # The ink profile may extend the bottom past an OCR baseline (for example a
    # fraction denominator), but it must never shrink a union that already
    # proves more content exists.  It also must not move the top above the first
    # stem/option/figure box: noisy ink there is normally the preceding row.
    content = question["regions"].get("contentBox")
    if content:
        bottom = max(bottom, content[3] + 2)
    boundary = question["regions"]["answerBoundaryY"]
    if boundary is not None:
        if top >= boundary - ANSWER_GAP:
            return None, "crop-refused-crosses-answer-boundary"
        bottom = min(bottom, boundary - ANSWER_GAP)
    if bottom <= top:
        return None, "crop-refused-crosses-answer-boundary"
    return clamp([0, int(top), width, int(bottom)], width, height), None


def official_answer_region(raw: list[int], indexed_page: dict[str, Any],
                           width: int, height: int) -> list[int]:
    """Return the printed answer-key row, not the whole worked solution.

    ``answerRef.region`` intentionally spans from ``1.答案`` through the
    solution.  That was useful as a source record but made the review crop
    absorb the next section heading or a neighbouring diagram.  The official
    key is the first OCR block carrying the answer marker.  OCR is used only to
    locate that row; the pixels still come directly from the source PDF.
    """
    overlapping = []
    for line in indexed_page.get("ocr") or []:
        box = line.get("bbox")
        if not box or len(box) != 4:
            continue
        if box[2] <= raw[0] or box[0] >= raw[2] or box[3] <= raw[1] or box[1] >= raw[3]:
            continue
        overlapping.append(line)
    overlapping.sort(key=lambda line: (line["bbox"][1], line["bbox"][0]))
    marked = [line for line in overlapping if ANSWER_MARKER_RE.search(str(line.get("text") or ""))]
    chosen = marked[0] if marked else (overlapping[0] if overlapping else None)
    if not chosen:
        return clamp(raw, width, height)
    box = chosen["bbox"]
    return clamp([box[0] - ANSWER_PAD_X, box[1] - ANSWER_PAD_Y,
                  box[2] + ANSWER_PAD_X, box[3] + ANSWER_PAD_Y], width, height)


def render(work_root: Path, book_id: str, pdf: Path, limit: int | None,
           variant: str | None = None) -> dict[str, Any]:
    ensure_outside_repo(work_root)
    book_dir = work_root / book_id
    suffix = f".{variant}" if variant else ""
    pack_path = book_dir / f"questions.pending-review{suffix}.json"
    if not pack_path.is_file():
        raise CropError(f"No question pack at {pack_path}; run build-book-map.py first")
    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    if pack.get("schema") != SCHEMA_VERSION:
        raise CropError("Question pack is from an older schema; re-run build-book-map.py")

    document = fitz.open(str(pdf))
    page_index = {page["pdfPage"]: page for page in
                  (json.loads(path.read_text(encoding="utf-8"))
                   for path in sorted((book_dir / "pages").glob("p*.json")))}

    crops_name = f"crops{suffix}"
    crops_root = book_dir / crops_name
    prepare_output_dir(book_dir, crops_root)
    questions = pack["questions"][:limit] if limit else pack["questions"]

    written = 0
    refused = 0
    figure_crops = 0
    answer_crops = 0
    entries: dict[str, dict[str, Any]] = {}
    for question in questions:
        indexed = page_index.get(question["pdfPage"])
        if indexed is None:
            entries[question["id"]] = {"refused": "page-index-missing"}
            continue
        review_dpi, width, height = indexed["dpi"], indexed["width"], indexed["height"]
        source = document[question["pdfPage"] - 1]
        out_dir = crops_root / question["id"]

        region, refusal = question_region(question, width, height)
        if refusal:
            entries[question["id"]] = {"refused": refusal}
            refused += 1
            continue

        out_dir.mkdir(parents=True, exist_ok=True)
        source.get_pixmap(dpi=CROP_DPI, clip=to_pdf_rect(region, review_dpi)).save(str(out_dir / "stem.png"))
        entry: dict[str, Any] = {"stemRegion": region, "figures": 0, "answer": False}
        entries[question["id"]] = entry
        written += 1

        for order, box in enumerate(question["regions"]["figures"], start=1):
            padded = clamp([box[0] - FIGURE_PAD, box[1] - FIGURE_PAD,
                            box[2] + FIGURE_PAD, box[3] + FIGURE_PAD], width, height)
            source.get_pixmap(dpi=CROP_DPI, clip=to_pdf_rect(padded, review_dpi)).save(
                str(out_dir / f"figure-{order}.png"))
            entry["figures"] += 1
            figure_crops += 1

        inline = question["regions"]["inlineAnswer"]
        answer_ref = question.get("answerRef")
        if inline:
            source.get_pixmap(dpi=CROP_DPI, clip=to_pdf_rect(clamp(inline, width, height), review_dpi)).save(
                str(out_dir / "answer.png"))
            entry["answer"] = True
            answer_crops += 1
        elif answer_ref and answer_ref.get("region"):
            answer_page = document[answer_ref["pdfPage"] - 1]
            answer_indexed = page_index.get(answer_ref["pdfPage"])
            if answer_indexed is None:
                entry["answerRefused"] = "answer-page-index-missing"
                continue
            answer_width, answer_height = answer_indexed["width"], answer_indexed["height"]
            key_region = official_answer_region(
                answer_ref["region"], answer_indexed, answer_width, answer_height)
            answer_page.get_pixmap(
                dpi=CROP_DPI,
                clip=to_pdf_rect(key_region, answer_indexed["dpi"]),
            ).save(
                str(out_dir / "answer.png"))
            # Preserve the complete printed solution as a separate reviewer
            # asset; the delayed-answer UI never has to expose it early.
            solution_region = clamp(answer_ref["region"], answer_width, answer_height)
            answer_page.get_pixmap(
                dpi=CROP_DPI,
                clip=to_pdf_rect(solution_region, answer_indexed["dpi"]),
            ).save(str(out_dir / "solution.png"))
            entry["answer"] = True
            entry["answerRegion"] = key_region
            entry["solution"] = True
            entry["solutionRegion"] = solution_region
            answer_crops += 1
        elif question.get("solutionRegion") and question.get("solutionPdfPage"):
            # The 解答 tag opens the next page; that page's lead-in is this
            # question's solution.
            following = document[question["solutionPdfPage"] - 1]
            following.get_pixmap(
                dpi=CROP_DPI,
                clip=to_pdf_rect(clamp(question["solutionRegion"], width, height), review_dpi),
            ).save(str(out_dir / "answer.png"))
            entry["answer"] = True
            entry["answerFromNextPage"] = question["solutionPdfPage"]
            answer_crops += 1

    (book_dir / f"crops-manifest{suffix}.json").write_text(json.dumps({
        "schema": SCHEMA_VERSION, "kind": "textbook-crop-manifest", "bookId": book_id,
        "pdfSha256": pack["pdfSha256"], "cropDpi": CROP_DPI, "crops": entries,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    review_path = book_dir / f"review{suffix}.html"
    review_path.write_text(render_review_html(book_id, questions, entries, crops_name), encoding="utf-8")

    return {"bookId": book_id, "questions": len(questions), "stemCrops": written,
            "figureCrops": figure_crops, "answerCrops": answer_crops, "refused": refused,
            "reviewPage": str(review_path)}


def render_review_html(book_id: str, questions: list[dict[str, Any]],
                       entries: dict[str, dict[str, Any]], crops_name: str = "crops") -> str:
    order = {"needs-repair": 0, "clean-candidate": 1}
    rows = sorted(questions, key=lambda q: (order.get(q["qaLane"], 2), q["pdfPage"]))
    parts = [
        "<meta charset='utf-8'>",
        f"<title>{html.escape(book_id)} 人工複核</title>",
        "<style>body{font:15px/1.6 system-ui,'Microsoft JhengHei',sans-serif;margin:24px;"
        "background:#fbfaf7;color:#2b2b2b}"
        "article{border:1px solid #d8d3c8;border-radius:8px;padding:14px;margin:0 0 20px;background:#fff}"
        "h2{font-size:15px;margin:0 0 6px}img{max-width:100%;display:block;border:1px solid #e5e0d5;"
        "margin:6px 0}.flag{background:#f6e7c9;padding:1px 7px;border-radius:10px;margin-right:6px;"
        "font-size:12px}.meta{color:#6b6459;font-size:13px}"
        ".ans{border-left:4px solid #b44;padding-left:10px;margin-top:10px}"
        "summary{cursor:pointer;color:#844}</style>",
        f"<h1>{html.escape(book_id)}：待人工複核 {len(rows)} 題</h1>",
        "<p class='meta'>顯示真值為原 PDF 裁切。題幹／選項／圖與答案／詳解分開存檔；"
        "答案區預設收合，複核題幹時不會看到答案。全部 <code>pending-review</code>。</p>",
    ]
    for question in rows:
        folder = f"{crops_name}/{question['id']}"
        parts.append("<article>")
        parts.append(f"<h2>{html.escape(question['id'])} · {question['qaLane']}</h2>")
        parts.append(
            f"<p class='meta'>印刷頁 {question['printedPage']}（PDF {question['pdfPage']}）"
            f" · role <b>{html.escape(question['role'])}</b>"
            f" · type {html.escape(question['questionType'])}"
            f" · sourceDifficulty <b>{question['sourceDifficulty'] or 'null'}</b>"
            f"（{html.escape(str(question['sourceDifficultyEvidence']))}）</p>")
        if question["flags"]:
            parts.append("<p>" + "".join(
                f"<span class='flag'>{html.escape(flag)}</span>" for flag in question["flags"]) + "</p>")
        entry = entries.get(question["id"]) or {}
        if entry.get("refused"):
            parts.append(f"<p><span class='flag'>{html.escape(entry['refused'])}</span></p>")
        if entry.get("stemRegion"):
            parts.append(f"<img src='{folder}/stem.png' alt='題幹裁切'>")
        for order_index in range(1, len(question["regions"]["figures"]) + 1):
            parts.append(f"<img src='{folder}/figure-{order_index}.png' alt='圖形候選 {order_index}'>")
        if (
            question["regions"]["inlineAnswer"]
            or question.get("answerRef")
            or (question.get("solutionRegion") and question.get("solutionPdfPage"))
        ):
            parts.append("<details class='ans'><summary>展開答案／詳解（複核用）</summary>"
                         f"<img src='{folder}/answer.png' alt='官方答案'>")
            if entry.get("solution"):
                parts.append(f"<img src='{folder}/solution.png' alt='官方詳解'>")
            parts.append("</details>")
        parts.append("</article>")
    return "\n".join(parts) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--variant", default=None,
                        help="read questions.pending-review.<variant>.json and write matching crop outputs")
    args = parser.parse_args(argv)
    try:
        result = render(args.work, args.book, args.pdf, args.limit, args.variant)
    except CropError as error:
        print(f"render-review-crops: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
