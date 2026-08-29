#!/usr/bin/env python3
"""Build a private starter candidate set from a full owner-delegated pixel audit.

This is an explicit alternative to ``intersect-cleaned-human-reviews.py`` for
the repository owner's request that Codex finish construction before asking
the owner to do review work.  It never pretends the reviewer is human.  The
input decision file must cover every question in the batch, bind the exact
source/template/answer manifests, identify the automated reviewer and record
the owner's delegation.  Questions without intact pixels *and* a printed
official answer are quarantined.  Output remains unsigned and private.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
REVIEW_POLICY = "owner-delegated-agent-direct-pixel-v1"
REVIEW_KIND = "matha-owner-delegated-starter-direct-review"
OUTPUT_KIND = "matha-private-cleaned-owner-delegated-review-candidates"
AGENT_RE = re.compile(r"codex|chatgpt|gpt|agent|automation|模型|人工智慧|\bai\b", re.I)
PIXEL_CHECKS = (
    "printedContentIntact", "allHandwritingRemoved", "noAnswerOrSolutionLeak",
    "fullQuestionAndOptions", "figuresAndGreyLinesIntact", "chineseTextIntact",
    "mathSymbolsAndFormulasIntact",
)
ANSWER_CHECKS = (
    "questionAnswerIdentityVerified", "allSubpartsCovered", "answerLegible",
    "noAdjacentAnswerConfusion", "figureConditionsHandled", "mathematicallyCorrect",
    "printedOfficialAnswerPresent",
)


class DelegatedReviewError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise DelegatedReviewError(f"{label} does not exist: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DelegatedReviewError(f"{label} must be a JSON object")
    return value


def unique_rows(rows: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(rows, list):
        raise DelegatedReviewError(f"{label} must be a list")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise DelegatedReviewError(f"{label} contains an invalid id")
        if row["id"] in result:
            raise DelegatedReviewError(f"{label} contains duplicate id: {row['id']}")
        result[row["id"]] = row
    return result


def zoned_time(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise DelegatedReviewError(f"{label} is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise DelegatedReviewError(f"{label} is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DelegatedReviewError(f"{label} must include a timezone")
    return value


def structured_answer(value: Any, question_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != 1:
        raise DelegatedReviewError(f"{question_id}: structured answer is missing")
    mode = value.get("mode")
    if mode == "text":
        text = value.get("officialAnswerText")
        if (not isinstance(text, str) or not text.strip() or len(text.strip()) > 4000
                or set(value) != {"schema", "mode", "officialAnswerText"}):
            raise DelegatedReviewError(f"{question_id}: text answer is invalid")
        return {"schema": 1, "mode": "text", "officialAnswerText": text.strip()}
    if mode not in {"single", "multi"}:
        raise DelegatedReviewError(f"{question_id}: answer mode is invalid")
    count = value.get("optionCount")
    numbers = value.get("correctOptionNumbers")
    if (not isinstance(count, int) or isinstance(count, bool) or not 2 <= count <= 12
            or not isinstance(numbers, list) or not numbers
            or any(not isinstance(number, int) or isinstance(number, bool)
                   or number < 1 or number > count for number in numbers)
            or len(numbers) != len(set(numbers))
            or (mode == "single" and len(numbers) != 1)
            or set(value) != {"schema", "mode", "optionCount", "correctOptionNumbers"}):
        raise DelegatedReviewError(f"{question_id}: option answer is invalid")
    return {"schema": 1, "mode": mode, "optionCount": count,
            "correctOptionNumbers": numbers}


def build(candidate_path: Path, pixel_template_path: Path, binding_path: Path,
          answer_template_path: Path, decisions_path: Path, output: Path) -> dict[str, Any]:
    for path in (candidate_path, pixel_template_path, binding_path,
                 answer_template_path, decisions_path):
        if not path.is_file():
            raise DelegatedReviewError(f"required input does not exist: {path}")
    candidate = read_json(candidate_path, "candidate manifest")
    pixel_template = read_json(pixel_template_path, "pixel template")
    binding = read_json(binding_path, "answer binding")
    answer_template = read_json(answer_template_path, "answer template")
    decisions = read_json(decisions_path, "delegated decisions")
    if candidate.get("releaseAuthority") is not False:
        raise DelegatedReviewError("candidate manifest must remain releaseAuthority:false")
    if pixel_template.get("releaseAuthority") is not False \
            or answer_template.get("releaseAuthority") is not False \
            or binding.get("releaseAuthority") is not False:
        raise DelegatedReviewError("review inputs must remain releaseAuthority:false")
    candidate_hash = sha256(candidate_path)
    binding_hash = sha256(binding_path)
    if pixel_template.get("candidateManifestSha256") != candidate_hash \
            or answer_template.get("candidateManifestSha256") != candidate_hash \
            or binding.get("candidateManifestSha256") != candidate_hash:
        raise DelegatedReviewError("candidate manifest hash binding mismatch")
    if answer_template.get("answerBindingSha256") != binding_hash:
        raise DelegatedReviewError("answer template binding hash mismatch")

    exact = decisions.get("exactInputs")
    expected_exact = {
        "candidateManifestSha256": candidate_hash,
        "pixelTemplateSha256": sha256(pixel_template_path),
        "answerBindingSha256": binding_hash,
        "answerTemplateSha256": sha256(answer_template_path),
    }
    if exact != expected_exact:
        raise DelegatedReviewError("delegated review exact input hashes do not match")
    if (decisions.get("kind") != REVIEW_KIND or decisions.get("version") != 1
            or decisions.get("reviewPolicy") != REVIEW_POLICY
            or decisions.get("releaseAuthority") is not False):
        raise DelegatedReviewError("delegated review header is invalid")
    reviewer = str(decisions.get("reviewedBy") or "").strip()
    if len(reviewer) < 3 or not AGENT_RE.search(reviewer):
        raise DelegatedReviewError("reviewedBy must transparently identify the automated reviewer")
    reviewed_at = zoned_time(decisions.get("reviewedAt"), "reviewedAt")
    delegation = decisions.get("delegation")
    if (not isinstance(delegation, dict)
            or delegation.get("kind") != "owner-delegated-agent-content-review"
            or not isinstance(delegation.get("authorizedBy"), str)
            or len(delegation["authorizedBy"].strip()) < 3
            or AGENT_RE.search(delegation["authorizedBy"])
            or not isinstance(delegation.get("scope"), str)
            or "starter" not in delegation["scope"].lower()
            or not isinstance(delegation.get("basis"), str)
            or len(delegation["basis"].strip()) < 12):
        raise DelegatedReviewError("owner delegation is incomplete or ambiguous")
    zoned_time(delegation.get("authorizedAt"), "delegation.authorizedAt")

    candidates = unique_rows(candidate.get("items"), "candidate items")
    pixels = unique_rows(pixel_template.get("questions"), "pixel template questions")
    bindings = unique_rows(binding.get("items"), "answer binding items")
    answers = unique_rows(answer_template.get("questions"), "answer template questions")
    rows = unique_rows(decisions.get("questions"), "delegated decision questions")
    if not (set(candidates) == set(pixels) == set(bindings) == set(answers) == set(rows)):
        raise DelegatedReviewError("delegated review must cover the exact complete batch")

    attestation = decisions.get("passAttestation")
    if (not isinstance(attestation, dict)
            or attestation.get("appliesToEveryPassedQuestion") is not True
            or not isinstance(attestation.get("pixelChecks"), dict)
            or any(attestation["pixelChecks"].get(key) is not True for key in PIXEL_CHECKS)
            or not isinstance(attestation.get("answerChecks"), dict)
            or any(attestation["answerChecks"].get(key) is not True for key in ANSWER_CHECKS)):
        raise DelegatedReviewError("complete pass attestation is required")

    eligible: list[str] = []
    quarantine: list[dict[str, Any]] = []
    normalized: dict[str, dict[str, Any]] = {}
    for qid in sorted(candidates):
        row, pixel, answer = rows[qid], pixels[qid], answers[qid]
        source, bound = candidates[qid], bindings[qid]
        for field in ("sourceSha256", "cleanedSha256"):
            if pixel.get(field) != source.get(field):
                raise DelegatedReviewError(f"{qid}: {field} pixel template/candidate mismatch")
        if not isinstance(pixel.get("removedOverlaySha256"), str) \
                or len(pixel["removedOverlaySha256"]) != 64:
            raise DelegatedReviewError(f"{qid}: removed overlay hash is invalid")
        for field in ("cleanedSha256", "answerSha256", "sourcePdfSha256"):
            if answer.get(field) != bound.get(field):
                raise DelegatedReviewError(f"{qid}: {field} answer template/binding mismatch")
        pixel_decision = row.get("pixelDecision")
        answer_decision = row.get("answerDecision")
        if pixel_decision not in {"pass", "reject"} or answer_decision not in {"pass", "reject"}:
            raise DelegatedReviewError(f"{qid}: both decisions are required")
        if pixel_decision == "pass":
            checks = row.get("pixelChecks") or attestation["pixelChecks"]
            if not isinstance(checks, dict) or any(checks.get(key) is not True for key in PIXEL_CHECKS):
                raise DelegatedReviewError(f"{qid}: passed pixel review has unchecked gates")
        if answer_decision == "pass":
            checks = row.get("answerChecks") or attestation["answerChecks"]
            if not isinstance(checks, dict) or any(checks.get(key) is not True for key in ANSWER_CHECKS):
                raise DelegatedReviewError(f"{qid}: passed answer review has unchecked gates")
            normalized[qid] = structured_answer(row.get("structuredAnswer"), qid)
        reasons = row.get("reasons")
        if pixel_decision == "reject" or answer_decision == "reject":
            if not isinstance(reasons, list) or not reasons \
                    or any(not isinstance(value, str) or len(value.strip()) < 4 for value in reasons):
                raise DelegatedReviewError(f"{qid}: rejected question needs explicit reasons")
            quarantine.append({"id": qid, "reasons": [value.strip() for value in reasons]})
        else:
            eligible.append(qid)

    items = []
    for qid in eligible:
        source, answer = candidates[qid], bindings[qid]
        items.append({
            "id": qid, "bookId": answer.get("bookId"), "chapter": answer.get("chapter"),
            "role": answer.get("role"), "questionType": answer.get("questionType"),
            "pdfPage": answer.get("pdfPage"), "stemRegion": source.get("stemRegion"),
            "cropDpi": source.get("cropDpi"), "cleaned": source.get("cleaned"),
            "cleanedSha256": source.get("cleanedSha256"),
            "answerPath": answer.get("answerPath"), "answerPdfPage": answer.get("answerPdfPage"),
            "answerRegion": answer.get("answerRegion"), "answerSource": answer.get("answerSource"),
            "answerSha256": answer.get("answerSha256"),
            "sourcePdfSha256": answer.get("sourcePdfSha256"),
            "figureCount": answer.get("figureCount"), "figureSha256": answer.get("figureSha256"),
            "structuredAnswer": normalized[qid],
        })

    document = {
        "kind": OUTPUT_KIND, "version": 1, "releaseAuthority": False,
        "reviewPolicy": REVIEW_POLICY, "humanReviewClaimed": False,
        "ownerDelegation": delegation, "directReviewSha256": sha256(decisions_path),
        "reviewedBy": reviewer, "reviewedAt": reviewed_at,
        "pixelReviewer": reviewer, "pixelReviewedAt": reviewed_at,
        "answerReviewer": reviewer, "answerReviewedAt": reviewed_at,
        "ownerReleaseAuthorizationRecorded": True,
        "privateAssetDeploymentStillRequired": True, "uploadPerformed": False,
        "candidateManifestSha256": candidate_hash,
        "pixelReviewTemplateSha256": sha256(pixel_template_path),
        "answerBindingSha256": binding_hash,
        "answerReviewTemplateSha256": sha256(answer_template_path),
        "counts": {"totalCandidates": len(candidates), "eligible": len(items),
                   "quarantined": len(quarantine)},
        "quarantine": quarantine, "items": items,
        "nextGate": "Hash-bind this delegated full review to a private release bundle and deploy it.",
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--pixel-template", type=Path, required=True)
    parser.add_argument("--answer-binding", type=Path, required=True)
    parser.add_argument("--answer-template", type=Path, required=True)
    parser.add_argument("--decisions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = build(args.candidate_manifest, args.pixel_template, args.answer_binding,
                       args.answer_template, args.decisions, args.output)
        print(json.dumps({"output": str(args.output.resolve()), "counts": result["counts"],
                          "reviewPolicy": result["reviewPolicy"]}, ensure_ascii=False, indent=2))
        return 0
    except (DelegatedReviewError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"intersect-owner-delegated-review: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
