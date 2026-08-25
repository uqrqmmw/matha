#!/usr/bin/env python3
"""Attach verified Google Document AI OCR as a non-destructive page-index alternate.

The original scan remains display truth. This script never replaces the local
OCR pass; it adds ``ocrAlternates.googleDocumentAi`` only after proving that
Google processed the exact page-image SHA-256 used by the page index.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any


class AttachError(RuntimeError):
    pass


def anchor_text(text: str, anchor: dict[str, Any] | None) -> str:
    chunks: list[str] = []
    for segment in (anchor or {}).get("textSegments", []):
        start = int(segment.get("startIndex", 0))
        end = int(segment.get("endIndex", start))
        if start < 0 or end < start or end > len(text):
            raise AttachError(f"Invalid Document AI text anchor: {start}:{end}/{len(text)}")
        chunks.append(text[start:end])
    return "".join(chunks).strip()


def bounding_box(poly: dict[str, Any], width: int, height: int) -> list[int]:
    vertices = poly.get("vertices") or []
    if vertices:
        xs = [int(round(float(point.get("x", 0)))) for point in vertices]
        ys = [int(round(float(point.get("y", 0)))) for point in vertices]
    else:
        vertices = poly.get("normalizedVertices") or []
        xs = [int(round(float(point.get("x", 0)) * width)) for point in vertices]
        ys = [int(round(float(point.get("y", 0)) * height)) for point in vertices]
    if not xs or not ys:
        raise AttachError("Document AI line has no bounding vertices")
    return [max(0, min(xs)), max(0, min(ys)), min(width, max(xs)), min(height, max(ys))]


def convert_response(response: dict[str, Any], page_index: dict[str, Any]) -> dict[str, Any]:
    source = response.get("_mathaSource") or {}
    if source.get("sha256") != page_index.get("imageSha256"):
        raise AttachError("Google source image SHA-256 does not match page index")
    pages = ((response.get("document") or {}).get("pages") or [])
    if len(pages) != 1:
        raise AttachError(f"Expected exactly one OCR page, got {len(pages)}")

    page = pages[0]
    width, height = int(page_index["width"]), int(page_index["height"])
    dimension = page.get("dimension") or {}
    if int(dimension.get("width", width)) != width or int(dimension.get("height", height)) != height:
        raise AttachError("Google page dimensions do not match page index")
    document_text = str((response.get("document") or {}).get("text") or "")

    lines = []
    for line in page.get("lines") or []:
        layout = line.get("layout") or {}
        value = anchor_text(document_text, layout.get("textAnchor"))
        if not value:
            continue
        lines.append({
            "bbox": bounding_box(layout.get("boundingPoly") or {}, width, height),
            "text": value,
            "score": round(float(layout.get("confidence", 0.0)), 4),
        })
    lines.sort(key=lambda row: (row["bbox"][1], row["bbox"][0]))

    math_elements = []
    for visual in page.get("visualElements") or []:
        if visual.get("type") != "math_formula":
            continue
        layout = visual.get("layout") or {}
        value = anchor_text(document_text, layout.get("textAnchor"))
        if not value:
            continue
        math_elements.append({
            "bbox": bounding_box(layout.get("boundingPoly") or {}, width, height),
            "latex": value,
            "score": round(float(layout.get("confidence", 0.0)), 4),
        })

    if document_text.strip() and not lines:
        raise AttachError("Document AI returned text but no line geometry")
    quality = (page.get("imageQualityScores") or {}).get("qualityScore")
    return {
        "engine": "google-document-ai-enterprise-ocr",
        "processor": source.get("processor"),
        "processedAt": source.get("processedAt"),
        "sourceSha256": source.get("sha256"),
        "qualityScore": round(float(quality), 4) if quality is not None else None,
        "textSha256": hashlib.sha256(document_text.encode("utf-8")).hexdigest(),
        "lines": lines,
        "mathElements": math_elements,
    }


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temp.replace(path)


def attach(book_dir: Path, google_dir: Path) -> dict[str, Any]:
    pages_dir = book_dir / "pages"
    if not pages_dir.is_dir() or not google_dir.is_dir():
        raise AttachError("Book pages or Google result directory does not exist")

    records = sorted(pages_dir.glob("p*.json"))
    if not records:
        raise AttachError("No page-index records found")
    attached = 0
    quality: list[float] = []
    formulas = 0
    for record_path in records:
        google_path = google_dir / f"{record_path.stem}.document-ai.json"
        if not google_path.is_file():
            raise AttachError(f"Missing Google result: {google_path.name}")
        record = json.loads(record_path.read_text(encoding="utf-8"))
        response = json.loads(google_path.read_text(encoding="utf-8"))
        converted = convert_response(response, record)
        record.setdefault("ocrAlternates", {})["googleDocumentAi"] = converted
        atomic_json(record_path, record)
        attached += 1
        if converted["qualityScore"] is not None:
            quality.append(converted["qualityScore"])
        formulas += len(converted["mathElements"])

    summary = {
        "schema": 1,
        "kind": "google-document-ai-attachment-summary",
        "pages": attached,
        "mathElements": formulas,
        "minQualityScore": min(quality) if quality else None,
        "meanQualityScore": round(sum(quality) / len(quality), 4) if quality else None,
    }
    atomic_json(book_dir / "google-document-ai-summary.json", summary)
    return summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--book-dir", required=True, type=Path)
    parser.add_argument("--google-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(attach(args.book_dir, args.google_dir), ensure_ascii=False, indent=2))
    except (AttachError, OSError, json.JSONDecodeError) as error:
        print(f"attach-google-document-ai: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
