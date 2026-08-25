#!/usr/bin/env python3
"""Merge vision-transcribed drafts into a book's review-decisions file.

The drafts carry everything a reviewer would otherwise type — stem text read
from the verified crop, options, the printed answer — but ``decision`` stays
empty on every entry.  Approval is the one thing this pipeline never fills
in for a human: flipping ``decision`` to ``approve`` is the reviewer's
signature, and ``apply-review.py`` emits nothing without it.

    python scripts/ingest/merge-drafts.py --work "<work>" --book <bookId> \
        --drafts "<work>/<bookId>/drafts/batch-*.json"

Draft entry shape (one object per question id):
    {"id": ..., "q": "...", "type": "single|multi|fill", "opts": [...],
     "ans": [...], "topic": "...", "notes": "...", "confidence": "high|check"}
"""

from __future__ import annotations

import argparse
import glob
import json
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 11
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DRAFTER = "claude-fable-vision-draft"


class MergeError(RuntimeError):
    """A fail-closed validation error."""


def ensure_outside_repo(path: Path) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return
    raise MergeError(f"Scan-derived output must stay outside the Git repository: {resolved}")


def merge(work_root: Path, book_id: str, drafts_glob: str) -> dict[str, Any]:
    ensure_outside_repo(work_root)
    book_dir = work_root / book_id
    pack = json.loads((book_dir / "questions.pending-review.json").read_text(encoding="utf-8"))
    if pack.get("schema") != SCHEMA_VERSION:
        raise MergeError("Question pack is from an older schema; re-run build-book-map.py")
    by_id = {question["id"]: question for question in pack["questions"]}

    drafts: dict[str, dict[str, Any]] = {}
    for path in sorted(glob.glob(drafts_glob)):
        ensure_outside_repo(Path(path))
        batch = json.loads(Path(path).read_text(encoding="utf-8"))
        for entry in batch.get("entries", []):
            qid = entry.get("id")
            if qid not in by_id:
                raise MergeError(f"draft {path}: no candidate {qid!r} in this book")
            drafts[qid] = entry

    decisions_path = book_dir / "review-decisions.json"
    if decisions_path.is_file():
        document = json.loads(decisions_path.read_text(encoding="utf-8"))
        if document.get("pdfSha256") != pack["pdfSha256"]:
            raise MergeError("Existing decisions file is for a different source PDF")
    else:
        document = {"schema": SCHEMA_VERSION, "kind": "textbook-review-decisions",
                    "bookId": book_id, "pdfSha256": pack["pdfSha256"],
                    "howToUse": ("AI 已依裁切圖預填 q/opts/ans。人工核對後把 decision 改成 approve；"
                                 "decision 空白的一律不會輸出。confidence=check 的先看。"),
                    "decisions": []}
    existing = {entry["id"]: entry for entry in document["decisions"]}

    added = updated = preserved = 0
    for qid, draft in drafts.items():
        question = by_id[qid]
        entry = existing.get(qid)
        if entry and entry.get("decision"):
            preserved += 1          # a human already ruled; drafts never overwrite that
            continue
        payload = {
            "id": qid,
            "decision": "",
            "draftedBy": DRAFTER,
            "confidence": draft.get("confidence", "check"),
            "printedPage": question["printedPage"],
            "role": question["role"],
            "questionType": question["questionType"],
            "sourceDifficulty": question["sourceDifficulty"],
            "flags": question["flags"],
            "crop": f"crops/{qid}/stem.png",
            "topic": draft.get("topic", ""),
            "type": draft.get("type", ""),
            "q": draft.get("q", ""),
            "opts": draft.get("opts", []),
            "ans": draft.get("ans", []),
            "diff": draft.get("diff"),
            "diffEvidence": draft.get("diffEvidence", ""),
            "acceptedFlags": [],
            "notes": draft.get("notes", ""),
        }
        if entry:
            entry.update(payload)
            updated += 1
        else:
            document["decisions"].append(payload)
            added += 1

    decisions_path.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"bookId": book_id, "drafts": len(drafts), "added": added,
            "updated": updated, "humanDecisionsPreserved": preserved,
            "decisionsFile": str(decisions_path)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--drafts", required=True)
    args = parser.parse_args(argv)
    try:
        result = merge(args.work, args.book, args.drafts)
    except MergeError as error:
        print(f"merge-drafts: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
