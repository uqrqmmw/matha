#!/usr/bin/env python3
"""Render private four-panel contact sheets for direct pixel review.

Each row keeps the exact question identity and shows original, cleaned,
removed-overlay, and official printed answer pixels.  This is a review aid;
the hash-bound manifests remain authoritative.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


class ContactSheetError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_items(path: Path) -> list[dict]:
    value = json.loads(path.read_text(encoding="utf-8"))
    rows = value.get("items") if isinstance(value, dict) else None
    if not isinstance(rows, list) or not rows:
        raise ContactSheetError("candidate manifest has no items")
    ids = [str(row.get("id") or "") for row in rows if isinstance(row, dict)]
    if len(ids) != len(rows) or len(set(ids)) != len(ids) or any(not item for item in ids):
        raise ContactSheetError("candidate manifest IDs are missing or duplicated")
    return rows


def render(manifest: Path, pixel_root: Path, answer_root: Path,
           output: Path, rows_per_sheet: int = 5) -> list[Path]:
    items = load_items(manifest)
    output.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default(size=20)
    small = ImageFont.load_default(size=16)
    panel_width, panel_height, label_height = 760, 560, 42
    columns = ("SOURCE", "CLEANED", "REMOVED", "ANSWER")
    paths: list[Path] = []
    sheets: list[dict] = []
    for sheet_index in range(0, len(items), rows_per_sheet):
        group = items[sheet_index:sheet_index + rows_per_sheet]
        canvas = Image.new("RGB", (panel_width * 4, label_height + len(group) * (panel_height + label_height)), "white")
        draw = ImageDraw.Draw(canvas)
        for column, title in enumerate(columns):
            draw.text((column * panel_width + 12, 10), title, fill="#2f312e", font=font)
        for row_index, item in enumerate(group):
            question_id = str(item["id"])
            asset_paths = (
                pixel_root / "assets" / question_id / "source.png",
                pixel_root / "assets" / question_id / "cleaned.png",
                pixel_root / "removed-overlays" / f"{question_id}.png",
                answer_root / "assets" / question_id / "answer.png",
            )
            top = label_height + row_index * (panel_height + label_height)
            draw.rectangle((0, top, canvas.width, top + label_height), fill="#ecebe6")
            draw.text((12, top + 10), question_id, fill="#252724", font=small)
            for column, asset in enumerate(asset_paths):
                if not asset.is_file():
                    raise ContactSheetError(f"missing review asset: {asset}")
                with Image.open(asset) as opened:
                    image = ImageOps.exif_transpose(opened).convert("RGB")
                    fitted = ImageOps.contain(image, (panel_width - 20, panel_height - 20), Image.Resampling.LANCZOS)
                left = column * panel_width + (panel_width - fitted.width) // 2
                image_top = top + label_height + (panel_height - fitted.height) // 2
                canvas.paste(fitted, (left, image_top))
                draw.rectangle(
                    (column * panel_width, top + label_height,
                     (column + 1) * panel_width - 1, top + label_height + panel_height - 1),
                    outline="#b8b6af", width=1,
                )
        number = sheet_index // rows_per_sheet + 1
        path = output / f"contact-{number:02d}.png"
        canvas.save(path, optimize=True)
        paths.append(path)
        sheets.append({
            "index": number,
            "file": path.name,
            "sha256": sha256(path),
            "questionIds": [str(item["id"]) for item in group],
        })
    bound_inputs = {
        "candidateManifestSha256": sha256(manifest),
        "pixelTemplateSha256": sha256(pixel_root / "cleaned-handwriting-human-review.template.json"),
        "answerBindingSha256": sha256(answer_root / "answer-binding-candidates.json"),
        "answerTemplateSha256": sha256(answer_root / "cleaned-answer-human-review.template.json"),
    }
    document = {
        "kind": "matha-owner-delegated-contact-sheets-v1",
        "version": 1,
        "releaseAuthority": False,
        "rowsPerSheet": rows_per_sheet,
        "questions": len(items),
        "inputs": bound_inputs,
        "sheets": sheets,
    }
    (output / "manifest.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return paths


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--pixel-root", required=True, type=Path)
    parser.add_argument("--answer-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--rows-per-sheet", type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.rows_per_sheet <= 8:
        raise SystemExit("rows-per-sheet must be 1..8")
    try:
        paths = render(args.manifest, args.pixel_root, args.answer_root, args.output, args.rows_per_sheet)
    except (ContactSheetError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"render-owner-delegated-contact-sheets: {error}")
        return 2
    print(json.dumps({"sheets": len(paths), "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
