#!/usr/bin/env python3
"""Apply the final named human sign-off to a math-verified private source.

Run this only after the named person explicitly approves the exact candidate.
The command verifies the saved mathematical audit and filtered question list;
it cannot be used with an AI/bot reviewer name and does not upload anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
NON_HUMAN = re.compile(r"claude|codex|chatgpt|gpt|gemini|agent|bot|automation|自動|模型|人工智慧|\bai\b", re.I)


class SignoffError(RuntimeError):
    """A fail-closed release sign-off error."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SignoffError(f"Expected JSON object: {path}")
    return value


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
    raise SignoffError(f"Private signed source must stay outside Git: {resolved}")


def sign(source_file: Path, audit_file: Path, output_file: Path,
         approved_by: str) -> dict[str, Any]:
    output_file = outside_repo(output_file)
    approved_by = approved_by.strip()
    if len(approved_by) < 3 or NON_HUMAN.search(approved_by):
        raise SignoffError("releaseApprovedBy must be a named human, not an AI/automation label")
    if output_file.exists():
        raise SignoffError("Signed output already exists; never overwrite a prior approval")
    source, audit = read_json(source_file), read_json(audit_file)
    if source.get("kind") != "private-question-source" \
            or source.get("mathematicalCorrectnessVerified") is not True \
            or source.get("releaseApprovedBy") is not None:
        raise SignoffError("Source is not an unsigned math-verified private source")
    verification = source.get("mathVerification") or {}
    if verification.get("releaseAuthority") is not False \
            or verification.get("auditSha256") != sha256(audit_file):
        raise SignoffError("Mathematical audit hash/authority does not match the source")
    if audit.get("kind") != "matha-independent-mathematical-verification" \
            or audit.get("releaseAuthority") is not False:
        raise SignoffError("Mathematical audit kind/authority is invalid")
    question_ids = [row.get("id") for row in source.get("questions") or []]
    verified_ids = (verification.get("verifiedQuestionIds") or [])
    if not question_ids or question_ids != verified_ids or len(set(question_ids)) != len(question_ids):
        raise SignoffError("Signed source questions do not exactly match the verified question order")
    excluded = set(verification.get("excludedQuestionIds") or [])
    if excluded.intersection(question_ids):
        raise SignoffError("A mathematically excluded question is still present")

    signed_at = datetime.now(timezone.utc).isoformat()
    source_hash = sha256(source_file)
    signed = {**source, "releaseApprovedBy": approved_by,
              "releaseApproval": {
                  "kind": "named-human-private-release-signoff", "version": 1,
                  "approvedBy": approved_by, "approvedAt": signed_at,
                  "sourceSha256": source_hash, "mathAuditSha256": sha256(audit_file),
                  "statement": "Approve this exact filtered batch for authenticated private release.",
              }}
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(signed, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {"questions": len(question_ids), "approvedBy": approved_by,
            "approvedAt": signed_at, "sourceSha256": source_hash,
            "signedOutput": str(output_file), "signedSha256": sha256(output_file)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--math-audit", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--approved-by", required=True)
    args = parser.parse_args(argv)
    try:
        result = sign(args.source, args.math_audit, args.output, args.approved_by)
    except (SignoffError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"sign-private-release: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
