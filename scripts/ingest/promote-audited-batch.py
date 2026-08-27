#!/usr/bin/env python3
"""Verify and promote every approved qpack in one audited release batch.

The independent audit supplies only the visual judgement.  This command still
re-renders each crop from the catalogued PDF and requires an exact pixel match
before ``promote-reviewed-stems.py`` can create a private stem asset.  Outputs
stay outside Git and are only a release candidate; mathematical verification
and a named human release sign-off remain separate gates.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPT_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


prepare_stems = load_module("prepare_stem_review", "prepare-stem-review.py")
promote_stems = load_module("promote_reviewed_stems_batch", "promote-reviewed-stems.py")


class AuditedBatchError(RuntimeError):
    """A fail-closed audited batch promotion error."""


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
        raise AuditedBatchError(f"Cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise AuditedBatchError(f"Expected a JSON object: {path}")
    return value


def ensure_outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
    raise AuditedBatchError(f"Private release candidate must stay outside Git: {resolved}")


def catalog_rows(path: Path) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    books: dict[str, dict[str, str]] = {}
    for line in text.splitlines():
        id_match = re.search(r"\bid:'([^']+)'", line)
        file_match = re.search(r"\bfile:'([^']+)'", line)
        hash_match = re.search(r"\bpdfSha256:'([a-f0-9]{64})'", line)
        if id_match and file_match and hash_match:
            books[id_match.group(1)] = {
                "file": file_match.group(1), "pdfSha256": hash_match.group(1),
            }
    trusted = {}
    for key in ("generation", "manifestAlias", "sourceInventorySha256",
                "ocrProvider", "ocrModel", "verificationPolicy"):
        match = re.search(rf"\b{key}:\s*'([^']+)'", text)
        if match:
            trusted[key] = match.group(1)
    for key in ("sourceDocuments", "sourcePages"):
        match = re.search(rf"\b{key}:\s*(\d+)", text)
        if match:
            trusted[key] = int(match.group(1))
    return books, trusted


def audit_rows(audit: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for sheet in audit.get("sheets") or []:
        for row in (sheet or {}).get("items") or []:
            qid = row.get("id") if isinstance(row, dict) else None
            if not isinstance(qid, str) or not qid or qid in rows:
                raise AuditedBatchError("Audit contains a missing or duplicate question id")
            rows[qid] = row
    return rows


def completed_review(template: dict[str, Any], audit_by_id: dict[str, dict[str, Any]],
                     reviewer: str, reviewed_at: str, audit_hash: str) -> dict[str, Any]:
    questions = []
    for row in template.get("questions") or []:
        qid = row.get("id")
        visual = audit_by_id.get(qid)
        if not visual:
            raise AuditedBatchError(f"Independent audit has no row for approved question {qid}")
        unsafe = any(visual.get(key) is not False for key in (
            "containsAnswer", "containsSolution", "containsHandwriting", "containsAdjacentQuestion"))
        if visual.get("fullStem") is not True or unsafe:
            raise AuditedBatchError(f"Independent audit did not mark approved question safe: {qid}")
        qtype = next((q.get("type") for q in template.get("questions") or [] if q.get("id") == qid), None)
        questions.append({
            "id": qid, "decision": "pass", "cropSha256": row["cropSha256"],
            "integrity": dict(row["integrity"]),
            "visual": {
                "fullStemVerified": True,
                "allOptionsVerified": qtype == "fill" or visual.get("allOptions") is True,
                "containsAnswer": False, "containsSolution": False,
                "containsHandwriting": False, "containsAdjacentQuestion": False,
            },
            "notes": "Independent audit record; PDF/crop integrity is rechecked by promotion.",
        })
    output = {key: value for key, value in template.items() if key != "howToUse"}
    output.update({
        "reviewer": reviewer, "reviewedAt": reviewed_at,
        "summary": {"passed": len(questions), "failed": 0},
        "questions": questions, "sourceAuditSha256": audit_hash,
        "releaseAuthority": False,
    })
    return output


def promote_batch(materialized_root: Path, audit_file: Path, work_root: Path,
                  pdf_root: Path, output_root: Path, catalog_file: Path) -> dict[str, Any]:
    materialized_root = ensure_outside_repo(materialized_root)
    work_root = ensure_outside_repo(work_root)
    pdf_root = ensure_outside_repo(pdf_root)
    output_root = ensure_outside_repo(output_root)
    if output_root.exists() and any(output_root.iterdir()):
        raise AuditedBatchError("Output directory must be empty to prevent stale promoted assets")
    output_root.mkdir(parents=True, exist_ok=True)

    materialization = read_json(materialized_root / "materialization-report.json")
    audit = read_json(audit_file)
    audit_hash = sha256(audit_file)
    if materialization.get("kind") != "matha-materialized-batch-review" \
            or materialization.get("releaseAuthority") is not False:
        raise AuditedBatchError("Materialization report kind/authority is invalid")
    if materialization.get("auditSha256") != audit_hash:
        raise AuditedBatchError("Materialized decisions were made against a different audit")
    if audit.get("kind") != "openai-independent-visual-audit" \
            or audit.get("releaseAuthority") is not False:
        raise AuditedBatchError("Independent audit kind/authority is invalid")
    reviewer = f"OpenAI {str(audit.get('model') or 'model')} independent visual audit"
    reviewed_at = str(audit.get("completedAt") or "")
    if not reviewed_at:
        raise AuditedBatchError("Independent audit has no completion timestamp")
    by_id = audit_rows(audit)
    catalog, trusted = catalog_rows(catalog_file)

    promoted_books = []
    combined_questions = []
    for book in materialization.get("books") or []:
        book_id = str((book or {}).get("bookId") or "")
        catalog_book = catalog.get(book_id)
        if not catalog_book:
            raise AuditedBatchError(f"Book is absent from the trusted catalog: {book_id}")
        source_file = materialized_root / book_id / "qpack.json"
        book_dir = work_root / book_id
        pdf_file = pdf_root / catalog_book["file"]
        crop_manifest = book_dir / "crops-manifest.json"
        review_dir = output_root / "independent-reviews" / book_id
        prepared = prepare_stems.prepare(
            source_file, book_dir, pdf_file, crop_manifest, review_dir, catalog_file)
        template_file = Path(prepared["template"])
        review_document = completed_review(
            read_json(template_file), by_id, reviewer, reviewed_at, audit_hash)
        review_file = review_dir / "independent-stem-review.json"
        review_file.write_text(
            json.dumps(review_document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        promotion_dir = output_root / "promoted" / book_id
        result = promote_stems.promote(
            source_file, book_dir, pdf_file, crop_manifest,
            review_file, promotion_dir, catalog_file)
        promoted_source = read_json(Path(result["sourceOutput"]))
        combined_questions.extend(promoted_source.get("questions") or [])
        promoted_books.append({
            "bookId": book_id, "questions": result["questions"],
            "source": result["sourceOutput"], "assetRoot": result["assetRoot"],
            "promotionManifest": result["promotionManifest"],
        })

    if len(combined_questions) != int(materialization.get("approved", -1)):
        raise AuditedBatchError("Promoted question total differs from the approved batch total")
    combined = {
        "schema": 1, "kind": "private-question-source",
        "reviewedBy": str(materialization.get("reviewedBy") or ""),
        "corpusGeneration": trusted.get("generation", ""),
        "sourceInventorySha256": trusted.get("sourceInventorySha256", ""),
        "sourceDocuments": trusted.get("sourceDocuments", 0),
        "sourcePages": trusted.get("sourcePages", 0),
        "ocrProvider": trusted.get("ocrProvider", ""),
        "ocrModel": trusted.get("ocrModel", ""),
        "verificationPolicy": trusted.get("verificationPolicy", ""),
        "originalPdfVerified": True,
        "answerKeyVerified": True,
        "mathematicalCorrectnessVerified": False,
        "releaseApprovedBy": None,
        "reviewAudit": {
            "sourceQuestionCount": len(combined_questions),
            "approvedQuestionCount": len(combined_questions),
            "completedAt": str(materialization.get("reviewedAt") or reviewed_at),
            "primaryReviewAuthority": False,
            "independentAuditAuthority": False,
        },
        "questions": combined_questions,
    }
    combined_file = output_root / "combined-source-candidate.json"
    combined_file.write_text(json.dumps(combined, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    report = {
        "kind": "matha-promoted-audited-batch", "version": 1,
        "releaseAuthority": False, "humanSignoffStillRequired": True,
        "mathematicalCorrectnessStillRequired": True,
        "questions": len(combined_questions), "books": promoted_books,
        "combinedSource": str(combined_file), "combinedSourceSha256": sha256(combined_file),
    }
    (output_root / "promotion-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return report


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--materialized", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--pdf-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--catalog", type=Path, default=REPO_ROOT / "textbook-catalog.js")
    args = parser.parse_args(argv)
    try:
        result = promote_batch(args.materialized, args.audit, args.work,
                               args.pdf_root, args.output, args.catalog)
    except (AuditedBatchError, promote_stems.PromotionError, OSError, ValueError) as error:
        print(f"promote-audited-batch: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
