#!/usr/bin/env python3
"""Render verified private Math A papers into hash-bound PNG pages.

This is an offline preparation step.  It never calls OCR, a browser, OpenAI,
Supabase, or any other network service.  Source PDFs must already be recorded
in docs/full-paper-inventory.json and match their recorded SHA-256 and page
count.  Existing output is only reused after every recorded asset is verified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def pdf_pages(path: Path, pdfinfo: str) -> int:
    completed = subprocess.run(
        [pdfinfo, str(path)], capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=30, check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or "pdfinfo failed").strip())
    match = re.search(r"^Pages:\s*(\d+)\s*$", completed.stdout, re.M)
    if not match:
        raise RuntimeError("pdfinfo did not report page count")
    return int(match.group(1))


def png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as stream:
        header = stream.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise RuntimeError(f"not a valid PNG: {path}")
    return struct.unpack(">II", header[16:24])


def resolve_hint(path_hint: str, source_root: Path) -> Path:
    normalized = str(path_hint).replace("\\", "/")
    marker = "%DESKTOP%/數學檔案/完整模考來源/"
    if not normalized.startswith(marker):
        raise RuntimeError(f"unsupported private source path hint: {path_hint}")
    relative = normalized[len(marker):]
    path = (source_root / Path(relative)).resolve()
    root = source_root.resolve()
    if root != path and root not in path.parents:
        raise RuntimeError(f"source escaped private root: {path}")
    return path


def build_plan(inventory: dict[str, Any], source_root: Path) -> list[dict[str, Any]]:
    documents = {item["id"]: item for item in inventory.get("sourceDocuments", [])}
    papers = [item for item in inventory.get("papers", [])
              if item.get("privateAppEligible") is True]
    if not papers:
        raise RuntimeError("inventory has no privateAppEligible papers")
    plan: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for paper in papers:
        paper_id = str(paper.get("id") or "")
        if (not paper_id or paper_id in seen_ids or paper.get("questions") != 20
                or paper.get("minutes") != 100):
            raise RuntimeError(f"{paper_id} is not a recorded 20-question, 100-minute paper")
        seen_ids.add(paper_id)
        source = documents.get(paper.get("questionSource"))
        if not source:
            raise RuntimeError(f"{paper_id} question source is missing")
        question_pages = paper.get("questionPdfPages")
        page_map = paper.get("questionPageMap")
        if (not isinstance(question_pages, list) or not question_pages
                or any(not isinstance(page, int) or page < 1 for page in question_pages)):
            raise RuntimeError(f"{paper_id} question PDF page list is invalid")
        if (not isinstance(page_map, list) or len(page_map) != 20
                or any(not isinstance(page, int) or page < 1
                       or page > len(question_pages) for page in page_map)):
            raise RuntimeError(f"{paper_id} question page map is invalid")
        plan.append({
            "paperId": paper_id,
            "appSourceId": paper["appSourceId"],
            "paperClass": paper.get("paperClass", "official-exam"),
            "title": paper["title"],
            "sourceId": source["id"],
            "sourcePath": resolve_hint(source["pathHint"], source_root),
            "sourceSha256": source["sha256"],
            "sourcePages": int(source["pages"]),
            "questionPdfPages": question_pages,
            "questionPageMap": page_map,
        })
    return plan


def verify_source(row: dict[str, Any], pdfinfo: str) -> None:
    path = row["sourcePath"]
    if not path.is_file():
        raise RuntimeError(f"source PDF is missing: {path}")
    actual_hash = sha256(path)
    if actual_hash != row["sourceSha256"]:
        raise RuntimeError(f"source hash mismatch for {row['paperId']}: {actual_hash}")
    actual_pages = pdf_pages(path, pdfinfo)
    if actual_pages != row["sourcePages"]:
        raise RuntimeError(
            f"source page count mismatch for {row['paperId']}: {actual_pages}"
        )
    if max(row["questionPdfPages"]) > actual_pages:
        raise RuntimeError(f"question PDF pages exceed source pages for {row['paperId']}")


def render_paper(row: dict[str, Any], stage: Path, pdftocairo: str,
                 dpi: int) -> dict[str, Any]:
    paper_dir = stage / row["paperId"]
    paper_dir.mkdir(parents=True, exist_ok=False)
    assets: list[dict[str, Any]] = []
    for app_page, pdf_page in enumerate(row["questionPdfPages"], start=1):
        prefix = paper_dir / f"render-{app_page:02d}"
        completed = subprocess.run(
            [pdftocairo, "-singlefile", "-png", "-r", str(dpi), "-f",
             str(pdf_page), "-l", str(pdf_page), str(row["sourcePath"]), str(prefix)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=180, check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or "pdftocairo failed").strip())
        rendered = paper_dir / f"render-{app_page:02d}.png"
        if not rendered.is_file():
            raise RuntimeError(f"rendered page is missing: {rendered}")
        width, height = png_dimensions(rendered)
        final_name = f"page-{app_page:02d}-{sha256(rendered)[:12]}.png"
        final_path = rendered.with_name(final_name)
        rendered.rename(final_path)
        assets.append({
            "appPage": app_page,
            "pdfPage": pdf_page,
            "file": f"{row['paperId']}/{final_name}",
            "sha256": sha256(final_path),
            "bytes": final_path.stat().st_size,
            "width": width,
            "height": height,
        })
    return {
        "paperId": row["paperId"],
        "appSourceId": row["appSourceId"],
        "paperClass": row["paperClass"],
        "title": row["title"],
        "sourceId": row["sourceId"],
        "sourceFileName": row["sourcePath"].name,
        "sourceSha256": row["sourceSha256"],
        "sourcePages": row["sourcePages"],
        "questionPdfPages": row["questionPdfPages"],
        "questionPageMap": row["questionPageMap"],
        "assets": assets,
    }


def verify_existing(output: Path) -> dict[str, Any]:
    manifest_path = output / "official-paper-assets.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"existing output has no manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("kind") != "matha-official-paper-assets-v1":
        raise RuntimeError("existing asset manifest has the wrong kind")
    for paper in manifest.get("papers", []):
        for asset in paper.get("assets", []):
            path = output / asset["file"]
            if not path.is_file() or sha256(path) != asset.get("sha256"):
                raise RuntimeError(f"existing asset mismatch: {asset.get('file')}")
            width, height = png_dimensions(path)
            if [width, height] != [asset.get("width"), asset.get("height")]:
                raise RuntimeError(f"existing asset dimensions mismatch: {asset.get('file')}")
    return manifest


def prepare(inventory_path: Path, source_root: Path, output: Path,
            dpi: int, pdfinfo: str, pdftocairo: str) -> dict[str, Any]:
    if output.exists():
        return verify_existing(output)
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    plan = build_plan(inventory, source_root)
    for row in plan:
        verify_source(row, pdfinfo)

    output.parent.mkdir(parents=True, exist_ok=True)
    # Poppler on Windows can open a Unicode source path, but some builds fail
    # when the output prefix contains CJK characters. Render under the system's
    # ASCII temp path, verify there, then move the complete directory once.
    stage = Path(tempfile.mkdtemp(prefix="matha-official-pages-"))
    try:
        papers = [render_paper(row, stage, pdftocairo, dpi) for row in plan]
        manifest = {
            "kind": "matha-official-paper-assets-v1",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "releaseAuthority": False,
            "privateStudyOnly": True,
            "renderDpi": dpi,
            "paperCount": len(papers),
            "officialPaperCount": sum(
                paper["paperClass"] == "official-exam" for paper in papers
            ),
            "regionalMockPaperCount": sum(
                paper["paperClass"] == "regional-mock" for paper in papers
            ),
            "assetCount": sum(len(paper["assets"]) for paper in papers),
            "papers": papers,
            "gates": {
                "sourceHashesVerified": True,
                "pageCountsVerified": True,
                "pngHeadersVerified": True,
                "visualReviewComplete": False,
                "supabaseUploadVerified": False,
                "answerBindingVerified": False,
                "appIntegrationVerified": False,
            },
        }
        (stage / "official-paper-assets.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        shutil.move(str(stage), str(output))
        return manifest
    except Exception:
        # Keep the uniquely named partial directory for forensic inspection.
        raise


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--dpi", type=int, default=180)
    parser.add_argument("--pdfinfo", default=shutil.which("pdfinfo") or "pdfinfo")
    parser.add_argument("--pdftocairo", default=shutil.which("pdftocairo") or "pdftocairo")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.dpi < 144 or args.dpi > 300:
        raise RuntimeError("render DPI must be between 144 and 300")
    manifest = prepare(
        args.inventory.resolve(), args.source_root.resolve(), args.output.resolve(),
        args.dpi, args.pdfinfo, args.pdftocairo,
    )
    print(json.dumps({
        "output": str(args.output.resolve()),
        "paperCount": manifest["paperCount"],
        "assetCount": manifest["assetCount"],
        "releaseAuthority": manifest["releaseAuthority"],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
