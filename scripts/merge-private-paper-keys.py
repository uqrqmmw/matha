#!/usr/bin/env python3
"""Merge private official-paper keys into the existing Supabase env file.

The answer payload is never printed and must live outside the public repository.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


NAME = "PAPER_ANSWER_KEYS_JSON"


def validate(payload: object) -> dict[str, list[dict]]:
    if not isinstance(payload, dict) or not payload:
        raise ValueError("answer-key payload must be a non-empty object")
    for source_id, items in payload.items():
        if not isinstance(source_id, str) or not source_id.startswith("paper-"):
            raise ValueError("invalid paper source id")
        if not isinstance(items, list) or len(items) != 20:
            raise ValueError(f"{source_id}: expected exactly 20 questions")
        total = sum(float(item.get("points", 0)) for item in items if isinstance(item, dict))
        if total != 100:
            raise ValueError(f"{source_id}: expected 100 total points, got {total:g}")
        for item in items:
            if not isinstance(item, dict) or item.get("type") not in {"single", "multi", "fill", "constructed"}:
                raise ValueError(f"{source_id}: invalid answer-key item")
            if not isinstance(item.get("ans"), list) or not item["ans"]:
                raise ValueError(f"{source_id}: answer missing")
            if item["type"] == "constructed" and not item.get("rubric"):
                raise ValueError(f"{source_id}: constructed rubric missing")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--official-keys", required=True, type=Path)
    args = parser.parse_args()

    lines = args.env_file.read_text(encoding="utf-8").splitlines()
    prefix = f"{NAME}="
    indexes = [index for index, line in enumerate(lines) if line.startswith(prefix)]
    if len(indexes) != 1:
        raise ValueError(f"expected exactly one {NAME} entry")
    existing = validate(json.loads(lines[indexes[0]][len(prefix):]))
    if "paper-mock-3" not in existing:
        raise ValueError("refusing to overwrite secret without existing paper-mock-3")
    additions = validate(json.loads(args.official_keys.read_text(encoding="utf-8")))
    overlap = set(existing) & set(additions)
    if overlap:
        raise ValueError(f"refusing duplicate source ids: {sorted(overlap)}")
    merged = {**existing, **additions}
    lines[indexes[0]] = prefix + json.dumps(merged, ensure_ascii=False, separators=(",", ":"))

    temporary = args.env_file.with_suffix(args.env_file.suffix + ".tmp")
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(temporary, args.env_file)
    print(f"merged {len(additions)} official papers; secret now contains {len(merged)} papers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
