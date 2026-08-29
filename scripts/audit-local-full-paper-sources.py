#!/usr/bin/env python3
"""Inventory local PDFs that may be complete Math A calibration papers.

This is a read-only, offline discovery pass.  It reads PDF metadata and any
embedded text, hashes only shortlisted files, and never calls OCR, a browser,
OpenAI, Supabase, or another network service.  Image-only PDFs are not guessed
to be safe: plausible 4--24 page scans are emitted as manual-review candidates.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SKIP_PARTS = {
    ".git", "node_modules", ".cache", "appdata", "tmp", "temp",
    "reimbursement_safe", "文字資料庫_切分",
}
PATH_PATTERN = re.compile(
    r"數學|數\s*[AaＡａ]|數甲|數乙|數模|學測|模考|模擬|試題|題本|"
    r"(?:^|[\\/_ -])math(?:[\\/_ .-]|$)|mock|exam",
    re.I,
)
MATH_PATTERNS = (
    re.compile(r"數\s*學\s*[AaＡａ]", re.I),
    re.compile(r"數\s*[AaＡａ](?:\s*考\s*科|\s*試\s*題|\s*科)?", re.I),
    re.compile(r"數\s*學\s*科"),
)
EXAM_PATTERNS = (
    re.compile(r"學\s*科\s*能\s*力\s*測\s*驗"),
    re.compile(r"學\s*測"),
    re.compile(r"模\s*擬\s*(?:考|試\s*題)"),
    re.compile(r"全\s*真\s*(?:模\s*考|試\s*題)"),
)
STRUCTURE_PATTERNS = {
    "100-minutes": re.compile(r"(?:考\s*試\s*)?時\s*間[^\n]{0,30}100\s*分\s*鐘"),
    "twenty-questions": re.compile(r"(?:共|總\s*共)[^\n]{0,20}20\s*題"),
    "single-choice": re.compile(r"單\s*選\s*題"),
    "multiple-choice": re.compile(r"多\s*選\s*題"),
    "fill-in": re.compile(r"選\s*填\s*題"),
    "mixed": re.compile(r"混\s*合\s*題"),
}
OBVIOUSLY_UNRELATED = re.compile(
    r"發票|收據|invoice|receipt|報帳|信用卡|銀行|薪資|人事|獸醫|貓|犬|"
    r"生物|化學|物理|地球科學|自然科|行程|訂單|合約|董事|animal|feline|canine",
    re.I,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def skipped(path: Path) -> bool:
    return any(part.casefold() in SKIP_PARTS for part in path.parts)


def iter_pdfs(roots: Iterable[Path]) -> Iterable[Path]:
    seen: set[Path] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.rglob("*.pdf"):
            try:
                resolved = path.resolve()
            except OSError:
                continue
            if resolved in seen or skipped(resolved):
                continue
            seen.add(resolved)
            yield resolved


def poppler_command(name: str) -> str:
    command = shutil.which(name)
    if not command:
        raise RuntimeError(f"missing required offline command: {name}")
    return command


def pdf_page_count(path: Path, pdfinfo: str) -> int:
    completed = subprocess.run(
        [pdfinfo, str(path)], capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=12, check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or "pdfinfo failed").strip())
    match = re.search(r"^Pages:\s*(\d+)\s*$", completed.stdout, re.M)
    if not match:
        raise RuntimeError("pdfinfo did not report page count")
    return int(match.group(1))


def compact_text(path: Path, pages: int, pdftotext: str, page_limit: int = 12) -> str:
    completed = subprocess.run(
        [pdftotext, "-f", "1", "-l", str(min(pages, page_limit)),
         "-layout", str(path), "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=20, check=False,
    )
    if completed.returncode != 0:
        return ""
    return completed.stdout[:250_000]


def classify(path: Path, pages: int, text: str) -> dict[str, Any]:
    relative_label = str(path)
    path_match = bool(PATH_PATTERN.search(relative_label))
    math_hits = sum(bool(pattern.search(text)) for pattern in MATH_PATTERNS)
    exam_hits = sum(bool(pattern.search(text)) for pattern in EXAM_PATTERNS)
    structure_hits = [name for name, pattern in STRUCTURE_PATTERNS.items() if pattern.search(text)]
    has_text = bool(text.strip())
    plausible_length = 4 <= pages <= 24
    content_score = min(math_hits, 1) * 3 + min(exam_hits, 1) * 2 + min(len(structure_hits), 3)

    category = "not-candidate"
    reasons: list[str] = []
    if path_match:
        reasons.append("math-or-exam-path")
    if math_hits:
        reasons.append("math-a-content")
    if exam_hits:
        reasons.append("exam-content")
    reasons.extend(structure_hits)

    if plausible_length and content_score >= 5:
        category = "probable-full-paper"
    elif path_match and (plausible_length or content_score >= 3):
        category = "named-candidate"
    elif plausible_length and not has_text and not OBVIOUSLY_UNRELATED.search(relative_label):
        category = "image-only-manual-review"
        reasons.append("no-embedded-text")
    elif plausible_length and content_score >= 3:
        category = "content-candidate"

    return {
        "category": category,
        "pathMatch": path_match,
        "hasEmbeddedText": has_text,
        "mathHits": math_hits,
        "examHits": exam_hits,
        "structureHits": structure_hits,
        "reasons": reasons,
    }


def display_path(path: Path, roots: list[Path]) -> str:
    for index, root in enumerate(roots, start=1):
        try:
            return f"%ROOT{index}%/{path.relative_to(root).as_posix()}"
        except ValueError:
            continue
    return path.name


def inspect_pdf(path: Path, roots: list[Path], pdfinfo: str,
                pdftotext: str) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
    try:
        pages = pdf_page_count(path, pdfinfo)
        path_hint = bool(PATH_PATTERN.search(str(path)))
        should_read_text = path_hint or 4 <= pages <= 24
        text = compact_text(path, pages, pdftotext) if should_read_text else ""
        result = classify(path, pages, text)
        if result["category"] == "not-candidate":
            return None, None
        return ({
            "path": display_path(path, roots),
            "fileName": path.name,
            "pages": pages,
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            **result,
        }, None)
    except Exception as error:
        return None, {"path": display_path(path, roots), "error": str(error)[:300]}


def audit(roots: list[Path], workers: int = 6) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    paths = list(iter_pdfs(roots))
    pdfinfo = poppler_command("pdfinfo")
    pdftotext = poppler_command("pdftotext")
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [
            executor.submit(inspect_pdf, path, roots, pdfinfo, pdftotext)
            for path in paths
        ]
        for future in concurrent.futures.as_completed(futures):
            row, error = future.result()
            if row is not None:
                rows.append(row)
            if error is not None:
                errors.append(error)

    rows.sort(key=lambda row: (
        {"probable-full-paper": 0, "content-candidate": 1,
         "named-candidate": 2, "image-only-manual-review": 3}.get(row["category"], 9),
        row["sha256"], row["path"],
    ))
    hashes: dict[str, list[str]] = {}
    for row in rows:
        hashes.setdefault(row["sha256"], []).append(row["path"])
    duplicates = [
        {"sha256": digest, "paths": paths}
        for digest, paths in hashes.items() if len(paths) > 1
    ]
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["category"]] = counts.get(row["category"], 0) + 1
    return {
        "kind": "matha-local-full-paper-discovery-v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "releaseAuthority": False,
        "readOnly": True,
        "roots": [f"%ROOT{index}%" for index in range(1, len(roots) + 1)],
        "scannedPdfCount": len(paths),
        "candidateCount": len(rows),
        "candidateCounts": counts,
        "candidates": rows,
        "duplicateCandidateGroups": duplicates,
        "errors": errors,
        "limits": {
            "embeddedTextPages": 12,
            "imageOnlyManualReviewPageRange": [4, 24],
            "noOcr": True,
            "noNetwork": True,
            "note": "Image-only candidates require visual review; discovery does not establish freshness or answer completeness.",
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=6)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    roots = [path.expanduser().resolve() for path in args.root]
    report = audit(roots, workers=args.workers)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output.resolve()),
        "scannedPdfCount": report["scannedPdfCount"],
        "candidateCount": report["candidateCount"],
        "candidateCounts": report["candidateCounts"],
        "errorCount": len(report["errors"]),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
