#!/usr/bin/env python3
"""Build transcription sheets: stem + printed answer, side by side, batched.

These sheets exist so a vision model (or a human) can transcribe questions
*from the verified crops* instead of trusting line OCR — the same OCR that
reads 選擇 as 遥挥 and drops signs out of formulas.  Each sheet stacks a few
questions,每題 = id 標頭 + 題幹裁切 + 答案裁切(縮小、右側律定灰框), so one
look yields the stem text, the options and the printed answer together.

Output stays outside the repository like every other scan-derived file.

    python scripts/ingest/transcribe-sheets.py --work "<work>" --book <bookId> \
        [--per-sheet 4] [--start 0] [--count 40]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

SCHEMA_VERSION = 11
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SHEET_WIDTH = 1050
STEM_MAX_H = 560
ANSWER_MAX_H = 340


class SheetError(RuntimeError):
    """A fail-closed validation error."""


def ensure_outside_repo(path: Path) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return
    raise SheetError(f"Scan-derived output must stay outside the Git repository: {resolved}")


def scaled(image: Image.Image, width: int, max_h: int) -> Image.Image:
    ratio = width / image.width
    out = image.resize((width, max(1, int(image.height * ratio))), Image.LANCZOS)
    if out.height > max_h:
        out = out.crop((0, 0, width, max_h))
    return out


def build(work_root: Path, book_id: str, per_sheet: int, start: int, count: int) -> dict[str, Any]:
    ensure_outside_repo(work_root)
    book_dir = work_root / book_id
    pack = json.loads((book_dir / "questions.pending-review.json").read_text(encoding="utf-8"))
    if pack.get("schema") != SCHEMA_VERSION:
        raise SheetError("Question pack is from an older schema; re-run build-book-map.py")
    manifest = json.loads((book_dir / "crops-manifest.json").read_text(encoding="utf-8"))["crops"]

    lane = {"clean-candidate": 0, "needs-repair": 1}
    rows = sorted(pack["questions"], key=lambda q: (lane.get(q["qaLane"], 2), q["pdfPage"]))
    rows = [q for q in rows if (manifest.get(q["id"]) or {}).get("stemRegion")]
    batch = rows[start:start + count]

    out_dir = book_dir / "transcribe"
    out_dir.mkdir(parents=True, exist_ok=True)
    sheets: list[dict[str, Any]] = []

    for index in range(0, len(batch), per_sheet):
        group = batch[index:index + per_sheet]
        tiles: list[Image.Image] = []
        for question in group:
            crop_dir = book_dir / "crops" / question["id"]
            head = Image.new("RGB", (SHEET_WIDTH, 26), "#dcd6c8")
            ImageDraw.Draw(head).text(
                (6, 6),
                f"{question['id']}  [{question['role']}|{question['questionType']}"
                f"|{question['sourceDifficulty']}]  flags={','.join(question['flags'])[:60]}",
                fill="#111")
            tiles.append(head)
            tiles.append(scaled(Image.open(crop_dir / "stem.png").convert("RGB"),
                                SHEET_WIDTH, STEM_MAX_H))
            answer_path = crop_dir / "answer.png"
            if answer_path.is_file():
                bar = Image.new("RGB", (SHEET_WIDTH, 18), "#b44")
                ImageDraw.Draw(bar).text((6, 3), "printed answer:", fill="#fff")
                tiles.append(bar)
                tiles.append(scaled(Image.open(answer_path).convert("RGB"),
                                    SHEET_WIDTH, ANSWER_MAX_H))
        height = sum(tile.height + 4 for tile in tiles)
        sheet = Image.new("RGB", (SHEET_WIDTH, height), "white")
        y = 0
        for tile in tiles:
            sheet.paste(tile, (0, y))
            y += tile.height + 4
        number = start + index
        path = out_dir / f"sheet-{number:04d}.png"
        sheet.save(path)
        sheets.append({"sheet": str(path), "questionIds": [q["id"] for q in group]})

    listing = out_dir / f"sheets-{start:04d}.json"
    listing.write_text(json.dumps({"bookId": book_id, "start": start,
                                   "sheets": sheets}, ensure_ascii=False, indent=1),
                       encoding="utf-8")
    return {"bookId": book_id, "start": start, "questions": len(batch),
            "sheets": len(sheets), "listing": str(listing)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--book", required=True)
    parser.add_argument("--per-sheet", type=int, default=4)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--count", type=int, default=40)
    args = parser.parse_args(argv)
    try:
        result = build(args.work, args.book, args.per_sheet, args.start, args.count)
    except SheetError as error:
        print(f"transcribe-sheets: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
