#!/usr/bin/env python3
"""Render verified regional Math A solution PDFs into private, hash-bound PNGs.

This offline step never calls OCR, OpenAI, a browser, Supabase, or any paid
service. Only regional mock papers with an explicit 20-question solution-page
map are accepted. Source hashes, PDF page counts, PNG headers, and every
question-to-file binding are verified before the output directory is created.
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


KIND = "matha-private-paper-solution-assets-v1"
MANIFEST_NAME = "private-paper-solution-assets.json"


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
    path = (source_root / Path(normalized[len(marker):])).resolve()
    root = source_root.resolve()
    if root != path and root not in path.parents:
        raise RuntimeError(f"source escaped private root: {path}")
    return path


def build_plan(inventory: dict[str, Any], source_root: Path) -> list[dict[str, Any]]:
    documents = {item["id"]: item for item in inventory.get("sourceDocuments", [])}
    papers = [item for item in inventory.get("papers", [])
              if item.get("privateAppEligible") is True
              and item.get("paperClass") == "regional-mock"]
    if not papers:
        raise RuntimeError("inventory has no eligible regional mock solutions")
    plan: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for paper in papers:
        paper_id = str(paper.get("id") or "")
        app_source_id = str(paper.get("appSourceId") or "")
        if (not paper_id or paper_id in seen_ids or not app_source_id
                or paper.get("questions") != 20 or paper.get("minutes") != 100):
            raise RuntimeError(f"{paper_id} is not a unique 20-question, 100-minute paper")
        seen_ids.add(paper_id)
        source = documents.get(paper.get("solutionSource"))
        if not source:
            raise RuntimeError(f"{paper_id} solution source is missing")
        pdf_page_numbers = paper.get("solutionPdfPages")
        question_page_map = paper.get("solutionQuestionPageMap")
        if (not isinstance(pdf_page_numbers, list) or not pdf_page_numbers
                or any(not isinstance(page, int) or page < 1 for page in pdf_page_numbers)):
            raise RuntimeError(f"{paper_id} solution PDF page list is invalid")
        if (not isinstance(question_page_map, list) or len(question_page_map) != 20
                or any(not isinstance(pages, list) or not pages for pages in question_page_map)
                or any(not isinstance(page, int) or page < 1 or page > len(pdf_page_numbers)
                       for pages in question_page_map for page in pages)):
            raise RuntimeError(f"{paper_id} solution question page map is invalid")
        plan.append({
            "paperId": paper_id,
            "appSourceId": app_source_id,
            "title": paper["title"],
            "sourceId": source["id"],
            "sourcePath": resolve_hint(source["pathHint"], source_root),
            "sourceSha256": source["sha256"],
            "sourcePages": int(source["pages"]),
            "solutionPdfPages": pdf_page_numbers,
            "solutionQuestionPageMap": question_page_map,
        })
    return plan


def verify_source(row: dict[str, Any], pdfinfo: str) -> None:
    path = row["sourcePath"]
    if not path.is_file():
        raise RuntimeError(f"solution PDF is missing: {path}")
    if sha256(path) != row["sourceSha256"]:
        raise RuntimeError(f"solution source hash mismatch for {row['paperId']}")
    actual_pages = pdf_pages(path, pdfinfo)
    if actual_pages != row["sourcePages"] or max(row["solutionPdfPages"]) > actual_pages:
        raise RuntimeError(f"solution source page count mismatch for {row['paperId']}")


def render_paper(row: dict[str, Any], stage: Path, pdftocairo: str,
                 dpi: int) -> dict[str, Any]:
    paper_dir = stage / row["appSourceId"]
    paper_dir.mkdir(parents=True, exist_ok=False)
    assets: list[dict[str, Any]] = []
    for app_page, pdf_page in enumerate(row["solutionPdfPages"], start=1):
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
            raise RuntimeError(f"rendered solution page is missing: {rendered}")
        width, height = png_dimensions(rendered)
        digest = sha256(rendered)
        final_name = f"solution-page-{app_page:02d}-{digest[:12]}.png"
        final_path = rendered.with_name(final_name)
        rendered.rename(final_path)
        assets.append({
            "appPage": app_page, "pdfPage": pdf_page,
            "file": f"{row['appSourceId']}/{final_name}",
            "sha256": digest, "bytes": final_path.stat().st_size,
            "width": width, "height": height,
        })
    question_files = [
        [assets[page - 1]["file"] for page in pages]
        for pages in row["solutionQuestionPageMap"]
    ]
    return {
        "paperId": row["paperId"], "appSourceId": row["appSourceId"],
        "title": row["title"], "sourceId": row["sourceId"],
        "sourceFileName": row["sourcePath"].name,
        "sourceSha256": row["sourceSha256"], "sourcePages": row["sourcePages"],
        "solutionPdfPages": row["solutionPdfPages"],
        "solutionQuestionPageMap": row["solutionQuestionPageMap"],
        "questionSolutionFiles": question_files, "assets": assets,
    }


def verify_existing(output: Path) -> dict[str, Any]:
    manifest_path = output / MANIFEST_NAME
    if not manifest_path.is_file():
        raise RuntimeError(f"existing output has no manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("kind") != KIND:
        raise RuntimeError("existing solution manifest has the wrong kind")
    for paper in manifest.get("papers", []):
        known = {asset["file"] for asset in paper.get("assets", [])}
        for question_files in paper.get("questionSolutionFiles", []):
            if not question_files or any(file not in known for file in question_files):
                raise RuntimeError(f"question solution binding mismatch: {paper.get('paperId')}")
        for asset in paper.get("assets", []):
            path = output / asset["file"]
            if not path.is_file() or sha256(path) != asset.get("sha256"):
                raise RuntimeError(f"existing solution asset mismatch: {asset.get('file')}")
            if list(png_dimensions(path)) != [asset.get("width"), asset.get("height")]:
                raise RuntimeError(f"solution asset dimensions mismatch: {asset.get('file')}")
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
    stage = Path(tempfile.mkdtemp(prefix="matha-private-solutions-"))
    papers = [render_paper(row, stage, pdftocairo, dpi) for row in plan]
    manifest = {
        "kind": KIND, "generatedAt": datetime.now(timezone.utc).isoformat(),
        "releaseAuthority": False, "privateStudyOnly": True, "renderDpi": dpi,
        "paperCount": len(papers), "assetCount": sum(len(p["assets"]) for p in papers),
        "questionBindingCount": sum(len(p["questionSolutionFiles"]) for p in papers),
        "papers": papers,
        "gates": {
            "sourceHashesVerified": True, "pageCountsVerified": True,
            "questionBindingsVerified": True, "pngHeadersVerified": True,
            "visualReviewComplete": False, "supabaseUploadVerified": False,
            "serverMapVerified": False, "appIntegrationVerified": False,
        },
    }
    (stage / MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    shutil.move(str(stage), str(output))
    return manifest


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
    manifest = prepare(args.inventory.resolve(), args.source_root.resolve(),
                       args.output.resolve(), args.dpi, args.pdfinfo, args.pdftocairo)
    print(json.dumps({"output": str(args.output.resolve()),
                      "paperCount": manifest["paperCount"],
                      "assetCount": manifest["assetCount"],
                      "releaseAuthority": manifest["releaseAuthority"]},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
