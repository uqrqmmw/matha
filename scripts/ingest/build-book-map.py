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

SCHEMA_VERSION = 11
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
# OCR reads the enumeration comma 、 as the ideograph 丶 often enough that a
# whole 五、作圖題 header went unrecognised and its section ran into the
# question above it.
TYPE_HEADER_RE = re.compile(r"^\s*([一二三四五六七八])\s*[、丶,，.．·]")
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


def footer_top(page: dict[str, Any]) -> int:
    """Where the page's own furniture starts.

    The printed page number is ink like any other, so a crop bounded by the
    ink profile ran all the way down to "- 173 -" with a hand's width of blank
    paper above it.  When the number is readable its own box is the bound.
    """
    height, width = page["height"], page["width"]
    for line in page["ocr"]:
        x0, y0, x1, _ = line["bbox"]
        if y0 < 0.90 * height:
            continue
        if PAGE_NUMBER_RE.match(line["text"].strip()) and abs((x0 + x1) / 2 - width / 2) / width <= 0.25:
            return max(0, y0 - 4)
    return int(0.94 * height)


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
    printed on a grey block, and it sits flush in the top-left corner.
    Without the grey test a 解析 tag high on a continuation page opens a
    phantom drill block; without the geometry, highlighted body text does.

    There is deliberately no upper bound on the text length.  One existed, and
    it cost the sequences book a whole answer block: OCR merged the tag with
    the chapter title into an eleven-character line, one over the cap, so a
    correctly measured banner was thrown away by a check that was doing no work
    the background level was not already doing.
    """
    return any(line.get("backgroundLevel", 255) <= BANNER_BACKGROUND_MAX
               and line["bbox"][3] < 0.09 * page["height"]
               and line["bbox"][0] < 0.15 * page["width"]
               and len(line["text"].strip()) >= 2
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


INK_ROW_MIN = 3
# A row of pencil carries real width but almost no solid ink.  Measured over
# six books: a page with a worked pencil solution has a run of 21-25 such rows,
# a clean page 1-2.  An earlier version tested for any ink at all past the
# printed content and flagged five sixths of every book, scan speckle included.
PENCIL_ROW_INK_MIN = 20
PENCIL_ROW_SOLID_MAX = 3
PENCIL_RUN_ROWS = 10
# Sub-parts of one stem: （1）… （2）….  Never question starts.
SUB_PART_RE = re.compile(r"^[（(]\s*[0-9１-９]\s*[）)]")
# The cross-page windows may use a wider margin than in-page recovery: the
# lost question's own text survives with its number sheared off, indented to
# x 93-150 where the strict margin never looks — "4.（ ）下列哪一個聯立不等式
# 無解？" came back as ")下列哪一個聯立不等式無解？" at x=135.  The width is
# safe there and only there because the window is already bounded by a proven
# missing number and a one-candidate requirement.
CROSS_PAGE_MARGIN_RATIO = 0.16
# Rows of one question sit 10-35 px apart; separate questions a hundred or
# more.  A gap beyond this ends the previous question's contiguous run.
CONTIGUOUS_ROW_GAP = 50


def pencil_run(page: dict[str, Any], top: int, bottom: int) -> int:
    """Longest run of rows that carry ink but no solid ink."""
    ink = page["layout"].get("inkRows") or []
    solid = page["layout"].get("solidRows") or []
    if not ink or not solid:
        return 0
    best = current = 0
    for y in range(max(0, top), min(bottom, len(ink), len(solid))):
        if ink[y] >= PENCIL_ROW_INK_MIN and solid[y] <= PENCIL_ROW_SOLID_MAX:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best


def ink_bounds(page: dict[str, Any], top: int, bottom: int) -> list[int] | None:
    """First and last row of *printed* ink between ``top`` and ``bottom``.

    Deliberately the solid-ink profile, not the total: a previous owner's
    pencil is ink too, and bounding a crop by it pulled a full worked solution
    into the question on printed page 160 of the trig book.
    """
    rows = page["layout"].get("solidRows") or page["layout"].get("inkRows") or []
    if not rows:
        return None
    lo, hi = max(0, top), min(len(rows), max(top + 1, bottom))
    inked = [y for y in range(lo, hi) if rows[y] >= INK_ROW_MIN]
    if not inked:
        return None
    return [0, inked[0], page["width"], inked[-1] + 1]


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

    events.sort(key=lambda event: event["y"])
    events.extend(recover_skipped_numbers(page, events, width))

    # OCR splits one printed line into several boxes whose tops differ by a few
    # pixels, and the marker is not always the highest of them: on p69 the tail
    # of "3.（ ）點P…" sat 3 px above its own "3.（", so cutting at the marker
    # left that tail inside question 2's crop.  Cut at the row instead.
    for event in events:
        event["y"] = row_top(page["ocr"], event.get("bbox") or [0, event["y"], 0, event["y"] + 26])

    events.sort(key=lambda event: event["y"])
    return events


def recover_skipped_numbers(page: dict[str, Any], events: list[dict[str, Any]],
                            width: int) -> list[dict[str, Any]]:
    """Re-open a question whose printed number OCR lost.

    OCR reads "7．（ ）" as "（）（）（））" often enough that 168 numbers across six
    books have no candidate — and the question above each one keeps it inside
    its own crop.  An earlier attempt scanned every left-margin line for
    candidates and produced 559 false splits, so this only looks where the
    printed numbering itself proves a question is missing: between two detected
    starts on the same page whose numbers skip.  One gap, one candidate, or
    nothing happens.
    """
    starts = [event for event in events
              if event["kind"] == "question" and event.get("number") is not None
              and event["origin"] == "numbered"]
    if len(starts) < 2:
        return []
    margin = min(event["bbox"][0] for event in starts) + 8
    claimed = [event["y"] for event in events]
    recovered: list[dict[str, Any]] = []

    for before, after in zip(starts, starts[1:]):
        gap = after["number"] - before["number"] - 1
        if gap < 1:
            continue
        candidates = []
        for line in page["ocr"]:
            x0, y0 = line["bbox"][0], line["bbox"][1]
            text = norm(line["text"]).strip()
            if not (before["y"] < y0 < after["y"]) or x0 > margin or not text:
                continue
            if OPTION_RE.match(text) or ANSWER_TAG_RE.match(text) or ANSWER_ITEM_RE.match(text):
                continue
            if any(abs(y0 - y) <= 20 for y in claimed):
                continue
            candidates.append(line)
        if len(candidates) != gap:
            continue
        for offset, line in enumerate(candidates):
            claimed.append(line["bbox"][1])
            recovered.append({
                "y": line["bbox"][1], "bbox": line["bbox"], "kind": "question",
                "marker": f"q{before['number'] + 1 + offset}",
                "number": before["number"] + 1 + offset,
                "origin": "numbered", "numberUnreadable": True, "text": line["text"],
            })
    return recovered


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
    footer_y = footer_top(page)
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
        # A 五、作圖題 header is a section boundary, so it ends the question
        # above it — otherwise the last question of a section keeps the next
        # section's heading, and the first line under it, inside its crop.
        next_header = min((header_y for header_y, _, _ in type_headers if header_y > y_start + 8),
                          default=None)
        if next_header is not None:
            next_question = next_header if next_question is None else min(next_question, next_header)

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

        # OCR line boxes hug the main text row, so a stacked fraction's
        # denominator falls outside them and got sliced off the crop; the same
        # boxes also say nothing about where the content stops, so crops ran on
        # into blank paper and the page footer.  The ink profile knows both.
        content_box = ink_bounds(page, max(0, y_start - 8), span_end)
        if pencil_run(page, max(0, y_start - 8), span_end) >= PENCIL_RUN_ROWS:
            annotated += 1

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
        if start.get("numberUnreadable"):
            flags.append("question-number-unreadable")
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
                "contentBox": content_box,
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
    page_state: dict[int, tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]] = {}
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
        page_state[pdf_page] = (page, events, context)
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
            "leadInRegion": ([0, 0, page["width"],
                              min([event["y"] for event in events if event["kind"] == "question"],
                                  default=int(0.94 * page["height"]))]
                             if lead_in else None),
            "ocrLineCount": len(page["ocr"]),
            "frameBoxCount": len(page["layout"]["frameBoxes"]),
            "figureCandidateCount": len(page["layout"]["nonTextRegions"]),
            "flags": page_flags,
        })

    recover_cross_page_gaps(questions, page_state)
    unattached_tops = collect_page_top_content(page_state)
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
        "missingDrillNumbers": missing_drill_numbers(questions),
        "unattachedPageTops": unattached_tops,
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
        "missingDrillNumbers": sum(len(gap["missingNumbers"]) for gap in question_pack["missingDrillNumbers"]),
    }


# A lost question shows up as a short skip in an otherwise contiguous run.  A
# jump of more than this is something else and is reported separately.
MAX_LOST_IN_A_ROW = 3


def missing_drill_numbers(questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Numbers the book prints that no candidate claims.

    OCR loses a printed question number outright — "7．（ ）" came back as
    "（）（）（））" — and then that question is simply absent while its neighbour's
    crop swallows it.  Guessing where those questions start produced far more
    false splits than recoveries, so this reports the gap instead: which block,
    which numbers, which pages to open.  It is an exact worklist, not an
    estimate.
    """
    runs: dict[tuple[Any, Any], dict[str, Any]] = {}

    for question in questions:
        number = question["provenance"]["drillNumber"]
        if number is None:
            continue
        key = (question["blockIndex"], question["questionType"])
        run = runs.setdefault(key, {"numbers": set(), "pages": set()})
        run["numbers"].add(number)
        run["pages"].add(question["pdfPage"])

    out: list[dict[str, Any]] = []
    for (block, qtype), run in sorted(runs.items(), key=lambda item: (item[0][0], str(item[0][1]))):
        numbers = sorted(run["numbers"])
        pages = sorted(run["pages"])
        gaps: list[int] = []
        jumps: list[list[int]] = []
        for lower, upper in zip(numbers, numbers[1:]):
            skipped = upper - lower - 1
            if 1 <= skipped <= MAX_LOST_IN_A_ROW:
                gaps.extend(range(lower + 1, upper))
            elif skipped > MAX_LOST_IN_A_ROW:
                # Not a lost question: a stray number from the question text
                # read as a start, or the section restarting.  Counting these
                # as losses put 14 phantom questions in one run of the data
                # book, so they are reported apart rather than folded in.
                jumps.append([lower, upper])
        if not gaps and not jumps:
            continue
        out.append({"blockIndex": block, "questionType": qtype, "missingNumbers": gaps,
                    "numberingJumps": jumps, "pdfPageRange": [pages[0], pages[-1]]})
    return out


def recover_cross_page_gaps(questions: list[dict[str, Any]],
                            page_state: dict[int, tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]]) -> int:
    """Recover a drill question that fell off the edge of a page.

    Half of the surviving losses — 45 of 91 — sit exactly on a page turn:
    question n-1 is the last detected start on one page, n+1 the first on the
    next, and the lost number's garbled line is at the bottom of the first
    page or the top of the second.  The in-page recovery never looked there.

    Same discipline as recover_skipped_numbers: the printed numbering must
    prove a question is missing, and exactly one unclaimed left-margin line
    may exist across both windows, or nothing happens.
    """
    def start_y(pdf_page: int, number: int) -> int | None:
        _, events, _ = page_state[pdf_page]
        for event in events:
            if event["kind"] == "question" and event.get("number") == number:
                return event["y"]
        return None

    pos: dict[tuple[Any, Any, int], dict[str, Any]] = {}
    runs: dict[tuple[Any, Any], set[int]] = {}
    for question in questions:
        number = question["provenance"]["drillNumber"]
        if number is None:
            continue
        pos[(question["blockIndex"], question["questionType"], number)] = question
        runs.setdefault((question["blockIndex"], question["questionType"]), set()).add(number)

    injections: dict[int, list[tuple[int, dict[str, Any]]]] = {}
    for (block, qtype), numbers in sorted(runs.items(), key=lambda item: (item[0][0], str(item[0][1]))):
        ordered = sorted(numbers)
        for lower, upper in zip(ordered, ordered[1:]):
            if upper - lower != 2:
                continue
            before = pos[(block, qtype, lower)]
            after = pos[(block, qtype, upper)]
            first, second = before["pdfPage"], after["pdfPage"]
            if second - first != 1 or first not in page_state or second not in page_state:
                continue
            low_edge, high_edge = start_y(first, lower), start_y(second, upper)
            if low_edge is None or high_edge is None:
                continue

            # Two passes.  The strict margin finds a garbled number line that
            # still sits where numbers sit, even when indented continuations
            # follow it.  Only when nothing lives at the margin does the wide
            # pass look for the question's sheared-off remnant at x 93-150.
            strict: list[tuple[int, dict[str, Any]]] = []
            wide: list[tuple[int, dict[str, Any]]] = []
            for pdf_page, above, below in ((first, low_edge, None), (second, None, high_edge)):
                page, events, context = page_state[pdf_page]
                if context["section"] != "drill":
                    continue
                if above is not None:
                    # On the first page the window opens below question n-1,
                    # whose own wrapped lines sit at the same indents as a lost
                    # question's remnant.  What separates them is layout: rows
                    # of one question run 10-35 px apart, questions are set a
                    # hundred or more apart.  So the window really starts at
                    # the first vertical break after n-1's start; without this,
                    # n-1's continuations made every bottom window ambiguous.
                    trailing = sorted((line["bbox"] for line in page["ocr"]
                                       if line["bbox"][1] > above), key=lambda box: box[1])
                    break_y = None
                    previous_bottom = None
                    for box in trailing:
                        if previous_bottom is not None and box[1] - previous_bottom > CONTIGUOUS_ROW_GAP:
                            break_y = box[1]
                            break
                        previous_bottom = max(previous_bottom or 0, box[3])
                    if break_y is None:
                        continue
                    # -11 keeps the break line itself inside the window past
                    # the +10 slack applied below.
                    above = break_y - 11
                starts = [event for event in events if event["kind"] == "question"]
                strict_margin = (min(event["bbox"][0] for event in starts) + 8) if starts else int(0.09 * page["width"])
                wide_margin = int(CROSS_PAGE_MARGIN_RATIO * page["width"])
                claimed = ([event["y"] for event in events]
                           + [line["bbox"][1] for _, line in injections.get(pdf_page, [])])
                for line in page["ocr"]:
                    x0, y0 = line["bbox"][0], line["bbox"][1]
                    text = norm(line["text"]).strip()
                    if x0 > wide_margin or not text:
                        continue
                    if above is not None and y0 <= above + 10:
                        continue
                    if below is not None and y0 >= below - 10:
                        continue
                    if OPTION_RE.match(text) or ANSWER_TAG_RE.match(text) or ANSWER_ITEM_RE.match(text):
                        continue
                    if SUB_PART_RE.match(text):
                        continue
                    if any(abs(y0 - y) <= 20 for y in claimed):
                        continue
                    wide.append((pdf_page, line))
                    if x0 <= strict_margin:
                        strict.append((pdf_page, line))
            if len(strict) == 1:
                pdf_page, line = strict[0]
            elif len(wide) == 1:
                pdf_page, line = wide[0]
            else:
                continue
            injections.setdefault(pdf_page, []).append((lower + 1, line))

    recovered = 0
    for pdf_page, found in injections.items():
        page, events, context = page_state[pdf_page]
        for number, line in found:
            events.append({"y": line["bbox"][1], "bbox": line["bbox"], "kind": "question",
                           "marker": f"q{number}", "number": number, "origin": "numbered",
                           "numberUnreadable": True, "text": line["text"]})
        events.sort(key=lambda event: event["y"])
        replacement, _ = segment_questions(page, events, context)
        questions[:] = [q for q in questions if q["pdfPage"] != pdf_page] + replacement
        recovered += len(found)
    return recovered


def collect_page_top_content(page_state: dict[int, tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]]) -> list[dict[str, Any]]:
    """Report drill-page tops whose content no question span covers.

    A drill question that wraps across a page turn leaves its tail above the
    next page's first detected start — on pdf 72 of the line book that region
    held the previous question's clause and all five options, silently
    dropped.  Three attempts to attach such regions to the previous question
    automatically all failed verification: this book's fraction-heavy first
    lines fragment upward past any gap threshold, so every heuristic ended up
    gluing a piece of the *next* question — once an entire question whose
    printed number OCR had lost — onto the wrong stem.  So this reports and
    never attaches: which page, how far down, for a human with the page open.
    """
    out: list[dict[str, Any]] = []
    for pdf_page in sorted(page_state):
        previous = pdf_page - 1
        if previous not in page_state:
            continue
        page, events, context = page_state[pdf_page]
        _, _, prev_context = page_state[previous]
        if context["section"] != "drill" or prev_context["section"] != "drill":
            continue
        if context["blockIndex"] != prev_context["blockIndex"]:
            continue  # a new block's page opens with its banner
        starts = [event for event in events if event["kind"] == "question"]
        if not starts:
            continue
        first_y = min(event["y"] for event in starts)
        cutoff = min([first_y] + [y for y, _, _ in context["typeHeaders"] if y < first_y])
        # Anything within arm's reach of the first question is its own tall
        # fraction or brace poking above the detected start row, and a sliver
        # of one says nothing.
        content = [line for line in page["ocr"] if line["bbox"][3] < cutoff - 40]
        if not content or sum(len(norm(line["text"]).strip()) for line in content) < 8:
            continue
        bottom = max(line["bbox"][3] for line in content)
        out.append({"pdfPage": pdf_page, "printedPage": context["printedPage"],
                    "region": [0, 0, page["width"], min(cutoff - 4, bottom + 6)]})
    return out


def link_cross_page_solutions(page_records: list[dict[str, Any]], questions: list[dict[str, Any]]) -> None:
    """A question whose solution starts on the next page is fine, not broken."""
    lead_in_by_page = {record["pdfPage"]: record["leadInSolution"] for record in page_records}
    lead_in_region = {record["pdfPage"]: record.get("leadInRegion") for record in page_records}
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
            # The solution is on the next page and the crop step needs to know
            # where it ends, or 300 questions across six books keep a page
            # number and no rendered answer for a reviewer to read.
            question["solutionRegion"] = lead_in_region.get(pdf_page + 1)
    handled = {"solution-continues-next-page"}
    for question in questions:
        question["qaLane"] = "needs-repair" if [
            flag for flag in question["flags"] if flag not in handled
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

    gaps = questions.get("missingDrillNumbers") or []
    lost = [gap for gap in gaps if gap["missingNumbers"]]
    jumped = [gap for gap in gaps if gap.get("numberingJumps")]
    out += ["", "## 印刷題號有、候選題沒有的（OCR 把題號讀丟，需人工翻頁補）", "",
            f"共 {sum(len(gap['missingNumbers']) for gap in lost)} 題，分布在 {len(lost)} 個區段。", "",
            "| 區塊 | 題型 | 缺號 | PDF 頁 |", "|---:|---|---|---|"]
    for gap in lost[:40]:
        out.append(f"| {gap['blockIndex']} | {gap['questionType']} "
                   f"| {', '.join(str(n) for n in gap['missingNumbers'])} "
                   f"| {gap['pdfPageRange'][0]}–{gap['pdfPageRange'][1]} |")
    out += ["", "## 題號不連續（多半是題文裡的數字被讀成題號，不是漏題）", "",
            f"共 {sum(len(gap['numberingJumps']) for gap in jumped)} 處。", "",
            "| 區塊 | 題型 | 跳號 | PDF 頁 |", "|---:|---|---|---|"]
    for gap in jumped[:25]:
        out.append(f"| {gap['blockIndex']} | {gap['questionType']} "
                   f"| {'; '.join(f'{a}→{b}' for a, b in gap['numberingJumps'])} "
                   f"| {gap['pdfPageRange'][0]}–{gap['pdfPageRange'][1]} |")

    tops = questions.get("unattachedPageTops") or []
    out += ["", "## 頁頂有內容但無法安全掛接的（可能是題號讀丟的整題，需人工看）", "",
            f"共 {len(tops)} 頁。", ""]
    out += [f"- PDF {top['pdfPage']}（印刷 {top['printedPage']}）y 0–{top['region'][3]}"
            for top in tops[:30]]

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
