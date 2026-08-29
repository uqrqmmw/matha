#!/usr/bin/env python3
"""Create a complete hash-bound owner-delegated review decision document.

The compact specification is private and contains the direct-pixel decisions
and the answer transcribed from the printed official answer crop.  This tool
does not run OCR, infer an answer, or relax any gate; it only binds that audit
to the exact four immutable review inputs and expands the common pass checks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


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


class DecisionBuildError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise DecisionBuildError(f"input does not exist: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DecisionBuildError(f"input must be an object: {path}")
    return value


def rows_by_id(rows: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(rows, list):
        raise DecisionBuildError(f"{label} must be a list")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise DecisionBuildError(f"{label} contains an invalid id")
        if row["id"] in result:
            raise DecisionBuildError(f"{label} contains duplicate id: {row['id']}")
        result[row["id"]] = row
    return result


def spec_from_prior(path: Path) -> dict[str, Any]:
    prior = read_json(path)
    if (prior.get("kind") != "matha-private-cleaned-owner-delegated-review-candidates"
            or prior.get("releaseAuthority") is not False
            or prior.get("reviewPolicy") != "owner-delegated-agent-direct-pixel-v1"):
        raise DecisionBuildError("prior intersection is not a delegated fail-closed review artifact")
    questions: list[dict[str, Any]] = []
    for row in prior.get("items") or []:
        questions.append({"id": row.get("id"), "pixelDecision": "pass",
                          "answerDecision": "pass",
                          "structuredAnswer": row.get("structuredAnswer")})
    for row in prior.get("quarantine") or []:
        questions.append({"id": row.get("id"), "pixelDecision": "reject",
                          "answerDecision": "reject", "reasons": row.get("reasons")})
    return {
        "reviewedBy": prior.get("reviewedBy"), "reviewedAt": prior.get("reviewedAt"),
        "delegation": prior.get("ownerDelegation"), "questions": questions,
    }


def build(candidate: Path, pixel_template: Path, binding: Path,
          answer_template: Path, spec_path: Path | None,
          prior_intersection: Path | None, output: Path) -> dict[str, Any]:
    candidate_value = read_json(candidate)
    pixel_value = read_json(pixel_template)
    binding_value = read_json(binding)
    answer_value = read_json(answer_template)
    if (spec_path is None) == (prior_intersection is None):
        raise DecisionBuildError("provide exactly one of spec or prior intersection")
    spec = read_json(spec_path) if spec_path else spec_from_prior(prior_intersection)
    ids = set(rows_by_id(candidate_value.get("items"), "candidate items"))
    for value, key, label in (
        (pixel_value, "questions", "pixel template questions"),
        (binding_value, "items", "answer binding items"),
        (answer_value, "questions", "answer template questions"),
    ):
        if set(rows_by_id(value.get(key), label)) != ids:
            raise DecisionBuildError(f"{label} does not match candidate ids")
    specs = rows_by_id(spec.get("questions"), "spec questions")
    if set(specs) != ids:
        missing = sorted(ids - set(specs))
        extra = sorted(set(specs) - ids)
        raise DecisionBuildError(f"spec must cover exact batch; missing={missing}, extra={extra}")

    rows: list[dict[str, Any]] = []
    for qid in sorted(ids):
        source = specs[qid]
        pixel_decision = source.get("pixelDecision", "pass")
        answer_decision = source.get("answerDecision", "pass")
        if pixel_decision not in {"pass", "reject"} or answer_decision not in {"pass", "reject"}:
            raise DecisionBuildError(f"{qid}: decisions must be pass or reject")
        row: dict[str, Any] = {
            "id": qid, "pixelDecision": pixel_decision,
            "answerDecision": answer_decision,
        }
        if answer_decision == "pass":
            structured = source.get("structuredAnswer")
            compact_modes = [key for key in ("answerText", "single", "multi") if key in source]
            if structured is None and len(compact_modes) == 1:
                compact_mode = compact_modes[0]
                if compact_mode == "answerText":
                    structured = {"schema": 1, "mode": "text",
                                  "officialAnswerText": source[compact_mode]}
                else:
                    values = source[compact_mode]
                    if compact_mode == "single":
                        values = [values]
                    structured = {"schema": 1, "mode": compact_mode,
                                  "optionCount": source.get("optionCount", 5),
                                  "correctOptionNumbers": values}
            if not isinstance(structured, dict):
                raise DecisionBuildError(f"{qid}: passed answer requires structuredAnswer")
            row["structuredAnswer"] = structured
        if pixel_decision == "reject" or answer_decision == "reject":
            reasons = source.get("reasons")
            if not isinstance(reasons, list) or not reasons:
                raise DecisionBuildError(f"{qid}: rejected question requires reasons")
            row["reasons"] = reasons
        rows.append(row)

    document = {
        "kind": "matha-owner-delegated-starter-direct-review", "version": 1,
        "reviewPolicy": "owner-delegated-agent-direct-pixel-v1",
        "releaseAuthority": False,
        "reviewedBy": spec.get("reviewedBy"), "reviewedAt": spec.get("reviewedAt"),
        "delegation": spec.get("delegation"),
        "exactInputs": {
            "candidateManifestSha256": sha256(candidate),
            "pixelTemplateSha256": sha256(pixel_template),
            "answerBindingSha256": sha256(binding),
            "answerTemplateSha256": sha256(answer_template),
        },
        "passAttestation": {
            "appliesToEveryPassedQuestion": True,
            "pixelChecks": {key: True for key in PIXEL_CHECKS},
            "answerChecks": {key: True for key in ANSWER_CHECKS},
        },
        "questions": rows,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"output": str(output), "questions": len(rows), "sha256": sha256(output)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--pixel-template", required=True, type=Path)
    parser.add_argument("--binding", required=True, type=Path)
    parser.add_argument("--answer-template", required=True, type=Path)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--spec", type=Path)
    source.add_argument("--prior-intersection", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = build(args.candidate, args.pixel_template, args.binding,
                       args.answer_template, args.spec, args.prior_intersection,
                       args.output)
    except (DecisionBuildError, OSError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=__import__("sys").stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
