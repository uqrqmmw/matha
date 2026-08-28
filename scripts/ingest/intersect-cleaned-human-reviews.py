#!/usr/bin/env python3
"""Validate two completed human reviews and build a fail-closed intersection.

This command is deliberately not a publisher. It accepts only complete,
hash-bound handwriting-pixel and answer/mathematics reviews made by named
humans. A question is staged only when both reviews pass. The resulting
manifest still has ``releaseAuthority:false`` and therefore cannot be loaded
by the student app without a separate final human release signature and the
private-asset deployment step.
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
NON_HUMAN = re.compile(
    r"claude|codex|chatgpt|gpt|gemini|agent|bot|automation|自動|模型|人工智慧|\bai\b",
    re.I,
)
PIXEL_CHECKS = (
    "printedContentIntact",
    "allHandwritingRemoved",
    "noAnswerOrSolutionLeak",
    "fullQuestionAndOptions",
    "figuresAndGreyLinesIntact",
    "chineseTextIntact",
    "mathSymbolsAndFormulasIntact",
)
ANSWER_CHECKS = (
    "questionAnswerIdentityVerified",
    "allSubpartsCovered",
    "answerLegible",
    "noAdjacentAnswerConfusion",
    "figureConditionsHandled",
    "mathematicallyCorrect",
)


class DualReviewError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise DualReviewError(f"{label} does not exist: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise DualReviewError(f"{label} must be a JSON object")
    return value


def unique_rows(rows: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(rows, list):
        raise DualReviewError(f"{label} must be a list")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            raise DualReviewError(f"{label} contains an invalid id")
        if row["id"] in result:
            raise DualReviewError(f"{label} contains duplicate id: {row['id']}")
        result[row["id"]] = row
    return result


def require_named_human(review: dict[str, Any], label: str) -> tuple[str, str]:
    reviewer = review.get("reviewer")
    if not isinstance(reviewer, str) or len(reviewer.strip()) < 3 or NON_HUMAN.search(reviewer):
        raise DualReviewError(f"{label} reviewer must be an identifiable human")
    reviewed_at = review.get("reviewedAt")
    if not isinstance(reviewed_at, str):
        raise DualReviewError(f"{label} reviewedAt is missing")
    try:
        parsed = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise DualReviewError(f"{label} reviewedAt is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DualReviewError(f"{label} reviewedAt must include a timezone")
    return reviewer.strip(), reviewed_at


def validate_review_header(
    review: dict[str, Any], *, kind: str, candidate_hash: str, label: str
) -> tuple[str, str]:
    if review.get("kind") != kind or review.get("version") != 1:
        raise DualReviewError(f"{label} has an unsupported kind or version")
    if review.get("releaseAuthority") is not False:
        raise DualReviewError(f"{label} must remain releaseAuthority:false")
    if review.get("humanReviewerRequired") is not True:
        raise DualReviewError(f"{label} does not require a human reviewer")
    if review.get("candidateManifestSha256") != candidate_hash:
        raise DualReviewError(f"{label} candidate manifest hash mismatch")
    return require_named_human(review, label)


def validate_complete_review(
    review: dict[str, Any], expected: dict[str, dict[str, Any]], checks: tuple[str, ...],
    bindings: tuple[str, ...], label: str,
) -> dict[str, dict[str, Any]]:
    rows = unique_rows(review.get("questions"), f"{label} questions")
    if set(rows) != set(expected):
        missing = sorted(set(expected) - set(rows))[:3]
        extra = sorted(set(rows) - set(expected))[:3]
        raise DualReviewError(f"{label} coverage mismatch; missing={missing}, extra={extra}")
    passed = rejected = 0
    for qid, row in rows.items():
        source = expected[qid]
        for field in bindings:
            if row.get(field) != source.get(field):
                raise DualReviewError(f"{label} {qid}: {field} hash mismatch")
        decision = row.get("decision")
        if decision not in {"pass", "reject"}:
            raise DualReviewError(f"{label} {qid}: review is incomplete")
        visual = row.get("visual")
        if decision == "pass":
            if not isinstance(visual, dict) or any(visual.get(key) is not True for key in checks):
                raise DualReviewError(f"{label} {qid}: a passed review has unchecked gates")
            passed += 1
        else:
            rejected += 1
    summary = review.get("summary")
    expected_summary = {"passed": passed, "rejected": rejected, "unreviewed": 0}
    if summary != expected_summary:
        raise DualReviewError(f"{label} summary does not match its decisions")
    return rows


def validate_overlay_assets(
    template: dict[str, Any], review_rows: dict[str, dict[str, Any]], root: Path,
    candidate_hash: str,
) -> None:
    if (template.get("kind") != "matha-private-cleaned-handwriting-human-review"
            or template.get("version") != 1
            or template.get("releaseAuthority") is not False
            or template.get("candidateManifestSha256") != candidate_hash):
        raise DualReviewError("pixel review template header mismatch")
    template_rows = unique_rows(template.get("questions"), "pixel review template questions")
    if set(template_rows) != set(review_rows):
        raise DualReviewError("pixel review template coverage mismatch")
    for qid, row in review_rows.items():
        expected = template_rows[qid].get("removedOverlaySha256")
        if row.get("removedOverlaySha256") != expected:
            raise DualReviewError(f"pixel review {qid}: removed overlay binding mismatch")
        overlay = root / "removed-overlays" / f"{qid}.png"
        if not overlay.is_file() or sha256(overlay) != expected:
            raise DualReviewError(f"pixel review {qid}: removed overlay asset hash mismatch")
        source = root / "assets" / qid / "source.png"
        cleaned = root / "assets" / qid / "cleaned.png"
        if not source.is_file() or sha256(source) != row.get("sourceSha256"):
            raise DualReviewError(f"pixel review {qid}: source asset hash mismatch")
        if not cleaned.is_file() or sha256(cleaned) != row.get("cleanedSha256"):
            raise DualReviewError(f"pixel review {qid}: cleaned asset hash mismatch")


def validate_candidate_assets(items: dict[str, dict[str, Any]]) -> None:
    for qid, item in items.items():
        for field, hash_field in (
            ("source", "sourceSha256"), ("cleaned", "cleanedSha256")
        ):
            path = item.get(field)
            expected = item.get(hash_field)
            if not isinstance(path, str) or not isinstance(expected, str):
                raise DualReviewError(f"candidate {qid}: {field} asset binding missing")
            asset = Path(path)
            if not asset.is_file() or sha256(asset) != expected:
                raise DualReviewError(f"candidate {qid}: {field} asset hash mismatch")


def validate_answer_packet_assets(
    items: dict[str, dict[str, Any]], candidates: dict[str, dict[str, Any]], packet_root: Path
) -> None:
    for qid, item in items.items():
        question = packet_root / "assets" / qid / "question.png"
        answer = packet_root / "assets" / qid / "answer.png"
        if (not question.is_file()
                or sha256(question) != item.get("cleanedSha256")):
            raise DualReviewError(f"answer binding {qid}: question asset hash mismatch")
        if not answer.is_file() or sha256(answer) != item.get("answerSha256"):
            raise DualReviewError(f"answer binding {qid}: answer asset hash mismatch")
        figure_count = item.get("figureCount")
        figure_hashes = item.get("figureSha256")
        if (not isinstance(figure_count, int) or figure_count < 0
                or not isinstance(figure_hashes, list)
                or len(figure_hashes) != figure_count):
            raise DualReviewError(f"answer binding {qid}: figure binding invalid")
        source_path = candidates[qid].get("source")
        if not isinstance(source_path, str):
            raise DualReviewError(f"answer binding {qid}: source path missing")
        crop_dir = Path(source_path).parent
        for number, expected in enumerate(figure_hashes, 1):
            figure = crop_dir / f"figure-{number}.png"
            if not figure.is_file() or sha256(figure) != expected:
                raise DualReviewError(f"answer binding {qid}: figure asset hash mismatch")


def intersect(
    candidate_manifest: Path,
    pixel_template_path: Path,
    pixel_review_path: Path,
    answer_binding_path: Path,
    answer_review_path: Path,
    output: Path,
) -> dict[str, Any]:
    output = output.resolve()
    try:
        output.relative_to(REPO_ROOT.resolve())
    except ValueError:
        pass
    else:
        raise DualReviewError("dual-review output must stay outside the Git repository")
    if output.exists():
        raise DualReviewError("refusing to overwrite an existing output")

    candidate = read_json(candidate_manifest, "candidate manifest")
    if (candidate.get("kind") != "cleaned-page-question-candidates"
            or candidate.get("releaseAuthority") is not False
            or candidate.get("humanPixelReviewRequired") is not True):
        raise DualReviewError("candidate manifest is not a review-only cleaned candidate set")
    candidate_rows = unique_rows(candidate.get("items"), "candidate items")
    candidate_hash = sha256(candidate_manifest)
    validate_candidate_assets(candidate_rows)

    pixel_template = read_json(pixel_template_path, "pixel review template")
    pixel_review = read_json(pixel_review_path, "pixel review")
    pixel_reviewer, pixel_reviewed_at = validate_review_header(
        pixel_review,
        kind="matha-private-cleaned-handwriting-human-review",
        candidate_hash=candidate_hash,
        label="pixel review",
    )
    for field in ("pageCleanupManifestSha256", "fallbackCleanupManifestSha256"):
        if pixel_review.get(field) != candidate.get(
            "cleanupManifestSha256" if field == "pageCleanupManifestSha256"
            else "fallbackCleanupManifestSha256"
        ):
            raise DualReviewError(f"pixel review {field} mismatch")
    pixel_template_rows = unique_rows(
        pixel_template.get("questions"), "pixel review template questions"
    )
    pixel_expected = {
        qid: {
            "sourceSha256": row.get("sourceSha256"),
            "cleanedSha256": row.get("cleanedSha256"),
            "removedOverlaySha256": pixel_template_rows.get(qid, {}).get(
                "removedOverlaySha256"
            ),
        }
        for qid, row in candidate_rows.items()
    }
    pixel_rows = validate_complete_review(
        pixel_review, pixel_expected, PIXEL_CHECKS,
        ("sourceSha256", "cleanedSha256", "removedOverlaySha256"), "pixel review",
    )
    validate_overlay_assets(
        pixel_template, pixel_rows, pixel_template_path.resolve().parent, candidate_hash
    )

    binding = read_json(answer_binding_path, "answer binding")
    if (binding.get("kind") != "cleaned-answer-binding-candidates"
            or binding.get("version") != 1
            or binding.get("releaseAuthority") is not False
            or binding.get("humanAnswerReviewRequired") is not True
            or binding.get("handwritingPixelReviewAlsoRequired") is not True
            or binding.get("candidateManifestSha256") != candidate_hash):
        raise DualReviewError("answer binding header mismatch")
    binding_rows = unique_rows(binding.get("items"), "answer binding items")
    quarantined_rows = unique_rows(binding.get("quarantined"), "answer binding quarantine")
    if set(binding_rows) & set(quarantined_rows):
        raise DualReviewError("answer binding has an id in both reviewable and quarantine lists")
    if (binding.get("total") != len(candidate_rows)
            or binding.get("reviewableCount") != len(binding_rows)
            or binding.get("quarantinedCount") != len(quarantined_rows)
            or set(binding_rows) | set(quarantined_rows) != set(candidate_rows)):
        raise DualReviewError("answer binding counts or candidate coverage mismatch")
    for qid, row in binding_rows.items():
        candidate_row = candidate_rows[qid]
        if (row.get("cleanedSha256") != candidate_row.get("cleanedSha256")
                or row.get("sourceSha256") != candidate_row.get("sourceSha256")):
            raise DualReviewError(f"answer binding {qid}: question hash mismatch")
    validate_answer_packet_assets(
        binding_rows, candidate_rows, answer_binding_path.resolve().parent
    )

    binding_hash = sha256(answer_binding_path)
    answer_review = read_json(answer_review_path, "answer review")
    answer_reviewer, answer_reviewed_at = validate_review_header(
        answer_review,
        kind="matha-private-cleaned-answer-human-review",
        candidate_hash=candidate_hash,
        label="answer review",
    )
    if answer_review.get("answerBindingSha256") != binding_hash:
        raise DualReviewError("answer review binding manifest hash mismatch")
    answer_rows = validate_complete_review(
        answer_review, binding_rows, ANSWER_CHECKS,
        ("cleanedSha256", "answerSha256", "sourcePdfSha256"), "answer review",
    )

    pixel_passed = {qid for qid, row in pixel_rows.items() if row["decision"] == "pass"}
    answer_passed = {qid for qid, row in answer_rows.items() if row["decision"] == "pass"}
    eligible = sorted(pixel_passed & answer_passed & set(binding_rows))
    excluded = []
    for qid in sorted(candidate_rows):
        reasons = []
        if qid in quarantined_rows:
            reasons.append(str(quarantined_rows[qid].get("reason") or "answer-binding-quarantined"))
        if qid not in pixel_passed:
            reasons.append("pixel-review-rejected")
        if qid in binding_rows and qid not in answer_passed:
            reasons.append("answer-review-rejected")
        if not reasons:
            continue
        excluded.append({"id": qid, "reasons": reasons})

    items = []
    for qid in eligible:
        source = candidate_rows[qid]
        answer = binding_rows[qid]
        items.append({
            "id": qid,
            "bookId": answer.get("bookId"),
            "chapter": answer.get("chapter"),
            "role": answer.get("role"),
            "questionType": answer.get("questionType"),
            "pdfPage": answer.get("pdfPage"),
            "stemRegion": source.get("stemRegion"),
            "cleaned": source.get("cleaned"),
            "cleanedSha256": source.get("cleanedSha256"),
            "answerPdfPage": answer.get("answerPdfPage"),
            "answerRegion": answer.get("answerRegion"),
            "answerSource": answer.get("answerSource"),
            "answerSha256": answer.get("answerSha256"),
            "sourcePdfSha256": answer.get("sourcePdfSha256"),
            "figureCount": answer.get("figureCount"),
            "figureSha256": answer.get("figureSha256"),
        })

    document = {
        "kind": "matha-private-cleaned-dual-review-candidates",
        "version": 1,
        "releaseAuthority": False,
        "humanReleaseSignoffStillRequired": True,
        "privateAssetDeploymentStillRequired": True,
        "uploadPerformed": False,
        "candidateManifestSha256": candidate_hash,
        "pixelReviewTemplateSha256": sha256(pixel_template_path),
        "pixelReviewSha256": sha256(pixel_review_path),
        "answerBindingSha256": binding_hash,
        "answerReviewSha256": sha256(answer_review_path),
        "pixelReviewer": pixel_reviewer,
        "pixelReviewedAt": pixel_reviewed_at,
        "answerReviewer": answer_reviewer,
        "answerReviewedAt": answer_reviewed_at,
        "counts": {
            "totalCandidates": len(candidate_rows),
            "pixelPassed": len(pixel_passed),
            "answerReviewable": len(binding_rows),
            "answerPassed": len(answer_passed),
            "eligibleAfterBothReviews": len(items),
            "excluded": len(excluded),
        },
        "quarantine": excluded,
        "items": items,
        "nextGate": (
            "A separate identifiable human must verify this exact manifest hash, sign the "
            "private release, and deploy the hash-bound private assets."
        ),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--pixel-template", type=Path, required=True)
    parser.add_argument("--pixel-review", type=Path, required=True)
    parser.add_argument("--answer-binding", type=Path, required=True)
    parser.add_argument("--answer-review", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = intersect(
            args.candidate_manifest, args.pixel_template, args.pixel_review,
            args.answer_binding, args.answer_review, args.out,
        )
    except (DualReviewError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"intersect-cleaned-human-reviews: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result["counts"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
