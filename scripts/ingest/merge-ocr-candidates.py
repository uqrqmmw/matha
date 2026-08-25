#!/usr/bin/env python3
"""Merge independent OCR candidate maps without pretending either is truth.

Google Document AI and the local detector fail on different questions. The
hybrid review pack keeps the union. A question seen by only one detector is
retained but forced into ``needs-repair``; agreement is evidence, not approval.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


class MergeError(RuntimeError):
    pass


def merge_questions(local_pack: dict[str, Any], google_pack: dict[str, Any]) -> dict[str, Any]:
    if local_pack.get("bookId") != google_pack.get("bookId"):
        raise MergeError("Book IDs differ")
    if local_pack.get("pdfSha256") != google_pack.get("pdfSha256"):
        raise MergeError("Source PDF hashes differ")

    local = {row["id"]: row for row in local_pack.get("questions") or []}
    google = {row["id"]: row for row in google_pack.get("questions") or []}
    questions = []
    for question_id in sorted(set(local) | set(google),
                              key=lambda qid: ((google.get(qid) or local[qid])["pdfPage"], qid)):
        local_row, google_row = local.get(question_id), google.get(question_id)
        row = copy.deepcopy(google_row or local_row)
        sources = (["rapidocr"] if local_row else []) + (["googleDocumentAi"] if google_row else [])
        row["detectionSources"] = sources
        row["ocrIndexAlternates"] = {}
        if local_row:
            row["ocrIndexAlternates"]["rapidocr"] = local_row.get("ocrIndex")
        if google_row:
            row["ocrIndexAlternates"]["googleDocumentAi"] = google_row.get("ocrIndex")

        flags = set(local_row.get("flags") or []) if local_row else set()
        flags.update(google_row.get("flags") or [] if google_row else [])
        if len(sources) == 1:
            flags.add("single-ocr-detection")
        if local_row and google_row:
            for field in ("questionType", "role", "sourceDifficulty"):
                if local_row.get(field) != google_row.get(field):
                    flags.add(f"ocr-{field}-disagreement")
            local_answer = (local_row.get("answerRef") or {}).get("id")
            google_answer = (google_row.get("answerRef") or {}).get("id")
            if local_answer != google_answer:
                flags.add("answer-pair-disagreement")
        row["flags"] = sorted(flags)
        row["qaLane"] = "needs-repair" if flags else "clean-candidate"
        questions.append(row)

    local_answers = {row["id"]: row for row in local_pack.get("drillAnswers") or []}
    google_answers = {row["id"]: row for row in google_pack.get("drillAnswers") or []}
    answers = []
    for answer_id in sorted(set(local_answers) | set(google_answers),
                            key=lambda aid: ((google_answers.get(aid) or local_answers[aid])["pdfPage"], aid)):
        row = copy.deepcopy(google_answers.get(answer_id) or local_answers[answer_id])
        row["detectionSources"] = (["rapidocr"] if answer_id in local_answers else []) + (
            ["googleDocumentAi"] if answer_id in google_answers else [])
        answers.append(row)
    answer_ids = {row["id"] for row in answers}
    for row in questions:
        answer_id = (row.get("answerRef") or {}).get("id")
        if answer_id and answer_id not in answer_ids:
            row["flags"] = sorted(set(row["flags"]) | {"answer-ref-missing-after-merge"})
            row["qaLane"] = "needs-repair"

    return {
        "schema": google_pack.get("schema"),
        "kind": "textbook-question-candidates",
        "bookId": google_pack["bookId"],
        "pdfSha256": google_pack["pdfSha256"],
        "displayTruth": "original-pdf-crop",
        "ocrIsIndexOnly": True,
        "ocrProviderUsed": "rapidocr+google-document-ai",
        "allPendingReview": True,
        "questions": questions,
        "drillAnswers": answers,
        "missingDrillNumbers": google_pack.get("missingDrillNumbers") or [],
        "unattachedPageTops": google_pack.get("unattachedPageTops") or [],
    }


def report(pack: dict[str, Any]) -> str:
    questions = pack["questions"]
    sources = Counter("+".join(row["detectionSources"]) for row in questions)
    flags = Counter(flag for row in questions for flag in row.get("flags") or [])
    lines = [
        f"# {pack['bookId']} 雙 OCR 候選題 QA",
        "",
        f"- 候選題：{len(questions)}",
        f"- 雙方都偵測：{sources.get('rapidocr+googleDocumentAi', 0)}",
        f"- 只有 RapidOCR：{sources.get('rapidocr', 0)}",
        f"- 只有 Google Document AI：{sources.get('googleDocumentAi', 0)}",
        f"- clean-candidate：{sum(row['qaLane'] == 'clean-candidate' for row in questions)}",
        f"- needs-repair：{sum(row['qaLane'] == 'needs-repair' for row in questions)}",
        "",
        "## 旗標",
        "",
        "| flag | count |",
        "|---|---:|",
    ]
    lines.extend(f"| {name} | {count} |" for name, count in flags.most_common())
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", required=True, type=Path)
    parser.add_argument("--google", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args(argv)
    try:
        merged = merge_questions(
            json.loads(args.local.read_text(encoding="utf-8")),
            json.loads(args.google.read_text(encoding="utf-8")),
        )
        args.out.write_text(json.dumps(merged, ensure_ascii=False, indent=1), encoding="utf-8")
        if args.report:
            args.report.write_text(report(merged), encoding="utf-8")
        print(report(merged))
    except (MergeError, OSError, json.JSONDecodeError) as error:
        print(f"merge-ocr-candidates: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
