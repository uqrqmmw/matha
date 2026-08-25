#!/usr/bin/env python3
"""Turn one book's page index into a reviewable section map and question pack.

Everything here is derived from the OCR *index* plus ruled-line geometry.  The
OCR text is never the displayed question: each record carries the crop boxes a
later step renders from the original 300 dpi PDF.  Nothing is promoted; every
record leaves as ``pending-review`` and is sorted into a QA lane so a human
looks at the doubtful ones first.

What this publisher actually prints, and how it is used here:

* Worked examples (``Ex12.``) sit in a ruled frame with their 解答 / 解析
  *on the same page*.  A page can hold several of each, interleaved, so the
  answer cut is computed per question from the next tag below it — never once
  per page, which silently swallowed every question below the first tag.
* Drill blocks open with a grey banner naming the tier — 基礎實力養成,
  進階試題演練, 解題思維挑戰 — followed by 一、單一選擇題 / 二、多重選擇題 /
  三、填充題 / 四、計算題 / 五、題組 type headers.  That banner is the only
  printed difficulty evidence in the book; without one the field stays null.
* Drill answers live in a later block under the same banner as ``1.答案：（D）``.
  They are paired back by block sequence, tier, type and number, and kept in
  their own region so a solution can never be rendered as part of a question.

A stem that says 如圖 but has no figure candidate is flagged, never dropped.
Figure questions are the ones the student most needs.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Iterable

SCHEMA_VERSION = 10
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

SIMPLIFIED_TO_MARKER = str.maketrans({
    "题": "題", "图": "圖", "习": "習", "练": "練", "综": "綜", "难": "難",
    "简": "簡", "单": "單", "择": "擇", "选": "選", "数": "數", "学": "學",
    "测": "測", "应": "應", "关": "關", "标": "標", "线": "線", "点": "點",
    "过": "過", "长": "長", "为": "為", "则": "則", "样": "樣", "区": "區",
    "详": "詳", "级": "級", "试": "試", "础": "礎", "阶": "階", "战": "戰",
    "进": "進", "组": "組", "维": "維", "计": "計", "算": "算", "养": "養",
})

ANSWER_TAG_RE = re.compile(r"^\s*[\[［(（]?\s*(解答|解析|詳解|答案)\s*[\]］)）:：]?")
ANSWER_TAG_ANYWHERE_RE = re.compile(r"(解答|解析|詳解|答案)\s*[:：]")
ANSWER_ITEM_RE = re.compile(r"^\s*(\d{1,3})\s*[.．、]\s*(?:答案|答|案)\s*[:：]?")
EXAMPLE_RE = re.compile(r"(?:^|[^A-Za-z])Ex\s*[.．]?\s*(\d{1,3})\s*[.．、]")
NUMBERED_ITEM_RE = re.compile(r"^\s*(\d{1,3})\s*[.．、]")
TYPE_HEADER_RE = re.compile(r"^\s*([一二三四五六七八])\s*[、,，.．]")
OPTION_RE = re.compile(r"^\s*[（(]\s*[A-Ea-e]\s*[）)]")
PAGE_NUMBER_RE = re.compile(r"^\s*[-–—]?\s*(\d{1,4})\s*[-–—]?\s*$")
PAST_EXAM_RE = re.compile(r"(\d{2,3})\s*(?:學測|指考|分科|模擬考|統測)\s*(?:數\s*[AB])?")

# The grey tier banner survives OCR badly.  Match on the characters that do
# survive rather than on the full phrase; an unmatched banner stays unknown.
TierTest = tuple[str, str, Callable[[str], bool]]
# Observed OCR of the three banners across two books: 基宝力餐成 / 基宝力养成 /
# 基實力成, 進試题演鍊 / 進試題演 / 試题演, 解题思维挑.  The 進 of 進階 is
# dropped often enough that requiring it silently carried the previous tier
# forward, so each tier keys on a character that actually survives.
TIER_PATTERNS: tuple[TierTest, ...] = (
    ("hard", "解題思維挑戰", lambda t: "挑" in t or "戰" in t or ("思" in t and "維" in t)),
    ("medium", "進階試題演練", lambda t: "演" in t or ("進" in t and "階" in t)),
    ("easy", "基礎實力養成", lambda t: "基" in t and ("成" in t or "礎" in t or "養" in t)),
)
TYPE_PATTERNS: tuple[tuple[str, Callable[[str], bool]], ...] = (
    ("group", lambda t: "組" in t),
    ("calculation", lambda t: "計算" in t or "算" in t),
    ("fill", lambda t: "填充" in t or "填" in t),
    ("multi", lambda t: "多" in t and _looks_like_choice(t)),
    ("single", lambda t: ("單" in t or "罩" in t) and _looks_like_choice(t)),
)
# OCR renders 選擇 as 遥挥 / 遥摆 / 遥捍 depending on the scan.
CHOICE_GARBLE = ("選", "擇", "遥", "挥", "摆", "捍", "揮")

# "讀圖" only.  A bare 的圖形 or 所示 is about the *concept* of a graph and
# matched pure algebra questions, so those are deliberately not here.
VISUAL_REFERENCE_RE = re.compile(
    r"(?:如|由|見|依|根據|參考)(?:下|上|左|右|附)?圖"
    r"|(?:下|上|左|右|附)圖"
    r"|圖中|示意圖|圖所示|陰影(?:區域|部分)"
    r"|(?:根據|依據|參考)(?:附|下|上|左|右)?表|(?:附|下|上|左|右)表"
)
# "畫圖" — the figure is the answer the student produces, so a missing figure
# candidate is correct here rather than a defect.  These questions need a
# drawing surface downstream, not a figure asset.
DRAWING_TASK_RE = re.compile(r"圖示|作出.{0,6}圖|畫出.{0,6}圖|繪出.{0,6}圖|試作圖|請畫")


def _looks_like_choice(text: str) -> bool:
    return any(mark in text for mark in CHOICE_GARBLE)


# Measured across both books: banner tags read 219-230, every plain line 255.
BANNER_BACKGROUND_MAX = 245
# A previous owner worked several of these books in pencil, in the gap between
# the question and its 解答 tag — inside the question span, sometimes carrying
# the final answer.  Print lays down solid ink and pencil does not: as a share
# of the printed text on the same page, printed figures keep 45-120% of its
# solid-ink fraction and that pencil 0-21%.  This is a flag, not an eraser: the
# crop is still produced, but the question drops to needs-repair so a reviewer
# looks before it can be approved.
ANNOTATION_DARK_RATIO = 0.35
AXIS_LABEL_MAX_CHARS = 8
AXIS_LABEL_REACH = 25


def expand_figure_box(box: list[int], lines: list[dict[str, Any]], limit: list[int]) -> list[int]:
    """Pull a diagram's own labels back into its bounding box.

    A figure candidate is ink that no OCR line claims, so the axis names, the
    origin O and the curve labels are cut out of it — which clips the axis
    arrows off the drawing.  Short OCR lines touching the region are part of
    the picture and are absorbed; option rows never are, or the crop would
    swallow the answers to a multiple-choice question.
    """
    out = list(box)
    for _ in range(2):
        reach = [out[0] - AXIS_LABEL_REACH, out[1] - AXIS_LABEL_REACH,
                 out[2] + AXIS_LABEL_REACH, out[3] + AXIS_LABEL_REACH]
        for line in lines:
            text = norm(line["text"]).strip()
            if len(text) > AXIS_LABEL_MAX_CHARS or OPTION_RE.match(text) or ANSWER_TAG_RE.match(text):
                continue
            bbox = line["bbox"]
            if bbox[2] <= reach[0] or reach[2] <= bbox[0] or bbox[3] <= reach[1] or reach[3] <= bbox[1]:
                continue
            out = [min(out[0], bbox[0]), min(out[1], bbox[1]),
                   max(out[2], bbox[2]), max(out[3], bbox[3])]
    for line in lines:
        if not OPTION_RE.match(norm(line["text"]).strip()):
            continue
        top = line["bbox"][1]
        if out[1] < top < out[3]:
            out[3] = top - 4
    return [max(out[0], limit[0]), max(out[1], limit[1]),
            min(out[2], limit[2]), min(out[3], limit[3])]


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
    return [min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes)]


# --------------------------------------------------------------------------
# page-level reading
# --------------------------------------------------------------------------

def read_printed_page(page: dict[str, Any]) -> int | None:
    """The footer prints ``- 58 -``.  Read it rather than assuming an offset."""
    height, width = page["height"], page["width"]
    best: tuple[float, int] | None = None
    for line in page["ocr"]:
        x0, y0, x1, _ = line["bbox"]
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


def read_tier_banner(page: dict[str, Any]) -> tuple[str | None, str | None]:
    """Difficulty tier, only from the printed grey banner."""
    strip = [line for line in page.get("bannerOcr") or []
             if line["bbox"][0] <= 0.45 * page["width"]
             and line.get("backgroundLevel", 255) <= BANNER_BACKGROUND_MAX]
    for line in strip:
        text = norm(line["text"])
        for tier, printed, test in TIER_PATTERNS:
            if test(text):
                return tier, f"{printed}（OCR：{line['text']}）"
    for line in page["ocr"]:
        if line["bbox"][1] > 0.13 * page["height"] or line["bbox"][0] > 0.45 * page["width"]:
            continue
        text = norm(line["text"])
        for tier, printed, test in TIER_PATTERNS:
            if test(text):
                return tier, f"{printed}（OCR：{line['text']}）"
    return None, None


def has_banner_box(page: dict[str, Any]) -> bool:
    """A tier banner was printed here even if its text did not survive OCR.

    Two things separate it from ordinary text at the top of a page: it is
    reversed out of a grey block, and it sits flush in the top-left corner.
    Without the grey test a 解析 tag high on a continuation page opens a
    phantom drill block; without the geometry, highlighted body text does.
    """
    return any(line.get("backgroundLevel", 255) <= BANNER_BACKGROUND_MAX
               and line["bbox"][3] < 0.09 * page["height"]
               and line["bbox"][0] < 0.15 * page["width"]
               and 2 <= len(line["text"].strip()) <= 10
               for line in page.get("bannerOcr") or [])


def read_type_headers(page: dict[str, Any]) -> list[tuple[int, str, str]]:
    """``一、單一選擇題`` style headers: (y, questionType, printed evidence)."""
    out: list[tuple[int, str, str]] = []
    for line in page["ocr"]:
        x0, y0 = line["bbox"][0], line["bbox"][1]
        if x0 > 0.14 * page["width"]:
            continue
        text = norm(line["text"]).strip()
        if len(text) > 12 or len(text) < 3:
            continue
        matched = next((name for name, test in TYPE_PATTERNS if test(text)), None)
        if TYPE_HEADER_RE.match(text):
            out.append((y0, matched or "unclassified", line["text"]))
        elif matched and text.endswith("題"):
            # OCR drops the 一、 prefix often enough that requiring it lost the
            # 單一選擇題 and 多重選擇題 headers of a whole block, leaving its
            # questions typeless and unable to pair with their answers.
            out.append((y0, matched, line["text"]))
    return out


CHAPTER_TITLE_RE = re.compile(r"^[㐀-鿿][㐀-鿿（）()、·　 ]{2,19}$")


def collect_headings(page: dict[str, Any]) -> tuple[str | None, str | None]:
    """Centred large line near the top = chapter title; flush-left = sub-heading.

    A solution's centred display formula is also large and roughly centred, so
    the title must additionally sit in the top band and read as plain CJK —
    otherwise every 解析 page renamed the chapter to a fragment of algebra.
    """
    width, height = page["width"], page["height"]
    top_y = min((line["bbox"][1] for line in page["ocr"]), default=0)
    chapter: tuple[int, str] | None = None
    heading: tuple[int, str] | None = None
    for line in page["ocr"]:
        x0, y0, x1, y1 = line["bbox"]
        text = norm(line["text"]).strip()
        size = y1 - y0
        if len(text) < 3 or EXAMPLE_RE.search(text) or NUMBERED_ITEM_RE.match(text):
            continue
        centred = abs((x0 + x1) / 2 - width / 2) / width < 0.12
        if (size >= 32 and centred and y0 < 0.18 * height and y0 <= top_y + 8
                and CHAPTER_TITLE_RE.match(text)
                and (chapter is None or size > chapter[0])):
            chapter = (size, text)
        elif 24 <= size < 34 and x0 < 0.14 * width and (heading is None or y0 < heading[0]):
            heading = (y0, text)
    return (chapter[1] if chapter else None, heading[1] if heading else None)


def row_top(lines: list[dict[str, Any]], bbox: list[int]) -> int:
    """Top of the printed row that ``bbox`` belongs to."""
    y0, y1 = bbox[1], bbox[3]
    height = max(1, y1 - y0)
    top = y0
    for line in lines:
        other = line["bbox"]
        overlap = min(y1, other[3]) - max(y0, other[1])
        if overlap >= 0.5 * min(height, max(1, other[3] - other[1])):
            top = min(top, other[1])
    return top


def page_events(page: dict[str, Any], in_drill_block: bool) -> list[dict[str, Any]]:
    """Question starts and answer tags in reading order.

    A page interleaves them freely — a solution can finish at the top, a new
    example start halfway down and carry its own 解析 below.  Treating the
    first tag as a page-wide cut deleted everything under it, so the two kinds
    are collected as one ordered event stream instead.
    """
    width = page["width"]
    events: list[dict[str, Any]] = []
    for line in page["ocr"]:
        x0, y0 = line["bbox"][0], line["bbox"][1]
        text = norm(line["text"]).strip()

        if x0 <= 0.42 * width and ANSWER_ITEM_RE.match(text):
            events.append({"y": y0, "bbox": line["bbox"], "kind": "answer-item",
                           "number": int(ANSWER_ITEM_RE.match(text).group(1)), "text": text})
            continue
        if x0 <= 0.42 * width and ANSWER_TAG_RE.match(text):
            events.append({"y": y0, "bbox": line["bbox"], "kind": "answer-tag", "text": text})
            continue

        match = EXAMPLE_RE.search(text)
        if match and x0 < 0.30 * width:
            events.append({"y": y0, "bbox": line["bbox"], "kind": "question",
                           "marker": f"ex{int(match.group(1))}", "number": int(match.group(1)),
                           "origin": "example", "text": text})
            continue
        if in_drill_block and x0 < 0.16 * width:
            match = NUMBERED_ITEM_RE.match(text)
            if match and not OPTION_RE.match(text):
                events.append({"y": y0, "bbox": line["bbox"], "kind": "question",
                               "marker": f"q{int(match.group(1))}", "number": int(match.group(1)),
                               "origin": "numbered", "text": text})

    # A ruled 解答 / 解析 tag whose word OCR lost is still a hard boundary.
    # Losing it once left "解答 (1)(3)(5)" sitting inside a rendered question.
    tag_ys = [event["y"] for event in events if event["kind"] in {"answer-tag", "answer-item"}]
    for box in page["layout"]["labelBoxes"]:
        if box[0] > 0.30 * width:
            continue
        if any(abs(box[1] - y) <= 14 for y in tag_ys):
            continue
        events.append({"y": box[1], "bbox": box, "kind": "answer-tag", "text": "",
                       "source": "ruled-label-box"})

    # OCR splits one printed line into several boxes whose tops differ by a few
    # pixels, and the marker is not always the highest of them: on p69 the tail
    # of "3.（ ）點P…" sat 3 px above its own "3.（", so cutting at the marker
    # left that tail inside question 2's crop.  Cut at the row instead.
    for event in events:
        event["y"] = row_top(page["ocr"], event.get("bbox") or [0, event["y"], 0, event["y"] + 26])

    events.sort(key=lambda event: event["y"])
    return events


def classify_page(page: dict[str, Any], events: list[dict[str, Any]], in_drill_block: bool) -> str:
    answer_items = [event for event in events if event["kind"] == "answer-item"]
    questions = [event for event in events if event["kind"] == "question"]
    examples = [event for event in questions if event["origin"] == "example"]

    if answer_items and len(answer_items) >= len(examples):
        return "drill-answers"
    if examples:
        return "body"
    if in_drill_block and questions:
        return "drill"
    if len(page["ocr"]) < 4 or (len(page["ocr"]) <= 6 and not page["layout"]["frameBoxes"]):
        return "divider"
    if in_drill_block:
        # No question, no answer and barely any text: a cover or spacer that
        # happens to fall after a drill banner is not a drill page.
        return "drill" if len(page["ocr"]) >= 8 else "divider"
    return "body" if (page["layout"]["frameBoxes"] or len(page["ocr"]) > 6) else "unknown"


# --------------------------------------------------------------------------
# question segmentation
# --------------------------------------------------------------------------

def segment_questions(
    page: dict[str, Any],
    events: list[dict[str, Any]],
    context: dict[str, Any],
) -> tuple[list[dict[str, Any]], bool]:
    """Cut one page into question records.  Returns (records, lead_in_solution)."""
    width, height = page["width"], page["height"]
    footer_y = int(0.94 * height)
    lines = [line for line in page["ocr"] if line["bbox"][1] < footer_y]
    type_headers = context["typeHeaders"]

    starts = [event for event in events if event["kind"] == "question"]
    lead_in = bool(events) and events[0]["kind"] != "question"
    if not starts:
        return [], lead_in

    records: list[dict[str, Any]] = []
    for index, start in enumerate(starts):
        y_start = start["y"]
        following = [event for event in events if event["y"] > y_start]
        next_question = next((event["y"] for event in following if event["kind"] == "question"), None)
        next_tag = next((event["y"] for event in following
                         if event["kind"] in {"answer-tag", "answer-item"}), None)

        next_tag_event = next((event for event in following
                               if event["kind"] in {"answer-tag", "answer-item"}), None)
        if next_tag is not None and (next_question is None or next_tag < next_question):
            boundary = next_tag
            span_end = next_tag
            answer_end = next_question if next_question is not None else footer_y
        else:
            boundary = None
            span_end = next_question if next_question is not None else footer_y
            answer_end = None

        span_lines = [line for line in lines if y_start - 6 <= line["bbox"][1] < span_end]
        option_lines = [line for line in span_lines if OPTION_RE.match(norm(line["text"]).strip())]
        stem_lines = [line for line in span_lines if line not in option_lines]
        # A diagram whose ink bleeds a few pixels past the answer tag is clipped
        # to the boundary, never discarded: dropping it turned a figure question
        # into a figureless one, which is the failure mode that matters most.
        span_limit = [0, max(0, y_start - 8), width, span_end]
        printed_dark = page["layout"].get("printedDarkFraction") or 0.0
        region_dark = page["layout"].get("nonTextDarkFraction") or []
        figures = []
        annotated = 0
        clipped = 0
        for index, box in enumerate(page["layout"]["nonTextRegions"]):
            if not (y_start - 8 <= box[1] < span_end):
                continue
            dark = region_dark[index] if index < len(region_dark) else None
            if printed_dark and dark is not None and dark / printed_dark <= ANNOTATION_DARK_RATIO:
                annotated += 1
                continue
            grown = expand_figure_box(box, span_lines, span_limit)
            if grown[3] - grown[1] < 24 or grown[2] - grown[0] < 24:
                continue
            if grown[3] < box[3] - 4:
                clipped += 1
            figures.append(grown)

        stem_text = " ".join(norm(line["text"]) for line in stem_lines)
        option_text = [norm(line["text"]) for line in option_lines]
        exam_tag = PAST_EXAM_RE.search(stem_text)

        question_type, type_evidence = context["carriedType"]
        for header_y, name, printed in type_headers:
            if header_y <= y_start:
                question_type, type_evidence = name, printed
        if start["origin"] == "example":
            question_type, type_evidence = "worked-example", "printed-Ex-marker"

        tier = context["tier"] if context["section"] in {"drill", "drill-answers"} else None
        role = {
            "body": "example",
            "drill": f"chapter-end-{tier}" if tier else "chapter-end-unclassified",
        }.get(context["section"], "unclassified")

        flags: list[str] = []
        if boundary is None:
            flags.append("solution-not-on-this-page")
        if context["section"] == "drill" and tier is None:
            flags.append("tier-unknown")
        if annotated:
            flags.append("annotation-suspected-in-question")
        if clipped:
            flags.append("figure-clipped-at-answer-boundary")
        if DRAWING_TASK_RE.search(stem_text):
            flags.append("answer-is-a-drawing")
        elif VISUAL_REFERENCE_RE.search(stem_text) and not figures:
            flags.append("figure-referenced-but-missing")
        if ANSWER_TAG_ANYWHERE_RE.search(stem_text):
            flags.append("answer-text-inside-stem")
        if not stem_lines:
            flags.append("empty-stem")
        if question_type in {"single", "multi"} and not option_lines:
            flags.append("choice-question-without-options")
        if question_type == "unclassified" and context["section"] == "drill":
            flags.append("question-type-unknown")

        stem_box = bbox_union(line["bbox"] for line in stem_lines)
        option_box = bbox_union(line["bbox"] for line in option_lines)
        for box in [b for b in (stem_box, option_box) if b] + figures:
            if boundary is not None and box[3] > boundary:
                flags.append("region-crosses-answer-boundary")
                break

        records.append({
            "id": f"{context['slug']}-p{context['printedPage']:03d}-{start['marker']}",
            "bookId": context["bookId"],
            "pdfPage": page["pdfPage"],
            "printedPage": context["printedPage"],
            "section": context["section"],
            "chapter": context["chapter"],
            "blockIndex": context["blockIndex"],
            "role": role,
            "roleEvidence": "printed-Ex-marker" if start["origin"] == "example" else "printed-numbered-item",
            "questionType": question_type,
            "questionTypeEvidence": type_evidence,
            "sourceDifficulty": tier,
            "sourceDifficultyEvidence": context["tierEvidence"] or "none",
            "provenance": {"printedExamTag": exam_tag.group(0) if exam_tag else None,
                           "drillNumber": start["number"] if start["origin"] == "numbered" else None},
            "regions": {
                "stem": stem_box,
                "options": [line["bbox"] for line in option_lines],
                "figures": figures,
                "answerBoundaryY": boundary,
                "answerBoundarySource": (next_tag_event or {}).get("source", "ocr-tag") if boundary is not None else None,
                "inlineAnswer": [0, boundary, width, answer_end] if boundary is not None else None,
            },
            "ocrIndex": {"stem": stem_text.strip(), "options": option_text},
            "displayTruth": "original-pdf-crop",
            "status": "pending-review",
            "qaLane": "needs-repair" if flags else "clean-candidate",
            "flags": flags,
        })
    return records, lead_in


def collect_answer_items(page: dict[str, Any], events: list[dict[str, Any]],
                         context: dict[str, Any]) -> list[dict[str, Any]]:
    """Drill answers, kept in their own records so they cannot render as stems."""
    footer_y = int(0.94 * page["height"])
    items = [event for event in events if event["kind"] == "answer-item"]
    out: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        end = items[index + 1]["y"] if index + 1 < len(items) else footer_y
        block = [line for line in page["ocr"] if item["y"] - 4 <= line["bbox"][1] < end]
        question_type, type_evidence = context["carriedType"]
        for header_y, name, printed in context["typeHeaders"]:
            if header_y <= item["y"]:
                question_type, type_evidence = name, printed
        out.append({
            "id": f"{context['slug']}-p{context['printedPage']:03d}-ans{item['number']}",
            "bookId": context["bookId"],
            "pdfPage": page["pdfPage"],
            "printedPage": context["printedPage"],
            "chapter": context["chapter"],
            "blockIndex": context["blockIndex"],
            "sourceDifficulty": context["tier"],
            "sourceDifficultyEvidence": context["tierEvidence"] or "none",
            "questionType": question_type,
            "questionTypeEvidence": type_evidence,
            "drillNumber": item["number"],
            "region": bbox_union(line["bbox"] for line in block),
            "ocrIndex": " ".join(norm(line["text"]) for line in block)[:400],
            "status": "pending-review",
        })
    return out


# --------------------------------------------------------------------------
# book assembly
# --------------------------------------------------------------------------

def resolve_printed_pages(pages: list[dict[str, Any]]) -> dict[int, tuple[int, str]]:
    observed = {page["pdfPage"]: read_printed_page(page) for page in pages}
    offsets = Counter(printed - pdf for pdf, printed in observed.items() if printed is not None)
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

    pages = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(pages_dir.glob("p*.json"))]
    if not pages:
        raise MapError("Page index is empty")
    stale = sorted({page["pdfPage"] for page in pages if page.get("schema") != SCHEMA_VERSION})
    if stale:
        raise MapError(f"{len(stale)} page records are from an older index schema; re-run index-pages.py")
    pages.sort(key=lambda page: page["pdfPage"])

    slug = re.sub(r"^matha-\d+-", "", book_id)
    printed_map = resolve_printed_pages(pages)

    page_records: list[dict[str, Any]] = []
    questions: list[dict[str, Any]] = []
    answers: list[dict[str, Any]] = []
    chapter: str | None = None
    tier: str | None = None
    tier_evidence: str | None = None
    in_drill_block = False
    block_index = 0
    carried_type: tuple[str, str] = ("unclassified", "none")

    for page in pages:
        pdf_page = page["pdfPage"]
        printed_page, printed_source = printed_map[pdf_page]
        banner_tier, banner_evidence = read_tier_banner(page)
        page_chapter, heading = collect_headings(page)
        type_headers = read_type_headers(page)

        page_flags: list[str] = []
        if has_banner_box(page):
            # The grey banner is what starts a drill block.  When its text is
            # unreadable the tier stays unknown rather than inheriting the
            # previous block's — a carried-over tier is a guessed difficulty.
            tier, tier_evidence, in_drill_block = banner_tier, banner_evidence, True
            block_index += 1
            carried_type = ("unclassified", "none")
            if not banner_tier:
                page_flags.append("tier-banner-unreadable")
        elif page_chapter and not type_headers:
            # A fresh centred chapter title means the drill block is over.
            tier, tier_evidence, in_drill_block = None, None, False

        if page_chapter:
            chapter = page_chapter

        events = page_events(page, in_drill_block)
        section = classify_page(page, events, in_drill_block)
        if section == "body" and any(event["origin"] == "example"
                                     for event in events if event["kind"] == "question"):
            in_drill_block, tier, tier_evidence = False, None, None

        context = {
            "slug": slug, "bookId": book_id, "printedPage": printed_page, "chapter": chapter,
            "section": section, "tier": tier, "tierEvidence": tier_evidence,
            "typeHeaders": type_headers, "blockIndex": block_index,
            "carriedType": carried_type,
        }
        records, lead_in = segment_questions(page, events, context)
        if type_headers:
            carried_type = (type_headers[-1][1], type_headers[-1][2])
        questions.extend(records)
        if section == "drill-answers":
            answers.extend(collect_answer_items(page, events, context))

        if printed_source != "ocr":
            page_flags.append(f"printed-page-{printed_source}")
        if section == "unknown":
            page_flags.append("section-unresolved")

        page_records.append({
            "pdfPage": pdf_page,
            "printedPage": printed_page,
            "printedPageSource": printed_source,
            "section": section,
            "chapter": chapter,
            "heading": heading,
            "blockIndex": block_index if section in {"drill", "drill-answers"} else None,
            "tier": tier if section in {"drill", "drill-answers"} else None,
            "tierEvidence": tier_evidence if section in {"drill", "drill-answers"} else None,
            "questionTypeHeaders": [{"y": y, "type": name, "printed": printed}
                                    for y, name, printed in type_headers],
            "questionStarts": [event["marker"] for event in events if event["kind"] == "question"],
            "answerTagYs": [event["y"] for event in events if event["kind"] in {"answer-tag", "answer-item"}],
            "leadInSolution": lead_in,
            "ocrLineCount": len(page["ocr"]),
            "frameBoxCount": len(page["layout"]["frameBoxes"]),
            "figureCandidateCount": len(page["layout"]["nonTextRegions"]),
            "flags": page_flags,
        })

    link_cross_page_solutions(page_records, questions)
    pair_drill_answers(questions, answers)

    runs: list[dict[str, Any]] = []
    for record in page_records:
        key = (record["section"], record["tier"])
        if runs and runs[-1]["_key"] == key:
            runs[-1]["toPdfPage"] = record["pdfPage"]
            runs[-1]["pages"] += 1
        else:
            runs.append({"_key": key, "kind": record["section"], "tier": record["tier"],
                         "chapter": record["chapter"], "fromPdfPage": record["pdfPage"],
                         "toPdfPage": record["pdfPage"], "pages": 1})
    for run in runs:
        run.pop("_key")

    figures = build_figure_candidates(pages, questions, book_id)
    summary = json.loads((book_dir / "index-summary.json").read_text(encoding="utf-8"))

    section_map = {
        "schema": SCHEMA_VERSION, "kind": "textbook-section-map", "bookId": book_id,
        "pdfFileName": summary["pdfFileName"], "pdfSha256": summary["pdfSha256"],
        "pageCount": summary["pageCount"], "indexedPages": len(pages),
        "runs": runs, "pages": page_records,
    }
    question_pack = {
        "schema": SCHEMA_VERSION, "kind": "textbook-question-candidates", "bookId": book_id,
        "pdfSha256": summary["pdfSha256"], "displayTruth": "original-pdf-crop",
        "ocrIsIndexOnly": True, "allPendingReview": True,
        "questions": questions, "drillAnswers": answers,
    }
    figure_pack = {
        "schema": SCHEMA_VERSION, "kind": "textbook-figure-candidates", "bookId": book_id,
        "pdfSha256": summary["pdfSha256"],
        "privacy": {"localOnly": True, "fullPagesStudentUsable": False},
        "figures": figures,
    }

    (book_dir / "section-map.json").write_text(json.dumps(section_map, ensure_ascii=False, indent=1), encoding="utf-8")
    (book_dir / "questions.pending-review.json").write_text(json.dumps(question_pack, ensure_ascii=False, indent=1), encoding="utf-8")
    (book_dir / "figure-candidates.json").write_text(json.dumps(figure_pack, ensure_ascii=False, indent=1), encoding="utf-8")
    (book_dir / "qa-report.md").write_text(render_report(section_map, question_pack, figure_pack), encoding="utf-8")

    return {
        "bookId": book_id, "pages": len(pages), "runs": len(runs),
        "questions": len(questions), "drillAnswers": len(answers),
        "cleanCandidates": sum(1 for q in questions if q["qaLane"] == "clean-candidate"),
        "needsRepair": sum(1 for q in questions if q["qaLane"] == "needs-repair"),
        "figureQuestions": sum(1 for q in questions if q["regions"]["figures"]),
        "figures": len(figures),
    }


def link_cross_page_solutions(page_records: list[dict[str, Any]], questions: list[dict[str, Any]]) -> None:
    """A question whose solution starts on the next page is fine, not broken."""
    lead_in_by_page = {record["pdfPage"]: record["leadInSolution"] for record in page_records}
    last_on_page: dict[int, dict[str, Any]] = {}
    for question in questions:
        last_on_page[question["pdfPage"]] = question
    for pdf_page, question in last_on_page.items():
        if "solution-not-on-this-page" not in question["flags"]:
            continue
        if lead_in_by_page.get(pdf_page + 1):
            question["flags"] = [f for f in question["flags"] if f != "solution-not-on-this-page"]
            question["flags"].append("solution-continues-next-page")
            question["solutionPdfPage"] = pdf_page + 1
    for question in questions:
        question["qaLane"] = "needs-repair" if [
            flag for flag in question["flags"] if flag != "solution-continues-next-page"
        ] else "clean-candidate"


def pair_drill_answers(questions: list[dict[str, Any]], answers: list[dict[str, Any]]) -> None:
    """Match ``1.答案：（D）`` back to drill question 1 of the same block.

    Pairing is structural — by block sequence and tier — not by chapter text.
    OCR garbles the chapter name differently on a drill page and on its answer
    page (斜率兴直線方程 vs 斜率與直線方程式), so a text key would silently drop
    the link on exactly the pages that need it.
    """
    answer_blocks: dict[int, int] = {}
    by_block = lambda pair: (pair[0], pair[1] or "")
    question_blocks = sorted({(q["blockIndex"], q["sourceDifficulty"]) for q in questions
                              if q["provenance"]["drillNumber"] is not None}, key=by_block)
    taken: set[int] = set()
    for block, tier in sorted({(a["blockIndex"], a["sourceDifficulty"]) for a in answers}, key=by_block):
        candidates = [qb for qb, qt in question_blocks if qb < block and qt == tier and qb not in taken]
        if not candidates:
            continue
        answer_blocks[block] = max(candidates)
        taken.add(max(candidates))

    index: dict[tuple[Any, ...], dict[str, Any]] = {}
    for answer in answers:
        target = answer_blocks.get(answer["blockIndex"])
        if target is not None:
            index[(target, answer["questionType"], answer["drillNumber"])] = answer
    for question in questions:
        number = question["provenance"]["drillNumber"]
        if number is None:
            continue
        answer = index.get((question["blockIndex"], question["questionType"], number))
        if answer is None:
            question["flags"].append("drill-answer-not-found")
            question["qaLane"] = "needs-repair"
            continue
        question["answerRef"] = {"id": answer["id"], "pdfPage": answer["pdfPage"],
                                 "printedPage": answer["printedPage"], "region": answer["region"]}
        if "solution-not-on-this-page" in question["flags"]:
            question["flags"] = [f for f in question["flags"] if f != "solution-not-on-this-page"]
            question["qaLane"] = "needs-repair" if question["flags"] else "clean-candidate"


def build_figure_candidates(pages: list[dict[str, Any]], questions: list[dict[str, Any]],
                            book_id: str) -> list[dict[str, Any]]:
    dpi_by_page = {page["pdfPage"]: page["dpi"] for page in pages}
    figures: list[dict[str, Any]] = []
    for question in questions:
        boundary = question["regions"]["answerBoundaryY"]
        for order, box in enumerate(question["regions"]["figures"]):
            figures.append({
                "id": f"{question['id']}-fig{order + 1}",
                "questionId": question["id"], "bookId": book_id,
                "pdfPage": question["pdfPage"], "printedPage": question["printedPage"],
                "bboxReviewDpi": box, "reviewDpi": dpi_by_page[question["pdfPage"]],
                "aboveAnswerBoundary": boundary is None or box[3] <= boundary,
                "containsAnswerRegion": False,
                "handwritingSafety": "unknown",
                "verified": False, "studentUsable": False, "status": "pending-review",
            })
    return figures


def render_report(section_map: dict[str, Any], questions: dict[str, Any], figures: dict[str, Any]) -> str:
    rows = questions["questions"]
    flag_counts = Counter(flag for row in rows for flag in row["flags"])
    role_counts = Counter(row["role"] for row in rows)
    type_counts = Counter(row["questionType"] for row in rows)
    difficulty_counts = Counter(str(row["sourceDifficulty"]) for row in rows)
    with_figures = [row for row in rows if row["regions"]["figures"]]

    out = [
        f"# {section_map['bookId']} 逐頁 section map 與待審題目報告", "",
        f"- 來源 PDF：`{section_map['pdfFileName']}`",
        f"- PDF SHA-256：`{section_map['pdfSha256']}`",
        f"- 總頁數 {section_map['pageCount']}，已索引 {section_map['indexedPages']}",
        f"- 抽出候選題 {len(rows)}，其中含圖題 {len(with_figures)}；圖形候選 {len(figures['figures'])}",
        f"- 章末答案記錄 {len(questions['drillAnswers'])}",
        "- 全部記錄狀態為 `pending-review`；顯示真值為原檔裁切，OCR 只作索引。", "",
        "## 章節區段", "", "| 區段 | 難度層 | 章節 | PDF 頁 | 頁數 |", "|---|---|---|---|---:|",
    ]
    for run in section_map["runs"]:
        out.append(f"| {run['kind']} | {run['tier'] or '—'} | {run['chapter'] or '—'} "
                   f"| {run['fromPdfPage']}–{run['toPdfPage']} | {run['pages']} |")

    out += ["", "## role 分布（僅依印刷證據）", "", "| role | 題數 |", "|---|---:|"]
    out += [f"| {role} | {count} |" for role, count in role_counts.most_common()]

    out += ["", "## sourceDifficulty 分布", "", "| sourceDifficulty | 題數 |", "|---|---:|"]
    out += [f"| {value} | {count} |" for value, count in difficulty_counts.most_common()]

    out += ["", "## questionType 分布", "", "| questionType | 題數 |", "|---|---:|"]
    out += [f"| {value} | {count} |" for value, count in type_counts.most_common()]

    out += ["", "## QA 旗標（需人工處理）", "", "| flag | 題數 |", "|---|---:|"]
    out += [f"| {flag} | {count} |" for flag, count in flag_counts.most_common()] or ["| （無） | 0 |"]

    missing = [row for row in rows if "figure-referenced-but-missing" in row["flags"]]
    out += ["", "## 提到圖但沒抓到圖的題（不得省略，優先人工補圖）", "", f"共 {len(missing)} 題。", ""]
    out += [f"- `{row['id']}` 印刷頁 {row['printedPage']}：{row['ocrIndex']['stem'][:60]}" for row in missing[:40]]
    if len(missing) > 40:
        out.append(f"- …另有 {len(missing) - 40} 題見 `questions.pending-review.json`")

    flagged_pages = [page for page in section_map["pages"] if page["flags"]]
    out += ["", "## 有旗標的頁", "", f"共 {len(flagged_pages)} 頁。", ""]
    out += [f"- PDF {page['pdfPage']}（印刷 {page['printedPage']}）：{', '.join(page['flags'])}"
            for page in flagged_pages[:40]]
    if len(flagged_pages) > 40:
        out.append(f"- …另有 {len(flagged_pages) - 40} 頁見 `section-map.json`")
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
