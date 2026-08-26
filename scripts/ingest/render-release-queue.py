#!/usr/bin/env python3
"""Render a private release queue into compact stem/answer review sheets."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
WIDTH = 1500
STEM_WIDTH = 1040
ANSWER_WIDTH = WIDTH - STEM_WIDTH - 16


class RenderError(RuntimeError):
    pass


def outside_repo(path: Path) -> None:
    try:
        path.resolve().relative_to(REPO_ROOT)
    except ValueError:
        return
    raise RenderError(f"Private review output must stay outside Git: {path.resolve()}")


def fit(image: Image.Image, width: int, max_height: int) -> Image.Image:
    ratio = min(width / image.width, max_height / image.height)
    return image.resize((max(1, round(image.width * ratio)),
                         max(1, round(image.height * ratio))), Image.Resampling.LANCZOS)


def render(queue_path: Path, output: Path, per_sheet: int) -> dict:
    outside_repo(output)
    queue_bytes = queue_path.read_bytes()
    queue = json.loads(queue_bytes.decode("utf-8"))
    if queue.get("kind") != "textbook-on-demand-release-review-queue":
        raise RenderError("Expected a textbook on-demand release review queue")
    work = Path(queue["workRoot"])
    output.mkdir(parents=True, exist_ok=True)
    # A queue is regenerated as exclusions are discovered.  Never leave stale
    # numbered sheets behind: a reviewer could otherwise approve questions
    # that are no longer in the queue.
    for stale in output.glob("review-*.jpg"):
        stale.unlink()
    listing = output / "review-sheets.json"
    if listing.exists():
        listing.unlink()
    sheets = []
    items = queue.get("items") or []
    for offset in range(0, len(items), per_sheet):
        group = items[offset:offset + per_sheet]
        tiles = []
        for item in group:
            stem_path = work / item["stemCrop"]
            answer_path = work / item["answerCrop"]
            if not stem_path.is_file() or not answer_path.is_file():
                raise RenderError(f"Missing crop for {item['id']}")
            stem = fit(Image.open(stem_path).convert("RGB"), STEM_WIDTH, 620)
            answer = fit(Image.open(answer_path).convert("RGB"), ANSWER_WIDTH, 620)
            height = max(stem.height, answer.height) + 42
            tile = Image.new("RGB", (WIDTH, height), "white")
            draw = ImageDraw.Draw(tile)
            draw.rectangle((0, 0, WIDTH, 34), fill="#d8d1c5")
            draw.text((8, 9),
                      f"{item['id']} | {item['role']} | {item['sourceQuestionType']} | figures={item['figureCount']}",
                      fill="#171512")
            tile.paste(stem, (0, 40))
            draw.line((STEM_WIDTH + 7, 40, STEM_WIDTH + 7, height), fill="#a75f55", width=3)
            tile.paste(answer, (STEM_WIDTH + 16, 40))
            tiles.append(tile)
        canvas = Image.new("RGB", (WIDTH, sum(tile.height + 6 for tile in tiles)), "#eeeae3")
        y = 0
        for tile in tiles:
            canvas.paste(tile, (0, y))
            y += tile.height + 6
        path = output / f"review-{offset + 1:03d}-{offset + len(group):03d}.jpg"
        canvas.save(path, quality=90, optimize=True)
        sheets.append({"path": str(path), "questionIds": [item["id"] for item in group]})
    listing.write_text(json.dumps({
        "queue": str(queue_path.resolve()),
        "queueSha256": hashlib.sha256(queue_bytes).hexdigest(),
        "questionIds": [item["id"] for item in items],
        "sheets": sheets,
    },
                                  ensure_ascii=False, indent=1), encoding="utf-8")
    return {"items": len(items), "sheets": len(sheets), "listing": str(listing)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--per-sheet", type=int, default=3)
    args = parser.parse_args()
    try:
        if not 1 <= args.per_sheet <= 8:
            raise RenderError("per-sheet must be from 1 to 8")
        print(json.dumps(render(args.queue, args.out, args.per_sheet), ensure_ascii=False))
        return 0
    except (OSError, ValueError, RenderError) as error:
        print(f"render-release-queue: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
