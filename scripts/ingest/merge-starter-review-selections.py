#!/usr/bin/env python3
"""Merge hash-bound starter selection manifests without weakening review gates.

The output remains review-only.  Every source manifest is recorded with its
exact SHA-256 and duplicate question ids are rejected.  This is intentionally
small: release preparation still revalidates every selected item against its
dual-review intersection and original catalog PDF.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


KIND = "matha-cleaned-starter-review-selection"


class MergeSelectionError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise MergeSelectionError(f"selection does not exist: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(value, dict) or value.get("kind") != KIND
            or value.get("releaseAuthority") is not False
            or value.get("studentReady") is not False
            or not isinstance(value.get("items"), list)):
        raise MergeSelectionError(f"invalid review-only selection: {path}")
    return value


def merge(selection_files: list[Path], output: Path) -> dict[str, Any]:
    if len(selection_files) < 2:
        raise MergeSelectionError("at least two selection manifests are required")
    if output.exists():
        raise MergeSelectionError(f"output already exists: {output}")

    merged_from = []
    rows: dict[str, dict[str, Any]] = {}
    for source in selection_files:
        resolved = source.resolve()
        document = load(resolved)
        source_ids = []
        for row in document["items"]:
            question_id = row.get("id") if isinstance(row, dict) else None
            if not isinstance(question_id, str) or not question_id.strip():
                raise MergeSelectionError(f"selection has invalid question id: {resolved}")
            if question_id in rows:
                raise MergeSelectionError(f"question appears in multiple selections: {question_id}")
            rows[question_id] = row
            source_ids.append(question_id)
        merged_from.append({
            "path": str(resolved),
            "sha256": sha256(resolved),
            "count": len(source_ids),
            "questionIdsSha256": hashlib.sha256(
                "\n".join(sorted(source_ids)).encode("utf-8")
            ).hexdigest(),
        })

    result = {
        "schema": 1,
        "kind": KIND,
        "mergePolicy": "exact-hash-bound-disjoint-union-v1",
        "releaseAuthority": False,
        "studentReady": False,
        "humanPixelReviewRequired": True,
        "humanAnswerReviewRequired": True,
        "humanReleaseSignoffRequired": True,
        "mergedFrom": merged_from,
        "selected": len(rows),
        "items": [rows[question_id] for question_id in sorted(rows)],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"output": str(output.resolve()), "selected": len(rows), "sha256": sha256(output)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = merge(args.selection, args.output)
    except (MergeSelectionError, OSError, json.JSONDecodeError) as error:
        print(f"merge-starter-review-selections: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
