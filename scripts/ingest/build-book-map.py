#!/usr/bin/env python3
"""Turn one book's page index into a reviewable section map and question pack.

Everything here is derived from the OCR *index* plus ruled-line geometry.  The
OCR text is never the displayed question: each record carries the crop boxes a
later step renders from the original 300 dpi PDF.  Nothing is promoted; every
record leaves as ``pending-review`` and is sorted into a QA lane so a human
looks at the doubtful ones first.

The rules that matter and why:

* A question's answer/solution lives *below* the 解答 / 解析 tag on the same
  page, so the tag's y is a hard cut.  Any stem, option or figure box that
  reaches past it is contamination, not a question.
* Difficulty is only recorded when the book prints it.  Absent a printed
  marker the field is ``null`` with ``sourceDifficultyEvidence: "none"`` — a
  guessed "medium" would be indistinguishable from evidence later.
* A stem that says 如圖 but has no figure candidate is flagged, never dropped.
  Figure questions are the ones the student most needs.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

SIMPLIFIED_TO_MARKER = str.maketrans({
    "题": "題", "图": "圖", "习": "習", "练": "練", "综": "綜", "难": "難",
    "简": "簡", "单": "單", "择": "擇", "选": "選", "数": "數", "学": "學",
    "测": "測", "应": "應", "关": "關", "标": "標", "线": "線", "点": "點",
    "过": "過", "长": "長", "为": "為", "则": "則", "样": "樣", "区": "區",
    "详": "詳", "解": "解", "答": "答", "级": "級", "试": "試", "题": "題",
    "础": "礎", "阶": "階", "战": "戰", "挑": "挑", "进": "進", "习": "習",
})

ANSWER_TAG_RE = re.compile(r"^\s*[\[［(（]?\s*(解答|解析|詳解|答案|說明|证明|證明)\s*[\]］)）:：]?")
ANSWER_TAG_ANYWHERE_RE = re.compile(r"(解答|解析|詳解|答案)\s*[:：]")
EXAMPLE_RE = re.compile(r"(?:^|[^A-Za-z])Ex\s*[.．]?\s*(\d{1,3})\s*[.．、]")
NUMBERED_QUESTION_RE = re.compile(r"^\s*(\d{1,3})\s*[.．、]\s*[（(]\s*[）)]")
NUMBERED_PLAIN_RE = re.compile(r"^\s*(\d{1,3})\s*[.．、]\s*\S")
ANSWER_KEY_ITEM_RE = re.compile(r"^\s*(\d{1,3})\s*[.．、]\s*(答案|解析|詳解)")
OPTION_RE = re.compile(r"^\s*[（(]\s*[A-Ea-e1-5]\s*[）)]")
PAGE_NUMBER_RE = re.compile(r"^\s*[-–—]?\s*(\d{1,4})\s*[-–—]?\s*$")
PAST_EXAM_RE = re.compile(r"(\d{2,3})\s*(?:學測|指考|分科|模擬考|統測)\s*(?:數\s*[AB])?")

# Printed difficulty banners this publisher family uses on chapter-end drills.
DIFFICULTY_MARKERS: tuple[tuple[str, str], ...] = (
    ("簡單", "easy"), ("基礎", "easy"), ("基本", "easy"),
    ("中等", "medium"), ("進階", "medium"),
    ("困難", "hard"), ("挑戰", "hard"), ("高階", "hard"),
)
SECTION_BANNER_RE = re.compile(r"(綜合練習|章末練習|習題|自我評量|實力測驗|總複習|課後練習)")

# Phrases whose presence means the printed figure is part of the question.
VISUAL_REFERENCE_RE = re.compile(
    r"(?:如|由|見|依|根據|參考)(?:下|上|左|右|附)?圖"
    r"|(?:下|上|左|右|附)圖"
    r"|圖中|圖示|示意圖|圖形為|的圖形|陰影區域|座標平面上(?:繪|畫|標)"
    r"|(?:根據|依據|參考)(?:附|下|上|左|右)?表|(?:附|下|上|左|右)表"
)


class MapError(RuntimeError):
    """A fail-closed validation error."""


def ensure_outside_repo(path: Path) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return
    raise MapError(f"Scan-derived output must stay outside the Git repository: {resolved}")


def norm(value: str) -> str:
    return str(value or "").translate(SIMPLIFIED_TO_MARKER)


def bbox_union(boxes: Iterable[list[int]]) -> list[int] | None:
    boxes = list(boxes)
    if not boxes:
        return None
    return [
        min(b[0] for b in boxes), min(b[1] for b in boxes),
        max(b[2] for b in boxes), max(b[3] for b in boxes),
    ]


def boxes_overlap(a: list[int], b: list[int]) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


# --------------------------------------------------------------------------
# page-level reading
# --------------------------------------------------------------------------

def read_printed_page(page: dict[str, Any]) -> int | None:
    """The footer prints ``- 58 -``.  Read it rather than assuming an offset."""
    height, width = page["height"], page["width"]
    best: tuple[float, int] | None = None
    for line in page["ocr"]:
        x0, y0, x1, y1 = line["bbox"]
        if y0 < 0.92 * height:
            continue
        match = PAGE_NUMBER_RE.match(line["text"].strip())
        if not match:
            continue
        centre_offset = abs((x0 + x1) / 2 - width / 2) / width
        if centre_offset > 0.25:
            continue
        score = float(line["score"]) - centre_offset
        if best is None or score > best[0]:
            best = (score, int(match.group(1)))
    return None if best is None else best[1]


def answer_boundary_y(page: dict[str, Any]) -> tuple[int | None, str]:
    """Lowest safe y for question content: the top of the first answer tag.

    Two independent signals must agree in *kind* — an OCR tag, or a ruled tag
    box in the left margin that an OCR tag sits next to.  When only geometry
    fires we still cut, but the page is flagged so a human confirms it.
    """
    width = page["width"]
    tag_ys: list[int] = []
    for line in page["ocr"]:
        text = norm(line["text"]).strip()
        x0, y0 = line["bbox"][0], line["bbox"][1]
        if x0 > 0.42 * width:
            continue
        if ANSWER_TAG_RE.match(text) or ANSWER_KEY_ITEM_RE.match(text):
            tag_ys.append(y0)
    if tag_ys:
        return min(tag_ys), "ocr-tag"

    # Geometry-only fallback: a small ruled tag in the left margin with ink to
    # its right and nothing that reads like a question start below it.
    label_boxes = [b for b in page["layout"]["labelBoxes"] if b[0] <= 0.22 * width]
    if label_boxes:
        return min(b[1] for b in label_boxes), "label-box-only"
    return None, "none"


def collect_headings(page: dict[str, Any]) -> tuple[str | None, str | None]:
    """Centred large line = chapter title; flush-left large line = sub-heading."""
    width = page["width"]
    chapter: tuple[int, str] | None = None
    heading: tuple[int, str] | None = None
    for line in page["ocr"]:
        x0, y0, x1, y1 = line["bbox"]
        text = norm(line["text"]).strip()
        size = y1 - y0
        if not text or len(text) < 3 or EXAMPLE_RE.search(text) or NUMBERED_PLAIN_RE.match(text):
            continue
        centred = abs((x0 + x1) / 2 - width / 2) / width < 0.12
        if size >= 32 and centred and (chapter is None or size > chapter[0]):
            chapter = (size, text)
        elif 24 <= size < 34 and x0 < 0.14 * width and (heading is None or y0 < heading[0]):
            heading = (y0, text)
    return (chapter[1] if chapter else None, heading[1] if heading else None)


def classify_page(page: dict[str, Any], boundary: int | None) -> tuple[str, list[str]]:
    """One label per page, plus the markers that produced it."""
    markers: list[str] = []
    texts = [norm(line["text"]).strip() for line in page["ocr"]]
    joined = " ".join(texts)

    if any(ANSWER_KEY_ITEM_RE.match(text) for text in texts):
        markers.append("answer-key-item")
    example_hits = [m.group(1) for text in texts for m in [EXAMPLE_RE.search(text)] if m]
    if example_hits:
        markers.append(f"Ex{example_hits[0]}")
    numbered_hits = [text for text in texts if NUMBERED_QUESTION_RE.match(text)]
    if numbered_hits:
        markers.append("numbered-choice")
    banner = SECTION_BANNER_RE.search(joined)
    if banner:
        markers.append(banner.group(1))

    if markers and markers[0] == "answer-key-item":
        return "answer-key", markers
    if example_hits:
        return "body", markers
    if numbered_hits:
        return "chapter-end", markers
    if len(page["ocr"]) <= 6 and not page["layout"]["frameBoxes"]:
        return "divider", markers
    if page["layout"]["frameBoxes"] or len(page["ocr"]) > 6:
        return "body", markers
    return "unknown", markers


def difficulty_banner(page: dict[str, Any]) -> tuple[str | None, str | None]:
    for line in page["ocr"]:
        text = norm(line["text"]).strip()
        for printed, value in DIFFICULTY_MARKERS:
            if printed in text:
                return value, text
    return None, None


# --------------------------------------------------------------------------
# question segmentation
# --------------------------------------------------------------------------

def segment_questions(
    page: dict[str, Any],
    printed_page: int,
    section: str,
    boundary: int | None,
    boundary_source: str,
    slug: str,
    book_id: str,
    difficulty: tuple[str | None, str | None],
) -> list[dict[str, Any]]:
    width, height = page["width"], page["height"]
    footer_y = int(0.94 * height)
    lines = page["ocr"]

    starts: list[tuple[int, str, str]] = []  # (y, marker, kind)
    for line in lines:
        text = norm(line["text"]).strip()
        y0 = line["bbox"][1]
        if boundary is not None and y0 >= boundary:
            continue
        match = EXAMPLE_RE.search(text)
        if match and line["bbox"][0] < 0.30 * width:
            starts.append((y0, f"ex{int(match.group(1))}", "example"))
            continue
        match = NUMBERED_QUESTION_RE.match(text)
        if match and line["bbox"][0] < 0.22 * width:
            starts.append((y0, f"q{int(match.group(1))}", "numbered"))
    starts.sort()
    if not starts:
        return []

    cut = boundary if boundary is not None else footer_y
    records: list[dict[str, Any]] = []
    for index, (y_start, marker, kind) in enumerate(starts):
        y_end = starts[index + 1][0] if index + 1 < len(starts) else cut
        y_end = min(y_end, cut)
        if y_end <= y_start:
            y_end = min(y_start + 1, cut)

        span_lines = [l for l in lines if y_start - 4 <= l["bbox"][1] < y_end and l["bbox"][1] < footer_y]
        option_lines = [l for l in span_lines if OPTION_RE.match(norm(l["text"]).strip())]
        stem_lines = [l for l in span_lines if l not in option_lines]
        figures = [
            box for box in page["layout"]["nonTextRegions"]
            if box[1] >= y_start - 8 and box[3] <= y_end + 8 and (boundary is None or box[3] <= boundary)
        ]

        stem_text = " ".join(norm(l["text"]) for l in stem_lines)
        option_text = [norm(l["text"]) for l in option_lines]
        exam_tag = PAST_EXAM_RE.search(stem_text + " " + " ".join(option_text))

        role = {
            "body": "example",
            "chapter-end": "chapter-end-unclassified",
            "answer-key": "answer-key",
        }.get(section, "unclassified")
        if section == "chapter-end" and difficulty[0]:
            role = f"chapter-end-{difficulty[0]}"

        flags: list[str] = []
        if boundary is None:
            flags.append("answer-boundary-unknown")
        elif boundary_source == "label-box-only":
            flags.append("answer-boundary-geometry-only")
        if VISUAL_REFERENCE_RE.search(stem_text) and not figures:
            flags.append("figure-referenced-but-missing")
        if figures and not VISUAL_REFERENCE_RE.search(stem_text):
            flags.append("figure-present-without-reference")
        if ANSWER_TAG_ANYWHERE_RE.search(stem_text) or any(ANSWER_TAG_RE.match(t) for t in [stem_text]):
            flags.append("answer-text-inside-stem")
        if y_end >= cut - 6 and index + 1 == len(starts) and boundary is None:
            flags.append("span-may-continue-next-page")
        if not stem_lines:
            flags.append("empty-stem")
        if kind == "numbered" and not option_lines:
            flags.append("choice-question-without-options")

        stem_box = bbox_union(l["bbox"] for l in stem_lines)
        option_box = bbox_union(l["bbox"] for l in option_lines)
        for box in [b for b in (stem_box, option_box) if b] + figures:
            if boundary is not None and box[3] > boundary:
                flags.append("region-crosses-answer-boundary")
                break

        records.append({
            "id": f"{slug}-p{printed_page:03d}-{marker}",
            "bookId": book_id,
            "pdfPage": page["pdfPage"],
            "printedPage": printed_page,
            "section": section,
            "role": role,
            "roleEvidence": "printed-Ex-marker" if kind == "example" else "printed-numbered-item",
            "sourceDifficulty": difficulty[0] if section == "chapter-end" else None,
            "sourceDifficultyEvidence": difficulty[1] or "none",
            "provenance": {"printedExamTag": exam_tag.group(0) if exam_tag else None},
            "regions": {
                "stem": stem_box,
                "options": [l["bbox"] for l in option_lines],
                "figures": figures,
                "answerBoundaryY": boundary,
                "answerRegion": [0, boundary, width, footer_y] if boundary is not None else None,
            },
            "ocrIndex": {"stem": stem_text.strip(), "options": option_text},
            "displayTruth": "original-pdf-crop",
            "status": "pending-review",
            "qaLane": "needs-repair" if flags else "clean-candidate",
            "flags": flags,
        })
    return records


# --------------------------------------------------------------------------
# book assembly
# --------------------------------------------------------------------------

def resolve_printed_pages(pages: list[dict[str, Any]]) -> dict[int, tuple[int, str]]:
    observed = {page["pdfPage"]: read_printed_page(page) for page in pages}
    offsets = Counter(
        printed - pdf_page for pdf_page, printed in observed.items() if printed is not None
    )
    if not offsets:
        raise MapError("No printed page number was readable anywhere in the book")
    offset, _ = offsets.most_common(1)[0]

    resolved: dict[int, tuple[int, str]] = {}
    for page in pages:
        pdf_page = page["pdfPage"]
        printed = observed[pdf_page]
        if printed is None:
            resolved[pdf_page] = (pdf_page + offset, "inferred")
        elif printed - pdf_page == offset:
            resolved[pdf_page] = (printed, "ocr")
        else:
            resolved[pdf_page] = (pdf_page + offset, "inferred-after-conflict")
    return resolved


def build(work_root: Path, book_id: str) -> dict[str, Any]:
    ensure_outside_repo(work_root)
    book_dir = work_root / book_id
    pages_dir = book_dir / "pages"
    if not pages_dir.is_dir():
        raise MapError(f"No page index at {pages_dir}; run index-pages.py first")

    pages = []
    for path in sorted(pages_dir.glob("p*.json")):
        pages.append(json.loads(path.read_text(encoding="utf-8")))
    if not pages:
        raise MapError("Page index is empty")
    pages.sort(key=lambda page: page["pdfPage"])

    slug = re.sub(r"^matha-\d+-", "", book_id)
    printed_map = resolve_printed_pages(pages)

    page_records: list[dict[str, Any]] = []
    questions: list[dict[str, Any]] = []
    chapter = None
    difficulty: tuple[str | None, str | None] = (None, None)

    for page in pages:
        pdf_page = page["pdfPage"]
        printed_page, printed_source = printed_map[pdf_page]
        boundary, boundary_source = answer_boundary_y(page)
        section, markers = classify_page(page, boundary)
        page_chapter, heading = collect_headings(page)
        if page_chapter:
            chapter = page_chapter
        banner_difficulty = difficulty_banner(page)
        if banner_difficulty[0]:
            difficulty = banner_difficulty
        if section != "chapter-end":
            difficulty = (None, None) if section == "body" else difficulty

        flags: list[str] = []
        if printed_source != "ocr":
            flags.append(f"printed-page-{printed_source}")
        if section == "unknown":
            flags.append("section-unresolved")
        if boundary_source == "label-box-only":
            flags.append("answer-boundary-geometry-only")

        page_records.append({
            "pdfPage": pdf_page,
            "printedPage": printed_page,
            "printedPageSource": printed_source,
            "section": section,
            "chapter": chapter,
            "heading": heading,
            "markers": markers,
            "answerBoundaryY": boundary,
            "answerBoundarySource": boundary_source,
            "sourceDifficulty": difficulty[0] if section == "chapter-end" else None,
            "sourceDifficultyEvidence": difficulty[1] if section == "chapter-end" and difficulty[1] else "none",
            "ocrLineCount": len(page["ocr"]),
            "frameBoxCount": len(page["layout"]["frameBoxes"]),
            "figureCandidateCount": len(page["layout"]["nonTextRegions"]),
            "flags": flags,
        })

        if section in {"body", "chapter-end"}:
            questions.extend(segment_questions(
                page, printed_page, section, boundary, boundary_source, slug, book_id,
                difficulty if section == "chapter-end" else (None, None),
            ))

    runs: list[dict[str, Any]] = []
    for record in page_records:
        if runs and runs[-1]["kind"] == record["section"]:
            runs[-1]["toPdfPage"] = record["pdfPage"]
            runs[-1]["pages"] += 1
        else:
            runs.append({
                "kind": record["section"],
                "fromPdfPage": record["pdfPage"],
                "toPdfPage": record["pdfPage"],
                "pages": 1,
            })

    figures = []
    for question in questions:
        for order, box in enumerate(question["regions"]["figures"]):
            figures.append({
                "id": f"{question['id']}-fig{order + 1}",
                "questionId": question["id"],
                "bookId": book_id,
                "pdfPage": question["pdfPage"],
                "printedPage": question["printedPage"],
                "bboxReviewDpi": box,
                "reviewDpi": next(p["dpi"] for p in pages if p["pdfPage"] == question["pdfPage"]),
                "aboveAnswerBoundary": (
                    question["regions"]["answerBoundaryY"] is not None
                    and box[3] <= question["regions"]["answerBoundaryY"]
                ),
                "containsAnswerRegion": False,
                "handwritingSafety": "unknown",
                "verified": False,
                "studentUsable": False,
                "status": "pending-review",
            })

    summary = json.loads((book_dir / "index-summary.json").read_text(encoding="utf-8"))
    section_map = {
        "schema": SCHEMA_VERSION,
        "kind": "textbook-section-map",
        "bookId": book_id,
        "pdfFileName": summary["pdfFileName"],
        "pdfSha256": summary["pdfSha256"],
        "pageCount": summary["pageCount"],
        "indexedPages": len(pages),
        "runs": runs,
        "pages": page_records,
    }
    question_pack = {
        "schema": SCHEMA_VERSION,
        "kind": "textbook-question-candidates",
        "bookId": book_id,
        "pdfSha256": summary["pdfSha256"],
        "displayTruth": "original-pdf-crop",
        "ocrIsIndexOnly": True,
        "allPendingReview": True,
        "questions": questions,
    }
    figure_pack = {
        "schema": SCHEMA_VERSION,
        "kind": "textbook-figure-candidates",
        "bookId": book_id,
        "pdfSha256": summary["pdfSha256"],
        "privacy": {"localOnly": True, "fullPagesStudentUsable": False},
        "figures": figures,
    }

    (book_dir / "section-map.json").write_text(json.dumps(section_map, ensure_ascii=False, indent=1), encoding="utf-8")
    (book_dir / "questions.pending-review.json").write_text(json.dumps(question_pack, ensure_ascii=False, indent=1), encoding="utf-8")
    (book_dir / "figure-candidates.json").write_text(json.dumps(figure_pack, ensure_ascii=False, indent=1), encoding="utf-8")
    (book_dir / "qa-report.md").write_text(render_report(section_map, question_pack, figure_pack), encoding="utf-8")

    return {
        "bookId": book_id,
        "pages": len(pages),
        "runs": len(runs),
        "questions": len(questions),
        "cleanCandidates": sum(1 for q in questions if q["qaLane"] == "clean-candidate"),
        "needsRepair": sum(1 for q in questions if q["qaLane"] == "needs-repair"),
        "figures": len(figures),
    }


def render_report(section_map: dict[str, Any], questions: dict[str, Any], figures: dict[str, Any]) -> str:
    rows = questions["questions"]
    flag_counts = Counter(flag for row in rows for flag in row["flags"])
    role_counts = Counter(row["role"] for row in rows)
    difficulty_counts = Counter(str(row["sourceDifficulty"]) for row in rows)

    out = [
        f"# {section_map['bookId']} 逐頁 section map 與待審題目報告",
        "",
        f"- 來源 PDF：`{section_map['pdfFileName']}`",
        f"- PDF SHA-256：`{section_map['pdfSha256']}`",
        f"- 總頁數 {section_map['pageCount']}，已索引 {section_map['indexedPages']}",
        f"- 抽出候選題 {len(rows)}，圖形候選 {len(figures['figures'])}",
        "- 全部記錄狀態為 `pending-review`；顯示真值為原檔裁切，OCR 只作索引。",
        "",
        "## 章節區段",
        "",
        "| 區段 | PDF 頁 | 頁數 |",
        "|---|---|---:|",
    ]
    for run in section_map["runs"]:
        out.append(f"| {run['kind']} | {run['fromPdfPage']}–{run['toPdfPage']} | {run['pages']} |")

    out += ["", "## role 分布（僅依印刷證據）", "", "| role | 題數 |", "|---|---:|"]
    for role, count in role_counts.most_common():
        out.append(f"| {role} | {count} |")

    out += ["", "## sourceDifficulty 分布", "", "| sourceDifficulty | 題數 |", "|---|---:|"]
    for value, count in difficulty_counts.most_common():
        out.append(f"| {value} | {count} |")

    out += ["", "## QA 旗標（需人工處理）", "", "| flag | 題數 |", "|---|---:|"]
    for flag, count in flag_counts.most_common():
        out.append(f"| {flag} | {count} |")
    if not flag_counts:
        out.append("| （無） | 0 |")

    missing = [row for row in rows if "figure-referenced-but-missing" in row["flags"]]
    out += [
        "",
        "## 提到圖但沒抓到圖的題（不得省略，優先人工補圖）",
        "",
        f"共 {len(missing)} 題。",
        "",
    ]
    for row in missing[:40]:
        out.append(f"- `{row['id']}` 印刷頁 {row['printedPage']}：{row['ocrIndex']['stem'][:60]}")
    if len(missing) > 40:
        out.append(f"- …另有 {len(missing) - 40} 題見 `questions.pending-review.json`")

    unresolved = [page for page in section_map["pages"] if page["flags"]]
    out += ["", "## 有旗標的頁", "", f"共 {len(unresolved)} 頁。", ""]
    for page in unresolved[:40]:
        out.append(f"- PDF {page['pdfPage']}（印刷 {page['printedPage']}）：{', '.join(page['flags'])}")
    if len(unresolved) > 40:
        out.append(f"- …另有 {len(unresolved) - 40} 頁見 `section-map.json`")
    return "\n".join(out) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--book", required=True)
    args = parser.parse_args(argv)
    try:
        result = build(args.work, args.book)
    except MapError as error:
        print(f"build-book-map: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
