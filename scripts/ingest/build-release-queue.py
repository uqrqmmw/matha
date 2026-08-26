#!/usr/bin/env python3
"""Build a small, deterministic visual-review queue from the OCR corpus.

The queue is not a question bank and never marks anything release-ready.  It
only chooses the next original-PDF stem/answer pairs worth reviewing.  This is
how 7,055 candidates become useful without transcribing or trusting all of
them up front: select across books, verify a small batch, publish that batch,
then let learner evidence decide which topic the next batch should cover.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 11
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ROLES = {"chapter-end-easy", "chapter-end-medium", "chapter-end-hard"}
ROLE_SCORE = {"chapter-end-hard": 300, "chapter-end-medium": 200,
              "chapter-end-easy": 100}
REVIEW_LADDER = ("chapter-end-medium", "chapter-end-hard", "chapter-end-easy")
SUPPORTED_SOURCE_TYPES = {"single", "multi", "fill", "calculation", "proof",
                          "mixed", "drawing", "group"}


class QueueError(RuntimeError):
    """A fail-closed queue construction error."""


def ensure_outside_repo(path: Path) -> None:
    try:
        path.resolve().relative_to(REPO_ROOT)
    except ValueError:
        return
    raise QueueError(f"Private review output must stay outside Git: {path.resolve()}")


def read_catalog(path: Path) -> dict[str, dict[str, Any]]:
    books: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        id_match = re.search(r"\bid:'([\w-]+)'", line)
        if not id_match:
            continue
        def field(name: str, default: str = "") -> str:
            match = re.search(rf"\b{name}:'([^']*)'", line)
            return match.group(1) if match else default
        topics_match = re.search(r"\btopics:\[([^\]]*)\]", line)
        topics = re.findall(r"'([^']+)'", topics_match.group(1)) if topics_match else []
        books[id_match.group(1)] = {
            "id": id_match.group(1), "title": field("title"), "kind": field("kind"),
            "eligibility": field("eligibility"), "topics": topics,
        }
    return books


def answer_leak_signal(question: dict[str, Any], answers: dict[str, dict[str, Any]]) -> str | None:
    """Catch obvious final answers handwritten after the printed question.

    This is intentionally conservative.  It does not prove a crop clean; it
    merely keeps known-bad candidates such as a standalone circled ``26`` out
    of the first review batch.  Visual review remains mandatory.
    """
    answer_id = (question.get("answerRef") or {}).get("id")
    answer_text = str((answers.get(str(answer_id)) or {}).get("ocrIndex") or "")
    stem = str((question.get("ocrIndex") or {}).get("stem") or "")
    if not answer_text or not stem:
        return None
    match = re.search(r"答案\s*[：:]\s*(.{1,80}?)(?=\s*(?:解析|解答|$))", answer_text)
    if not match:
        return None
    official = match.group(1)
    tokens = re.findall(r"(?<![\w])[-+]?\d+(?:\.\d+)?(?:/\d+)?|[A-E](?![\w])", official)
    tail = re.split(r"[？?]", stem)[-1].strip() if re.search(r"[？?]", stem) else ""
    if tail and any(re.fullmatch(rf"[\s$\\()（）圈條個約=]*{re.escape(token)}[\s$\\()（）圈條個約=]*", tail)
                    for token in tokens):
        return f"official-answer-token-after-question:{tail[:30]}"
    # A filled answer box is often OCRed as part of the printed sentence.  A
    # complete LaTeX answer repeated near the end is a strong leak signal even
    # when the sentence ends with 。 instead of a question mark.
    compact_stem = re.sub(r"\s+|\\(?:left|right)", "", stem)
    for formula in re.findall(r"\$([^$]+)\$", official):
        compact_formula = re.sub(r"\s+|\\(?:left|right)", "", formula)
        position = compact_stem.rfind(compact_formula)
        if len(compact_formula) >= 4 and position >= len(compact_stem) // 2:
            return "official-formula-inside-answer-area"
    return None


def candidate_from(question: dict[str, Any], book: dict[str, Any],
                   answers: dict[str, dict[str, Any]]) -> tuple[dict[str, Any] | None, str | None]:
    if question.get("qaLane") != "clean-candidate" or question.get("flags"):
        return None, "qa-flags-or-repair"
    if question.get("role") not in ROLES:
        return None, "not-chapter-end-tier"
    if not question.get("answerRef") and not question.get("solutionRegion"):
        return None, "answer-crop-missing"
    if question.get("questionType") not in SUPPORTED_SOURCE_TYPES:
        return None, "question-type-needs-repair"
    leak = answer_leak_signal(question, answers)
    if leak:
        return None, "answer-leak-suspected"

    qid = str(question["id"])
    figure_count = len((question.get("regions") or {}).get("figures") or [])
    role = str(question["role"])
    source_type = str(question["questionType"])
    suggested_type = source_type if source_type in {"single", "multi", "fill"} else "fill"
    score = ROLE_SCORE[role] + min(figure_count, 2) * 25
    if source_type in {"single", "multi", "fill"}:
        score += 10
    return {
        "id": qid,
        "bookId": question["bookId"],
        "bookTitle": book.get("title") or question["bookId"],
        "pdfPage": question["pdfPage"],
        "printedPage": question.get("printedPage"),
        "role": role,
        "sourceDifficulty": question.get("sourceDifficulty"),
        "sourceDifficultyEvidence": question.get("sourceDifficultyEvidence"),
        "sourceQuestionType": source_type,
        "suggestedType": suggested_type,
        "topicChoices": book.get("topics") or [],
        "figureCount": figure_count,
        "stemCrop": f"{question['bookId']}/crops/{qid}/stem.png",
        "answerCrop": f"{question['bookId']}/crops/{qid}/answer.png",
        "priorityScore": score,
        "review": {
            "decision": "",
            "topic": "",
            "type": suggested_type,
            "optionCount": None,
            "ans": [],
            "answerVerified": False,
            "cropReview": {
                "fullStem": False, "allOptions": False,
                "containsAnswer": None, "containsSolution": None,
                "containsHandwriting": None, "containsAdjacentQuestion": None,
            },
        },
    }, None


def round_robin(candidates: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in candidates:
        grouped[row["bookId"]].append(row)
    for book_id, rows in grouped.items():
        buckets = {role: [] for role in REVIEW_LADDER}
        for row in rows:
            buckets.setdefault(row.get("role"), []).append(row)
        for bucket in buckets.values():
            bucket.sort(key=lambda row: (-row["figureCount"], row["pdfPage"], row["id"]))
        balanced = []
        while any(buckets.get(role) for role in REVIEW_LADDER):
            for role in REVIEW_LADDER:
                if buckets.get(role):
                    balanced.append(buckets[role].pop(0))
        grouped[book_id] = balanced
    output: list[dict[str, Any]] = []
    book_ids = sorted(grouped)
    while len(output) < limit:
        progressed = False
        for book_id in book_ids:
            if grouped[book_id] and len(output) < limit:
                output.append(grouped[book_id].pop(0))
                progressed = True
        if not progressed:
            break
    return output


def read_exclusions(path: Path | None) -> set[str]:
    if path is None or not path.is_file():
        return set()
    document = json.loads(path.read_text(encoding="utf-8"))
    rows = document.get("questions", []) if isinstance(document, dict) else []
    return {str(row.get("id")) for row in rows if isinstance(row, dict) and row.get("id")}


def build(work: Path, catalog_path: Path, limit: int,
          exclusions_path: Path | None = None) -> dict[str, Any]:
    if limit < 1:
        raise QueueError("limit must be positive")
    catalog = read_catalog(catalog_path)
    candidates: list[dict[str, Any]] = []
    excluded = Counter()
    manual_exclusions = read_exclusions(exclusions_path)
    source_questions = 0
    eligible_books = {book_id for book_id, book in catalog.items()
                      if book.get("kind") == "chapter" and book.get("eligibility") == "core"}
    for book_id in sorted(eligible_books):
        path = work / book_id / "questions.pending-review.json"
        if not path.is_file():
            excluded["book-pack-missing"] += 1
            continue
        pack = json.loads(path.read_text(encoding="utf-8"))
        if pack.get("schema") != SCHEMA_VERSION or pack.get("bookId") != book_id:
            raise QueueError(f"Untrusted or stale candidate pack: {path}")
        answers = {str(row.get("id")): row for row in pack.get("drillAnswers", [])}
        for question in pack.get("questions", []):
            source_questions += 1
            if str(question.get("id")) in manual_exclusions:
                excluded["manual-visual-review-reject"] += 1
                continue
            row, reason = candidate_from(question, catalog[book_id], answers)
            if row:
                candidates.append(row)
            else:
                excluded[str(reason)] += 1
    selected = round_robin(candidates, min(limit, len(candidates)))
    return {
        "schema": 1,
        "kind": "textbook-on-demand-release-review-queue",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "workRoot": str(work.resolve()),
        "studentReady": False,
        "automaticPublicationAllowed": False,
        "displayTruthRequired": "independently-reviewed-original-pdf-crop",
        "sourceQuestions": source_questions,
        "eligibleAfterStructuralFilters": len(candidates),
        "selectedForThisBatch": len(selected),
        "manualExclusionsApplied": len(manual_exclusions),
        "excluded": dict(sorted(excluded.items())),
        "workflow": [
            "review original stem crop for completeness and answer/solution/handwriting leakage",
            "review original answer crop and enter exact answer metadata",
            "apply-review imageFirst mode; never promote ocrIndex to q",
            "independent stem review with exact PDF pixel/hash verification",
            "upload private stem assets and build release manifest",
            "let learner evidence choose topics for the next small batch",
        ],
        "items": selected,
    }


def write(queue: dict[str, Any], output: Path) -> None:
    ensure_outside_repo(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(queue, ensure_ascii=False, indent=1), encoding="utf-8")
    report = output.with_suffix(".md")
    lines = [
        "# 教材按需發布複核佇列", "",
        f"- 原候選：{queue['sourceQuestions']}",
        f"- 通過結構初篩：{queue['eligibleAfterStructuralFilters']}",
        f"- 本批待視覺複核：{queue['selectedForThisBatch']}",
        "- 正式可用：0（本檔只是工作佇列，不能發布）", "",
        "## 被初篩擋下", "",
    ]
    lines.extend(f"- {reason}: {count}" for reason, count in queue["excluded"].items())
    lines += ["", "## 原則", "", "題面一律顯示原 PDF 裁圖；OCR 只供檢索與切段。每批通過兩次影像複核後才可進私有題庫。", ""]
    report.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, default=REPO_ROOT / "textbook-catalog.js")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=42)
    parser.add_argument("--exclusions", type=Path)
    args = parser.parse_args()
    try:
        exclusions = args.exclusions or args.work / "release-queue" / "review-exclusions.json"
        queue = build(args.work, args.catalog, args.limit, exclusions)
        write(queue, args.out)
        print(json.dumps({key: queue[key] for key in ("sourceQuestions", "eligibleAfterStructuralFilters", "selectedForThisBatch")}, ensure_ascii=False))
    except (OSError, ValueError, QueueError) as error:
        print(f"build-release-queue: {error}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
