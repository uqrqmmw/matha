#!/usr/bin/env python3
"""Roll every indexed book up into one status file.

Fourteen books go through this pipeline one at a time over many sessions, so
the question "where did we get to, and what is waiting on a human" needs an
answer that does not require opening fourteen reports.  Counts and flag names
only — no question text, no crops.

    python scripts/ingest/ingest-status.py --work "<work>" [--out <file.md>]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def read_book(book_dir: Path) -> dict[str, Any] | None:
    section_map = book_dir / "section-map.json"
    questions = book_dir / "questions.pending-review.json"
    if not section_map.is_file() or not questions.is_file():
        return None
    mapping = json.loads(section_map.read_text(encoding="utf-8"))
    pack = json.loads(questions.read_text(encoding="utf-8"))
    rows = pack["questions"]
    tiers = Counter(str(row["sourceDifficulty"]) for row in rows)
    return {
        "bookId": mapping["bookId"],
        "pdfFileName": mapping["pdfFileName"],
        "pdfSha256": mapping["pdfSha256"],
        "pageCount": mapping["pageCount"],
        "indexedPages": mapping["indexedPages"],
        "questions": len(rows),
        "drillAnswers": len(pack.get("drillAnswers", [])),
        "figureQuestions": sum(1 for row in rows if row["regions"]["figures"]),
        "cleanCandidates": sum(1 for row in rows if row["qaLane"] == "clean-candidate"),
        "needsRepair": sum(1 for row in rows if row["qaLane"] == "needs-repair"),
        "tiers": tiers,
        "flags": Counter(flag for row in rows for flag in row["flags"]),
        "cropsRendered": sum(1 for row in rows if row.get("cropStemRegion")),
        "notPendingReview": sum(1 for row in rows if row["status"] != "pending-review"),
    }


def render(books: list[dict[str, Any]], work_root: Path) -> str:
    total_flags: Counter[str] = Counter()
    for book in books:
        total_flags.update(book["flags"])

    out = [
        "# 掃描教材匯入狀態", "",
        f"- 工作目錄（repo 外）：`{work_root}`",
        f"- 已建立 section map 的教材：{len(books)} 本",
        f"- 候選題合計：{sum(b['questions'] for b in books)}，其中含圖題 "
        f"{sum(b['figureQuestions'] for b in books)}",
        f"- 章末答案記錄合計：{sum(b['drillAnswers'] for b in books)}",
        f"- 待人工複核（clean-candidate / needs-repair）："
        f"{sum(b['cleanCandidates'] for b in books)} / {sum(b['needsRepair'] for b in books)}",
        "- 全部記錄狀態為 `pending-review`；沒有任何一題進入正式題庫。", "",
        "## 各書", "",
        "| bookId | 頁數 | 已索引 | 候選題 | 含圖題 | easy/medium/hard/null | clean | repair | 已裁切 |",
        "|---|---:|---:|---:|---:|---|---:|---:|---:|",
    ]
    for book in books:
        tiers = book["tiers"]
        ladder = "/".join(str(tiers.get(key, 0)) for key in ("easy", "medium", "hard", "None"))
        out.append(
            f"| `{book['bookId']}` | {book['pageCount']} | {book['indexedPages']} "
            f"| {book['questions']} | {book['figureQuestions']} | {ladder} "
            f"| {book['cleanCandidates']} | {book['needsRepair']} | {book['cropsRendered']} |"
        )

    out += ["", "## 待人工處理的旗標（全書合計）", "", "| flag | 題數 |", "|---|---:|"]
    out += [f"| {flag} | {count} |" for flag, count in total_flags.most_common()] or ["| （無） | 0 |"]

    leaked = sum(book["notPendingReview"] for book in books)
    out += [
        "", "## 不變條件檢查", "",
        f"- 非 `pending-review` 的記錄：{leaked}（必須為 0）",
        f"- 來源 PDF SHA-256 已記錄：{sum(1 for b in books if b['pdfSha256'])} / {len(books)}",
        "", "## 來源檔雜湊", "", "| bookId | 檔名 | SHA-256 |", "|---|---|---|",
    ]
    out += [f"| `{b['bookId']}` | {b['pdfFileName']} | `{b['pdfSha256']}` |" for b in books]
    return "\n".join(out) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)

    if not args.work.is_dir():
        print(f"ingest-status: no work directory at {args.work}", file=sys.stderr)
        return 2
    books = [book for book in (read_book(path) for path in sorted(args.work.iterdir()) if path.is_dir())
             if book]
    if not books:
        print("ingest-status: no book has a section map yet", file=sys.stderr)
        return 2

    report = render(books, args.work)
    destination = args.out or (args.work / "INGEST_STATUS.md")
    destination.write_text(report, encoding="utf-8")
    print(f"wrote {destination}  ({len(books)} books)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
