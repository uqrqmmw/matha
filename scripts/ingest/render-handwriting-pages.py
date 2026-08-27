#!/usr/bin/env python3
"""Render only locally detected handwritten PDF pages for paid cleanup."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import fitz


class RenderError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def catalog_books(path: Path) -> dict[str, dict[str, str]]:
    books = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        book_id = re.search(r"\bid:'([\w-]+)'", line)
        file_name = re.search(r"\bfile:'([^']+)'", line)
        pdf_hash = re.search(r"\bpdfSha256:'([a-f0-9]{64})'", line)
        if book_id and file_name and pdf_hash:
            books[book_id.group(1)] = {
                "file": file_name.group(1),
                "pdfSha256": pdf_hash.group(1),
            }
    if not books:
        raise RenderError("Catalog contains no source PDF records")
    return books


def render(
    queue: Path,
    catalog: Path,
    source_root: Path,
    output: Path,
    dpi: int,
    ids: set[str] | None,
    limit: int | None,
) -> dict:
    if dpi < 150 or dpi > 400:
        raise RenderError("DPI must be between 150 and 400")
    document = json.loads(queue.read_text(encoding="utf-8"))
    pages = document.get("pages") or []
    if ids is not None:
        pages = [page for page in pages if page.get("id") in ids]
        missing = ids - {str(page.get("id")) for page in pages}
        if missing:
            raise RenderError(f"Page IDs missing from queue: {', '.join(sorted(missing))}")
    if limit is not None:
        if limit < 1:
            raise RenderError("Limit must be positive")
        pages = pages[:limit]
    if not pages:
        raise RenderError("No candidate pages selected")
    books = catalog_books(catalog)
    output.mkdir(parents=True, exist_ok=True)
    open_documents: dict[str, fitz.Document] = {}
    verified_pdfs: dict[str, Path] = {}
    records = []
    try:
        for index, page in enumerate(pages, 1):
            page_id = str(page["id"])
            book_id = str(page["bookId"])
            pdf_page = int(page["pdfPage"])
            metadata = books.get(book_id)
            if not metadata:
                raise RenderError(f"Book is absent from catalog: {book_id}")
            if book_id not in verified_pdfs:
                pdf = source_root / metadata["file"]
                if not pdf.is_file() or sha256(pdf) != metadata["pdfSha256"]:
                    raise RenderError(f"Source PDF missing or hash mismatch: {pdf}")
                verified_pdfs[book_id] = pdf
                open_documents[book_id] = fitz.open(pdf)
            pdf = verified_pdfs[book_id]
            pdf_document = open_documents[book_id]
            if pdf_page < 1 or pdf_page > len(pdf_document):
                raise RenderError(f"Invalid PDF page for {page_id}: {pdf_page}")
            target = output / book_id / "crops" / page_id / "stem.png"
            target.parent.mkdir(parents=True, exist_ok=True)
            # Always render again. Reusing an existing file without proving its
            # page binding could silently send a stale or wrong page to the
            # paid cleanup service after an interrupted run.
            temporary = target.with_suffix(".rendering.png")
            pdf_document[pdf_page - 1].get_pixmap(dpi=dpi, alpha=False).save(temporary)
            temporary.replace(target)
            records.append({
                **page,
                "sourcePdf": str(pdf.resolve()),
                "sourcePdfSha256": metadata["pdfSha256"],
                "renderDpi": dpi,
                "render": str(target.resolve()),
                "renderSha256": sha256(target),
            })
            print(f"rendered {index}/{len(pages)}: {page_id}", flush=True)
    finally:
        for pdf_document in open_documents.values():
            pdf_document.close()
    manifest = {
        "schema": 1,
        "kind": "handwriting-page-render-queue",
        "candidatePages": len(records),
        "items": records,
    }
    manifest_path = output / "handwriting-page-renders.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    ids_path = output / "handwriting-page-ids.txt"
    ids_path.write_text("\n".join(item["id"] for item in records) + "\n", encoding="utf-8")
    return {"pages": len(records), "manifest": str(manifest_path), "ids": str(ids_path)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--ids", help="comma-separated page IDs")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    try:
        result = render(
            args.queue,
            args.catalog,
            args.source_root,
            args.out,
            args.dpi,
            {value.strip() for value in args.ids.split(",") if value.strip()} if args.ids else None,
            args.limit,
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, RenderError) as error:
        print(f"render-handwriting-pages: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
