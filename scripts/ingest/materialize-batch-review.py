#!/usr/bin/env python3
"""Materialize one hash-bound visual-review batch into per-book qpacks.

This command does not publish anything.  It combines three separate records:

* the deterministic release queue;
* the independent model audit of the original stem/answer contact sheets; and
* an explicit primary pixel-review file covering every queued question.

Only questions approved by the primary review *and* found visually safe by the
independent audit are passed to ``apply-review.py``.  OCR text is never copied
into the student-visible question field; the official answer transcription is
metadata used for grading and remains backed by the answer crop.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("apply_review", SCRIPT_DIR / "apply-review.py")
apply_review = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(apply_review)

REPO_ROOT = SCRIPT_DIR.parent.parent


class BatchReviewError(RuntimeError):
    """A fail-closed batch review error."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BatchReviewError(f"Cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise BatchReviewError(f"Expected a JSON object: {path}")
    return value


def ensure_outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
    raise BatchReviewError(f"Private review output must stay outside Git: {resolved}")


def flattened_audit(audit: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for sheet in audit.get("sheets") or []:
        if not isinstance(sheet, dict):
            raise BatchReviewError("Audit contains a malformed sheet")
        for row in sheet.get("items") or []:
            qid = row.get("id") if isinstance(row, dict) else None
            if not isinstance(qid, str) or not qid or qid in rows:
                raise BatchReviewError("Audit contains a missing or duplicate question id")
            rows[qid] = row
    return rows


def compile_decisions(queue: dict[str, Any], audit: dict[str, Any],
                      primary: dict[str, Any]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    if queue.get("kind") != "textbook-on-demand-release-review-queue":
        raise BatchReviewError("Expected a textbook release review queue")
    if audit.get("kind") != "openai-independent-visual-audit" \
            or audit.get("releaseAuthority") is not False:
        raise BatchReviewError("Independent visual audit kind/authority is invalid")
    if primary.get("kind") != "matha-batch-primary-pixel-review" \
            or primary.get("releaseAuthority") is not False:
        raise BatchReviewError("Primary pixel review kind/authority is invalid")
    reviewer = str(primary.get("reviewedBy") or "").strip()
    reviewed_at = str(primary.get("reviewedAt") or "").strip()
    if len(reviewer) < 3 or not reviewed_at:
        raise BatchReviewError("Primary review must have a named reviewer and timestamp")

    queue_items = queue.get("items") or []
    queue_by_id = {row.get("id"): row for row in queue_items if isinstance(row, dict)}
    if len(queue_by_id) != len(queue_items) or None in queue_by_id:
        raise BatchReviewError("Queue contains a missing or duplicate question id")
    audit_by_id = flattened_audit(audit)
    if set(audit_by_id) != set(queue_by_id):
        raise BatchReviewError("Independent audit must cover exactly the queued questions")
    primary_rows = primary.get("items") or []
    primary_by_id = {row.get("id"): row for row in primary_rows if isinstance(row, dict)}
    if len(primary_by_id) != len(primary_rows) or set(primary_by_id) != set(queue_by_id):
        raise BatchReviewError("Primary review must cover exactly every queued question")

    by_book: dict[str, list[dict[str, Any]]] = defaultdict(list)
    approved_ids: list[str] = []
    repair_rows: list[dict[str, str]] = []
    unsafe_keys = ("containsAnswer", "containsSolution", "containsHandwriting",
                   "containsAdjacentQuestion")
    for qid, item in queue_by_id.items():
        human = primary_by_id[qid]
        decision = human.get("decision")
        if decision not in {"approve", "repair", "reject"}:
            raise BatchReviewError(f"{qid}: decision must be approve/repair/reject")
        if decision != "approve":
            reason = str(human.get("reason") or "").strip()
            if not reason:
                raise BatchReviewError(f"{qid}: non-approval needs a reason")
            repair_rows.append({"id": qid, "decision": decision, "reason": reason})
            continue

        visual = audit_by_id[qid]
        if visual.get("fullStem") is not True or any(visual.get(key) is not False for key in unsafe_keys):
            raise BatchReviewError(f"{qid}: primary approval conflicts with unsafe independent audit")
        qtype = str(item.get("suggestedType") or "")
        if qtype not in apply_review.TYPES:
            raise BatchReviewError(f"{qid}: unsupported release type {qtype!r}")
        answer_text = str(visual.get("answerText") or "").strip()
        if not answer_text:
            raise BatchReviewError(f"{qid}: official answer transcription is blank")
        topic = str(human.get("topic") or "").strip()
        if topic not in apply_review.TOPICS:
            raise BatchReviewError(f"{qid}: approved item needs a valid manually chosen topic")

        option_count = visual.get("optionCount")
        answer_indexes = visual.get("answerIndexes") or []
        if qtype in {"single", "multi"}:
            if visual.get("allOptions") is not True:
                raise BatchReviewError(f"{qid}: choice crop does not contain every option")
            if not isinstance(option_count, int) or isinstance(option_count, bool) \
                    or not 2 <= option_count <= 10:
                raise BatchReviewError(f"{qid}: choice audit needs optionCount from 2 to 10")
            if not answer_indexes or any(not isinstance(index, int) or isinstance(index, bool)
                                         or not 0 <= index < option_count for index in answer_indexes):
                raise BatchReviewError(f"{qid}: choice answer indexes are invalid")
            if qtype == "single" and len(answer_indexes) != 1:
                raise BatchReviewError(f"{qid}: single-choice answer must have exactly one index")
            answers: list[Any] = answer_indexes
        else:
            option_count = None
            answers = [answer_text]

        by_book[str(item["bookId"])].append({
            "id": qid,
            "decision": "approve",
            "topic": topic,
            "type": qtype,
            "imageFirst": True,
            "cropReview": {
                "fullStem": True,
                "allOptions": visual.get("allOptions") is True,
                "containsAnswer": False,
                "containsSolution": False,
                "containsHandwriting": False,
                "containsAdjacentQuestion": False,
            },
            "answerVerified": True,
            "optionCount": option_count,
            "ans": answers,
            "q": "",
            "opts": [],
            "diff": None,
            "diffEvidence": "",
            "acceptedFlags": [],
            "notes": str(human.get("notes") or "").strip(),
        })
        approved_ids.append(qid)

    return dict(by_book), {
        "queued": len(queue_items), "approved": len(approved_ids),
        "notApproved": len(repair_rows), "approvedIds": approved_ids,
        "notApprovedItems": repair_rows, "reviewedBy": reviewer,
        "reviewedAt": reviewed_at,
    }


def materialize(queue_file: Path, audit_file: Path, primary_file: Path,
                work_root: Path, output_root: Path, catalog_file: Path) -> dict[str, Any]:
    work_root = ensure_outside_repo(work_root)
    output_root = ensure_outside_repo(output_root)
    if output_root.exists() and any(output_root.iterdir()):
        raise BatchReviewError("Output directory must be empty to prevent stale review decisions")
    output_root.mkdir(parents=True, exist_ok=True)
    queue, audit, primary = read_json(queue_file), read_json(audit_file), read_json(primary_file)
    queue_hash, audit_hash = sha256(queue_file), sha256(audit_file)
    if audit.get("queueSha256") != queue_hash or primary.get("queueSha256") != queue_hash \
            or primary.get("auditSha256") != audit_hash:
        raise BatchReviewError("Queue/audit/primary review hashes do not match")
    by_book, summary = compile_decisions(queue, audit, primary)

    outputs = []
    for book_id, decisions in sorted(by_book.items()):
        pack = apply_review.load_pack(work_root, book_id)
        book_dir = output_root / book_id
        book_dir.mkdir(parents=True, exist_ok=True)
        decisions_file = book_dir / "review-decisions.json"
        decisions_document = {
            "schema": apply_review.SCHEMA_VERSION,
            "kind": "textbook-review-decisions",
            "bookId": book_id,
            "pdfSha256": pack["pdfSha256"],
            "reviewer": summary["reviewedBy"],
            "reviewedAt": summary["reviewedAt"],
            "releaseAuthority": False,
            "sourceQueueSha256": queue_hash,
            "sourceAuditSha256": audit_hash,
            "decisions": decisions,
        }
        decisions_file.write_text(
            json.dumps(decisions_document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        qpack_file = book_dir / "qpack.json"
        result = apply_review.apply(work_root, book_id, decisions_file, qpack_file, catalog_file)
        if result["approved"] != len(decisions) or result["refused"]:
            raise BatchReviewError(f"{book_id}: apply-review refused an approved decision")
        outputs.append({"bookId": book_id, "questions": len(decisions),
                        "decisions": str(decisions_file), "qpack": str(qpack_file)})

    result = {
        "kind": "matha-materialized-batch-review", "version": 1,
        "releaseAuthority": False, "humanSignoffStillRequired": True,
        "queueSha256": queue_hash, "auditSha256": audit_hash,
        **summary, "books": outputs,
    }
    (output_root / "materialization-report.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    parser.add_argument("--primary-review", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--catalog", type=Path, default=REPO_ROOT / "textbook-catalog.js")
    args = parser.parse_args(argv)
    try:
        result = materialize(args.queue, args.audit, args.primary_review,
                             args.work, args.output, args.catalog)
    except (BatchReviewError, apply_review.ReviewError, OSError, ValueError) as error:
        print(f"materialize-batch-review: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
