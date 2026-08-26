#!/usr/bin/env python3
"""Audit every Mistral-derived page index against its raw OCR response."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "matha_index_mistral_pages", SCRIPT_DIR / "index-mistral-pages.py")
mistral = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(mistral)


class AuditError(RuntimeError):
    """A corpus invariant failed."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AuditError(message)


def audit(work_root: Path, ocr_root: Path, catalog_file: Path,
          expected_documents: int = 25, expected_pages: int = 6720) -> dict[str, Any]:
    mistral.indexer.ensure_outside_repo(work_root)
    mistral.indexer.ensure_outside_repo(ocr_root)
    books = mistral.catalog_books(catalog_file)
    require(len(books) == expected_documents,
            f"Catalog has {len(books)} documents, expected {expected_documents}")
    totals = {"documents": 0, "pages": 0, "ocrLines": 0, "imageRegions": 0}
    rows: list[dict[str, Any]] = []
    for book_id, pdf_hash in sorted(books.items()):
        book_dir = work_root / book_id
        summary_file = book_dir / "index-summary.json"
        require(summary_file.is_file(), f"Missing summary for {book_id}")
        summary = mistral.read_json(summary_file)
        page_count = summary.get("pageCount")
        require(isinstance(page_count, int) and page_count > 0,
                f"Invalid page count for {book_id}")
        require(summary.get("indexedPages") == page_count,
                f"Partial index for {book_id}")
        require(summary.get("pdfSha256") == pdf_hash,
                f"Summary/catalog PDF hash mismatch for {book_id}")
        require(summary.get("ocrProvider") == "mistral"
                and summary.get("ocrModel") == mistral.MISTRAL_MODEL,
                f"Untrusted summary OCR provider/model for {book_id}")
        page_files = sorted((book_dir / "pages").glob("p*.json"))
        raw_dir = ocr_root / "outputs" / "pages" / pdf_hash[:16]
        raw_files = sorted(raw_dir.glob("*.json"))
        require(len(page_files) == page_count and len(raw_files) == page_count,
                f"Page/index count mismatch for {book_id}")
        book_lines = book_images = 0
        for number in range(1, page_count + 1):
            record_file = book_dir / "pages" / f"p{number:04d}.json"
            raw_file = raw_dir / f"{number:04d}.json"
            require(record_file.is_file() and raw_file.is_file(),
                    f"Non-contiguous page set for {book_id} page {number}")
            record = mistral.read_json(record_file)
            raw = mistral.read_json(raw_file)
            require(record.get("schema") == mistral.SCHEMA_VERSION
                    and record.get("mistralIndexVersion") == mistral.INDEX_VERSION,
                    f"Stale page index for {book_id} page {number}")
            require(record.get("bookId") == book_id and record.get("pdfSha256") == pdf_hash
                    and record.get("pdfPage") == number,
                    f"Page provenance mismatch for {book_id} page {number}")
            require(record.get("ocrProvider") == "mistral"
                    and record.get("ocrEngine") == mistral.MISTRAL_MODEL,
                    f"Untrusted page OCR provider/model for {book_id} page {number}")
            require(record.get("ocrSourceSha256") == mistral.sha256(raw_file),
                    f"Raw OCR response changed for {book_id} page {number}")
            require(raw.get("sourceSha256") == pdf_hash
                    and raw.get("sourcePageNumber") == number
                    and raw.get("sourcePageIndex") == number - 1
                    and raw.get("model") == mistral.MISTRAL_MODEL,
                    f"Raw OCR provenance mismatch for {book_id} page {number}")
            require(record.get("displayTruth") == "original-pdf-crop"
                    and record.get("ocrIsIndexOnly") is True,
                    f"OCR escaped the index-only boundary for {book_id} page {number}")
            height = record.get("height")
            layout = record.get("layout") or {}
            require(isinstance(height, int) and height > 0
                    and len(layout.get("inkRows") or []) == height
                    and len(layout.get("solidRows") or []) == height,
                    f"Layout row arrays are invalid for {book_id} page {number}")
            require(isinstance(record.get("ocr"), list)
                    and isinstance(layout.get("mistralImageRegions"), list),
                    f"OCR/layout arrays are invalid for {book_id} page {number}")
            book_lines += len(record["ocr"])
            book_images += len(layout["mistralImageRegions"])
        totals["documents"] += 1
        totals["pages"] += page_count
        totals["ocrLines"] += book_lines
        totals["imageRegions"] += book_images
        rows.append({"bookId": book_id, "pages": page_count,
                     "ocrLines": book_lines, "imageRegions": book_images})
    require(totals["pages"] == expected_pages,
            f"Corpus has {totals['pages']} pages, expected {expected_pages}")
    temporary = list(work_root.rglob("*.tmp"))
    require(not temporary, f"Corpus contains {len(temporary)} incomplete temporary file(s)")
    return {"kind": "matha-mistral-page-index-audit", "schema": 1,
            "passed": True, "expectedDocuments": expected_documents,
            "expectedPages": expected_pages, "totals": totals, "books": rows}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--ocr-root", required=True, type=Path)
    parser.add_argument("--catalog", type=Path, default=mistral.indexer.REPO_ROOT / "textbook-catalog.js")
    parser.add_argument("--expected-documents", type=int, default=25)
    parser.add_argument("--expected-pages", type=int, default=6720)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        result = audit(args.work, args.ocr_root, args.catalog,
                       args.expected_documents, args.expected_pages)
        if args.out:
            mistral.indexer.ensure_outside_repo(args.out)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            mistral.atomic_json(args.out, result)
    except (AuditError, mistral.MistralIndexError, mistral.indexer.IngestError,
            OSError, ValueError) as error:
        print(f"audit-mistral-index: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
