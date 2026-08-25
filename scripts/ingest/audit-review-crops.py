#!/usr/bin/env python3
"""Fail-closed structural audit for review-only textbook crops.

This does not claim that an answer is mathematically correct.  It verifies
that every candidate has exactly the files declared by the current manifest,
that the PNGs are readable, and that stale or duplicate crops cannot masquerade
as current questions.  Mathematical/semantic approval remains a separate
human-or-vision review of the original question and official-answer pixels.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from PIL import Image


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def inspect_png(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        if image.format != "PNG":
            raise ValueError(f"not-png:{image.format}")
        size = image.size
        image.verify()
    return size


def audit(book_dir: Path, variant: str | None = None) -> dict[str, Any]:
    suffix = f".{variant}" if variant else ""
    pack_path = book_dir / f"questions.pending-review{suffix}.json"
    manifest_path = book_dir / f"crops-manifest{suffix}.json"
    crops_root = book_dir / f"crops{suffix}"
    if not pack_path.is_file() or not manifest_path.is_file() or not crops_root.is_dir():
        raise FileNotFoundError("question pack, crop manifest, and crop directory are all required")

    pack = json.loads(pack_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    questions = pack.get("questions") or []
    manifest_rows = manifest.get("crops") or {}
    ids = [question.get("id") for question in questions]
    errors: list[Any] = []
    warnings: list[Any] = []

    if None in ids or len(ids) != len(set(ids)):
        errors.append("missing-or-duplicate-question-id")
    if pack.get("pdfSha256") != manifest.get("pdfSha256"):
        errors.append("pdf-sha-mismatch")
    if set(ids) != set(manifest_rows):
        errors.append({
            "manifest-id-set-mismatch": {
                "missing": sorted(set(ids) - set(manifest_rows)),
                "extra": sorted(set(manifest_rows) - set(ids)),
            }
        })

    expected_dirs = {question_id for question_id, row in manifest_rows.items() if row.get("stemRegion")}
    actual_dirs = {path.name for path in crops_root.iterdir() if path.is_dir()}
    if expected_dirs != actual_dirs:
        errors.append({
            "crop-dir-set-mismatch": {
                "missing": sorted(expected_dirs - actual_dirs),
                "stale": sorted(actual_dirs - expected_dirs),
            }
        })

    hashes: dict[str, dict[str, list[str]]] = {
        kind: collections.defaultdict(list) for kind in ("stem", "answer", "figure")
    }
    minimums = {kind: [sys.maxsize, sys.maxsize] for kind in hashes}
    counts = {kind: 0 for kind in hashes}

    for question in questions:
        question_id = question.get("id")
        row = manifest_rows.get(question_id) or {}
        folder = crops_root / str(question_id)
        if row.get("refused"):
            errors.append({question_id: row["refused"]})
            continue
        expected: list[tuple[str, Path]] = [("stem", folder / "stem.png")]
        expected.extend(
            ("figure", folder / f"figure-{order}.png")
            for order in range(1, int(row.get("figures", 0)) + 1)
        )
        if row.get("answer"):
            expected.append(("answer", folder / "answer.png"))

        for kind, path in expected:
            if not path.is_file() or path.stat().st_size < 100:
                errors.append({question_id: f"missing-or-empty-{path.name}"})
                continue
            try:
                width, height = inspect_png(path)
            except Exception as error:  # Pillow raises several format-specific errors.
                errors.append({question_id: f"invalid-{path.name}:{error}"})
                continue
            if width < 20 or height < 20:
                errors.append({question_id: f"tiny-{path.name}:{width}x{height}"})
            minimums[kind][0] = min(minimums[kind][0], width)
            minimums[kind][1] = min(minimums[kind][1], height)
            hashes[kind][digest(path)].append(str(question_id))
            counts[kind] += 1

        stem_path = folder / "stem.png"
        answer_path = folder / "answer.png"
        if stem_path.is_file() and answer_path.is_file() and digest(stem_path) == digest(answer_path):
            errors.append({question_id: "stem-identical-to-answer"})

    duplicate_stems = [group for group in hashes["stem"].values() if len(group) > 1]
    duplicate_answers = [group for group in hashes["answer"].values() if len(group) > 1]
    if duplicate_stems:
        errors.append({"duplicate-stem-sha": duplicate_stems})
    if duplicate_answers:
        warnings.append({"duplicate-answer-sha": duplicate_answers})

    for kind, dimensions in minimums.items():
        if dimensions[0] == sys.maxsize:
            minimums[kind] = [0, 0]

    return {
        "kind": "textbook-crop-structural-audit",
        "structuralOnly": True,
        "mathematicalCorrectnessVerified": False,
        "questions": len(ids),
        "manifestEntries": len(manifest_rows),
        "cropDirs": len(actual_dirs),
        "stemFiles": counts["stem"],
        "answerFiles": counts["answer"],
        "figureFiles": counts["figure"],
        "minDimensions": minimums,
        "duplicateStemGroups": len(duplicate_stems),
        "duplicateAnswerGroups": len(duplicate_answers),
        "errors": errors,
        "warnings": warnings,
        "passed": not errors,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--variant", default=None)
    args = parser.parse_args(argv)
    book_dir = args.work / args.book
    try:
        result = audit(book_dir, args.variant)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"audit-review-crops: {error}", file=sys.stderr)
        return 2
    suffix = f".{args.variant}" if args.variant else ""
    output_path = book_dir / f"crop-audit{suffix}.json"
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
