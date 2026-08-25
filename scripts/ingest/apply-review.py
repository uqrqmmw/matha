#!/usr/bin/env python3
"""Turn reviewed candidates into a qpack ``build-private-bank.js`` will accept.

This is the only door out of the review-only side of the pipeline, and it is
deliberately narrow.

* Nothing ships without an explicit ``"decision": "approve"``.  A missing or
  unrecognised decision is a refusal, not a default.
* The question text comes from the reviewer, never from ``ocrIndex``.  The OCR
  in this pipeline is a search key; it garbles 選擇 into 遥挥 and drops signs
  out of formulas, so copying it into ``q`` would ship wrong mathematics that
  looks plausible.
* A record still carrying QA flags needs those exact flags listed in
  ``acceptedFlags``, so a reviewer cannot wave a repair item through by
  accident.
* Difficulty comes from the printed tier when the book printed one.  Otherwise
  the reviewer must supply ``diff`` *and* say what it is based on.
* Figure questions leave with ``needsFigure: true`` and no ``figureAsset``.
  The app quarantines those until a crop has been through the existing
  independent review, which is what keeps a figure question from shipping as
  text with its diagram silently missing.

    python scripts/ingest/apply-review.py --work "<work>" --book <bookId> --template
    python scripts/ingest/apply-review.py --work "<work>" --book <bookId> \
        --decisions "<work>/<bookId>/review-decisions.json" --out "<outside-repo>/qpack.json"
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 9
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Mirrors scripts/build-private-bank.js — a record rejected there would only
# fail much later, after someone had already spent the review time.
TOPICS = {"num", "line", "poly", "seq", "comb", "prob", "data",
          "trig1", "trig2", "exp", "vec", "svec", "splane", "mat"}
TYPES = {"single", "multi", "fill"}
ROLES = {"example", "chapter-end-easy", "chapter-end-medium", "chapter-end-hard",
         "comprehensive-review", "unclassified"}
TIER_TO_DIFF = {"easy": 1, "medium": 2, "hard": 3}
ID_RE = re.compile(r"^[\w.:-]+$")


class ReviewError(RuntimeError):
    """A fail-closed validation error."""


def ensure_outside_repo(path: Path) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return
    raise ReviewError(f"Scan-derived output must stay outside the Git repository: {resolved}")


def load_pack(work_root: Path, book_id: str) -> dict[str, Any]:
    path = work_root / book_id / "questions.pending-review.json"
    if not path.is_file():
        raise ReviewError(f"No question pack at {path}; run build-book-map.py first")
    pack = json.loads(path.read_text(encoding="utf-8"))
    if pack.get("schema") != SCHEMA_VERSION:
        raise ReviewError("Question pack is from an older schema; re-run build-book-map.py")
    return pack


def write_template(work_root: Path, book_id: str, pack: dict[str, Any]) -> Path:
    entries = []
    for question in pack["questions"]:
        entries.append({
            "id": question["id"],
            "decision": "",
            "printedPage": question["printedPage"],
            "role": question["role"],
            "questionType": question["questionType"],
            "sourceDifficulty": question["sourceDifficulty"],
            "flags": question["flags"],
            "crop": f"crops/{question['id']}/stem.png",
            "ocrIndexForSearchOnly": question["ocrIndex"]["stem"][:120],
            "topic": "",
            "type": "",
            "q": "",
            "opts": [],
            "ans": [],
            "diff": None,
            "diffEvidence": "",
            "acceptedFlags": [],
            "notes": "",
        })
    template = {
        "schema": SCHEMA_VERSION,
        "kind": "textbook-review-decisions",
        "bookId": book_id,
        "pdfSha256": pack["pdfSha256"],
        "howToUse": (
            "decision 填 approve/reject/repair。approve 的題必須自行填寫 q（不可貼 ocrIndex）、"
            "type、topic；選擇題填 opts 與 ans（0 起算的索引），填充題 ans 填字串。"
            "帶旗標的題要把接受的旗標列進 acceptedFlags。"
        ),
        "decisions": entries,
    }
    path = work_root / book_id / "review-decisions.template.json"
    path.write_text(json.dumps(template, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def book_topic(pack: dict[str, Any], catalog: dict[str, Any], book_id: str) -> str | None:
    book = next((item for item in catalog.get("books", []) if item.get("id") == book_id), None)
    topics = (book or {}).get("topics") or []
    return topics[0] if len(topics) == 1 and topics[0] in TOPICS else None


def read_catalog(path: Path) -> dict[str, Any]:
    """The catalog is a JS file; read the one object literal it exports."""
    text = path.read_text(encoding="utf-8")
    books = []
    for match in re.finditer(r"\{\s*id:'([\w-]+)'.*?topics:\[([^\]]*)\].*?\}", text):
        topics = [value.strip().strip("'\"") for value in match.group(2).split(",") if value.strip()]
        books.append({"id": match.group(1), "topics": topics})
    return {"books": books}


def convert(question: dict[str, Any], decision: dict[str, Any], default_topic: str | None) -> dict[str, Any]:
    qid = question["id"]
    if decision.get("decision") != "approve":
        raise ReviewError(f"{qid}: decision is {decision.get('decision')!r}, not approve")

    outstanding = [flag for flag in question["flags"] if flag not in (decision.get("acceptedFlags") or [])]
    if outstanding:
        raise ReviewError(f"{qid}: flags not accepted by the reviewer: {', '.join(outstanding)}")

    text = str(decision.get("q") or "").strip()
    if not text:
        raise ReviewError(f"{qid}: approved without reviewer-supplied question text")
    if text == question["ocrIndex"]["stem"].strip():
        raise ReviewError(f"{qid}: question text is the raw OCR index, which is not display truth")

    topic = str(decision.get("topic") or default_topic or "").strip()
    if topic not in TOPICS:
        raise ReviewError(f"{qid}: topic {topic!r} is not one of the 14 units")

    qtype = str(decision.get("type") or "").strip()
    if qtype not in TYPES:
        raise ReviewError(f"{qid}: type {qtype!r} is not single/multi/fill")

    tier = question["sourceDifficulty"]
    if tier in TIER_TO_DIFF:
        diff, evidence = TIER_TO_DIFF[tier], question["sourceDifficultyEvidence"]
    else:
        diff = decision.get("diff")
        evidence = str(decision.get("diffEvidence") or "").strip()
        if diff not in (1, 2, 3) or not evidence:
            raise ReviewError(f"{qid}: the book printed no tier, so diff and diffEvidence are required")

    record: dict[str, Any] = {
        "id": qid,
        "topic": topic,
        "type": qtype,
        "diff": diff,
        "diffEvidence": evidence,
        "q": text,
        "bookId": question["bookId"],
        "page": question["pdfPage"],
        "printedPage": question["printedPage"],
        "role": question["role"] if question["role"] in ROLES else "unclassified",
        "src": f"{question['bookId']} p{question['printedPage']}",
    }
    if not ID_RE.match(qid):
        raise ReviewError(f"{qid}: id has characters the private bank rejects")

    if qtype == "fill":
        answers = decision.get("ans") or []
        if not answers or any(not isinstance(value, (str, int, float)) for value in answers):
            raise ReviewError(f"{qid}: a fill question needs at least one string answer")
        record["ans"] = [str(value) for value in answers]
    else:
        options = decision.get("opts") or []
        answers = decision.get("ans") or []
        if len(options) < 2:
            raise ReviewError(f"{qid}: a choice question needs at least two options")
        if not answers or any(not isinstance(value, int) or not 0 <= value < len(options) for value in answers):
            raise ReviewError(f"{qid}: answers must be 0-based indexes into opts")
        if qtype == "single" and len(answers) != 1:
            raise ReviewError(f"{qid}: a single-choice question needs exactly one answer")
        record["opts"] = [str(value) for value in options]
        record["ans"] = list(answers)

    if question["regions"]["figures"] or "answer-is-a-drawing" in question["flags"]:
        # No figureAsset here on purpose: the app quarantines needsFigure until
        # a crop has passed the existing independent figure review.
        record["needsFigure"] = True
    return record


def apply(work_root: Path, book_id: str, decisions_file: Path, out_file: Path,
          catalog_file: Path) -> dict[str, Any]:
    ensure_outside_repo(work_root)
    ensure_outside_repo(out_file)
    pack = load_pack(work_root, book_id)
    decisions_doc = json.loads(decisions_file.read_text(encoding="utf-8"))
    if decisions_doc.get("kind") != "textbook-review-decisions":
        raise ReviewError("Expected a textbook-review-decisions file")
    if decisions_doc.get("pdfSha256") != pack["pdfSha256"]:
        raise ReviewError("Decisions were made against a different source PDF")

    default_topic = book_topic(pack, read_catalog(catalog_file), book_id)
    by_id = {question["id"]: question for question in pack["questions"]}
    approved: list[dict[str, Any]] = []
    refused: list[dict[str, str]] = []
    skipped = 0

    for decision in decisions_doc.get("decisions", []):
        question = by_id.get(decision.get("id"))
        if question is None:
            refused.append({"id": str(decision.get("id")), "reason": "no such candidate in this book"})
            continue
        if decision.get("decision") != "approve":
            skipped += 1
            continue
        try:
            approved.append(convert(question, decision, default_topic))
        except ReviewError as error:
            refused.append({"id": question["id"], "reason": str(error)})

    qpack = {
        "schema": 1,
        "kind": "private-question-source",
        "bookId": book_id,
        "pdfSha256": pack["pdfSha256"],
        "reviewedBy": decisions_doc.get("reviewer") or "unnamed-reviewer",
        "questions": approved,
    }
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(json.dumps(qpack, ensure_ascii=False, indent=1), encoding="utf-8")

    return {
        "bookId": book_id,
        "candidates": len(pack["questions"]),
        "approved": len(approved),
        "notApproved": skipped,
        "refused": refused,
        "output": str(out_file),
        "needsFigure": sum(1 for record in approved if record.get("needsFigure")),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--template", action="store_true", help="write a blank decisions file and stop")
    parser.add_argument("--decisions", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--catalog", type=Path, default=REPO_ROOT / "textbook-catalog.js")
    args = parser.parse_args(argv)

    try:
        if args.template:
            path = write_template(args.work, args.book, load_pack(args.work, args.book))
            print(json.dumps({"template": str(path)}, ensure_ascii=False, indent=2))
            return 0
        if not args.decisions or not args.out:
            raise ReviewError("--decisions and --out are required unless --template is given")
        result = apply(args.work, args.book, args.decisions, args.out, args.catalog)
    except ReviewError as error:
        print(f"apply-review: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
