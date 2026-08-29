#!/usr/bin/env python3
"""Verify every starter-bank review packet against its exact batch manifest.

The validator is deliberately offline and fail-closed.  It checks the two
human-review packets, their copied pixels, and all manifest hashes; it never
publishes questions or changes a review decision.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


class PacketValidationError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PacketValidationError(f"cannot read {path}: {error}") from error
    if not isinstance(value, dict):
        raise PacketValidationError(f"expected JSON object: {path}")
    return value


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PacketValidationError(message)


def keyed(rows: Any, label: str) -> dict[str, dict[str, Any]]:
    require(isinstance(rows, list), f"{label} must be a list")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get("id"), str),
                f"{label} contains an invalid row")
        question_id = row["id"]
        require(question_id not in result, f"duplicate {label} id: {question_id}")
        result[question_id] = row
    return result


def require_hash(path: Path, expected: Any, label: str) -> None:
    require(isinstance(expected, str) and len(expected) == 64,
            f"missing {label} hash for {path}")
    require(path.is_file(), f"missing {label}: {path}")
    actual = sha256(path)
    require(actual == expected,
            f"{label} hash drift: {path} expected {expected}, got {actual}")


def validate_batch(batch_manifest: Path, pixel_dir: Path,
                   answer_dir: Path) -> dict[str, Any]:
    batch = load_json(batch_manifest)
    require(batch.get("releaseAuthority") is False,
            f"batch must remain releaseAuthority:false: {batch_manifest}")
    batch_rows = keyed(batch.get("items"), "batch items")
    require(batch.get("questions") == len(batch_rows),
            f"batch count mismatch: {batch_manifest}")
    batch_hash = sha256(batch_manifest)

    pixel_packet = load_json(pixel_dir / "review-packet.json")
    pixel_template = load_json(
        pixel_dir / "cleaned-handwriting-human-review.template.json")
    for document, label in ((pixel_packet, "pixel packet"),
                            (pixel_template, "pixel template")):
        require(document.get("releaseAuthority") is False,
                f"{label} must remain releaseAuthority:false: {pixel_dir}")
        require(document.get("candidateManifestSha256") == batch_hash,
                f"{label} batch hash mismatch: {pixel_dir}")
    pixel_rows = keyed(pixel_template.get("questions"), "pixel questions")
    require(set(pixel_rows) == set(batch_rows),
            f"pixel packet id set mismatch: {pixel_dir}")
    require(pixel_packet.get("questions") == len(batch_rows),
            f"pixel packet count mismatch: {pixel_dir}")

    for question_id, review_row in pixel_rows.items():
        source_row = batch_rows[question_id]
        require(review_row.get("sourceSha256") == source_row.get("sourceSha256"),
                f"pixel source binding mismatch: {question_id}")
        require(review_row.get("cleanedSha256") == source_row.get("cleanedSha256"),
                f"pixel cleaned binding mismatch: {question_id}")
        require_hash(pixel_dir / "assets" / question_id / "source.png",
                     review_row.get("sourceSha256"), "pixel source")
        require_hash(pixel_dir / "assets" / question_id / "cleaned.png",
                     review_row.get("cleanedSha256"), "pixel cleaned")
        require_hash(pixel_dir / "removed-overlays" / f"{question_id}.png",
                     review_row.get("removedOverlaySha256"), "removed overlay")

    answer_packet = load_json(answer_dir / "review-packet.json")
    answer_binding = load_json(answer_dir / "answer-binding-candidates.json")
    answer_template = load_json(
        answer_dir / "cleaned-answer-human-review.template.json")
    for document, label in ((answer_packet, "answer packet"),
                            (answer_binding, "answer binding"),
                            (answer_template, "answer template")):
        require(document.get("releaseAuthority") is False,
                f"{label} must remain releaseAuthority:false: {answer_dir}")
    require(answer_binding.get("candidateManifestSha256") == batch_hash,
            f"answer packet batch hash mismatch: {answer_dir}")
    require(answer_packet.get("total") == len(batch_rows),
            f"answer packet count mismatch: {answer_dir}")
    require(answer_packet.get("reviewable") == len(batch_rows),
            f"answer packet has non-reviewable starter items: {answer_dir}")
    require(answer_packet.get("quarantined") == 0,
            f"answer packet unexpectedly quarantined items: {answer_dir}")

    binding_rows = keyed(answer_binding.get("items"), "answer bindings")
    answer_rows = keyed(answer_template.get("questions"), "answer questions")
    require(set(binding_rows) == set(batch_rows),
            f"answer binding id set mismatch: {answer_dir}")
    require(set(answer_rows) == set(batch_rows),
            f"answer template id set mismatch: {answer_dir}")

    for question_id, binding in binding_rows.items():
        source_row = batch_rows[question_id]
        require(binding.get("sourceSha256") == source_row.get("sourceSha256"),
                f"answer source binding mismatch: {question_id}")
        require(binding.get("cleanedSha256") == source_row.get("cleanedSha256"),
                f"answer cleaned binding mismatch: {question_id}")
        review_row = answer_rows[question_id]
        require(review_row.get("cleanedSha256") == binding.get("cleanedSha256")
                and review_row.get("answerSha256") == binding.get("answerSha256")
                and review_row.get("sourcePdfSha256") == binding.get("sourcePdfSha256"),
                f"answer review binding mismatch: {question_id}")
        require_hash(answer_dir / "assets" / question_id / "question.png",
                     binding.get("cleanedSha256"), "answer question")
        require_hash(answer_dir / "assets" / question_id / "answer.png",
                     binding.get("answerSha256"), "official answer")

    return {"batch": batch_manifest.stem, "questions": len(batch_rows)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue-root", required=True, type=Path)
    parser.add_argument("--packets-root", required=True, type=Path)
    parser.add_argument("--series", default="matha-starter-v4")
    parser.add_argument("--date", default="20260829")
    args = parser.parse_args()

    manifests = sorted(args.queue_root.glob("batch-*-cleaned-candidates.json"))
    require(bool(manifests), f"no batch manifests found under {args.queue_root}")
    results = []
    for manifest in manifests:
        match = re.fullmatch(r"batch-(\d+)-cleaned-candidates\.json", manifest.name)
        require(match is not None, f"unexpected batch filename: {manifest.name}")
        batch_number = match.group(1)
        pixel_dir = args.packets_root / (
            f"{args.series}-batch-{batch_number}-pixel-{args.date}")
        answer_dir = args.packets_root / (
            f"{args.series}-batch-{batch_number}-answer-{args.date}")
        results.append(validate_batch(manifest, pixel_dir, answer_dir))

    output = {
        "kind": "starter-review-packet-validation",
        "releaseAuthority": False,
        "batches": len(results),
        "questions": sum(row["questions"] for row in results),
        "results": results,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PacketValidationError as error:
        print(f"validate-starter-review-packets: {error}", file=sys.stderr)
        raise SystemExit(1)
