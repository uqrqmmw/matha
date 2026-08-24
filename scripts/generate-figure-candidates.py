#!/usr/bin/env python3
"""Generate *review-only* figure crop candidates from verified textbook PDFs.

This program is intentionally fail-closed.  It never creates ``figureAsset``
records, never sets ``verified`` or ``studentUsable`` to true, and refuses to
write inside the Git repository.  A human reviewer (and a separate promotion
step) is required before any crop can be exposed to a student.

The detector uses the low-resolution review page for inexpensive layout/CV
analysis and renders only the proposed rectangles again from the original PDF.
It does not use full-page images as candidate assets.  Since the scans have no
embedded OCR layer and the installed Tesseract may not include Traditional
Chinese, answer/solution/handwriting safety remains ``unknown`` on every crop.
That uncertainty is a hard reason why every output stays review-only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import cv2
import fitz
import numpy as np
from PIL import Image, ImageDraw, ImageFont


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent.resolve()
TEMP_ROOT = Path(tempfile.gettempdir()).resolve()
SCHEMA_VERSION = 1


class CandidateError(RuntimeError):
    """A fail-closed validation or processing error."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_outside_repo(path: Path) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return
    raise CandidateError(f"Candidate output must be outside the Git repository: {resolved}")


def ensure_private_temp_output(path: Path) -> None:
    resolved = path.resolve()
    ensure_outside_repo(resolved)
    try:
        relative = resolved.relative_to(TEMP_ROOT)
    except ValueError as exc:
        raise CandidateError(f"Candidate output must stay below the OS Temp directory: {resolved}") from exc
    if not relative.parts:
        raise CandidateError("Candidate output cannot be the OS Temp root itself")


def safe_segment(value: Any, label: str) -> str:
    text = str(value or "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", text) or text in {".", ".."}:
        raise CandidateError(f"Unsafe {label}: {text!r}")
    return text


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CandidateError(f"Cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise CandidateError(f"Expected a JSON object: {path}")
    return value


def validate_review_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("kind") != "private-figure-review" or manifest.get("schema") != 1:
        raise CandidateError("Expected private-figure-review schema 1")
    privacy = manifest.get("privacy") or {}
    if privacy.get("localOnly") is not True or privacy.get("fullPagesStudentUsable") is not False:
        raise CandidateError("Review manifest is missing fail-closed privacy declarations")
    groups = manifest.get("assetGroups")
    pages = manifest.get("pageReferences")
    books = manifest.get("books")
    if not isinstance(groups, list) or not isinstance(pages, list) or not isinstance(books, list):
        raise CandidateError("Review manifest has invalid groups/pages/books")
    for group in groups:
        if group.get("studentUsable") is not False or group.get("verified") is not False:
            raise CandidateError(f"Input group is not pending review: {group.get('assetId')}")
        safe_segment(group.get("assetId"), "asset id")
        safe_segment(group.get("bookId"), "book id")
        if not isinstance(group.get("pageIndex"), int) or group["pageIndex"] < 1:
            raise CandidateError(f"Invalid page for {group.get('assetId')}")


def target_number(exercise_id: str) -> int | None:
    """Extract a likely printed exercise number without treating a page as it."""
    text = safe_segment(exercise_id, "exercise id")
    patterns = (
        r"(?:^|-)(?:ex|fill|calc|single)(\d+)(?:-|$)",
        r"(?:^|-)adv-(?:f|m|s|c)(\d+)(?:-|$)",
        r"(?:^|-)(?:f|m|s|c)(\d+)(?:-|$)",
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return int(match.group(1))
    return None


def parse_tesseract_tsv(text: str, width: int, height: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    lines = text.splitlines()
    if not lines:
        return rows
    headers = lines[0].split("\t")
    for raw in lines[1:]:
        values = raw.split("\t")
        if len(values) < len(headers):
            values += [""] * (len(headers) - len(values))
        row = dict(zip(headers, values))
        token = row.get("text", "").strip()
        if not token:
            continue
        try:
            left, top = int(row["left"]), int(row["top"])
            w, h = int(row["width"]), int(row["height"])
            conf = float(row.get("conf", -1))
        except (KeyError, ValueError):
            continue
        if w <= 0 or h <= 0 or conf < 12:
            continue
        rows.append({
            "text": token,
            "left": left,
            "top": top,
            "width": w,
            "height": h,
            "cx": (left + w / 2) / width,
            "cy": (top + h / 2) / height,
            "confidence": conf,
        })
    return rows


def number_from_token(token: str) -> tuple[int | None, bool]:
    cleaned = token.strip().replace("O", "0").replace("l", "1")
    strong = bool(re.search(r"(?:Ex|EX|ex|No|NO)\s*\.?\s*\d", cleaned))
    match = re.search(r"(?<!\d)(\d{1,3})(?!\d)", cleaned)
    return (int(match.group(1)), strong) if match else (None, False)


def resolve_tesseract(command: str | None) -> str | None:
    if not command:
        return None
    located = shutil.which(command)
    if located:
        return located
    explicit = Path(command)
    if explicit.is_file():
        return str(explicit)
    if command.lower() in {"tesseract", "tesseract.exe"}:
        for candidate in (
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Tesseract-OCR" / "tesseract.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Tesseract-OCR" / "tesseract.exe",
        ):
            if candidate.is_file():
                return str(candidate)
    return None


@dataclass
class Anchor:
    y: float
    x: float
    score: float
    token: str
    strong: bool


def locate_anchor(tokens: list[dict[str, Any]], number: int | None) -> tuple[Anchor | None, bool]:
    if number is None:
        return None, True
    matches: list[Anchor] = []
    for token in tokens:
        found, strong = number_from_token(token["text"])
        if found != number:
            continue
        # Exercise labels are almost always near the left; a prefixed Ex/No is
        # allowed farther right because scanned pages can be skewed/cropped.
        if token["cx"] > (0.48 if strong else 0.25):
            continue
        score = token["confidence"] / 100 + (0.8 if strong else 0.0) + max(0.0, 0.25 - token["cx"])
        matches.append(Anchor(token["cy"], token["cx"], score, token["text"], strong))
    matches.sort(key=lambda item: item.score, reverse=True)
    if not matches:
        return None, True
    ambiguous = len(matches) > 1 and matches[1].score >= matches[0].score - 0.22
    return matches[0], ambiguous


def next_strong_anchor(tokens: list[dict[str, Any]], y: float) -> float | None:
    candidates: list[float] = []
    for token in tokens:
        _, strong = number_from_token(token["text"])
        if strong and token["cy"] > y + 0.025:
            candidates.append(token["cy"])
    return min(candidates) if candidates else None


def ambiguity_status(anchor: Anchor | None, anchor_ambiguous: bool,
                     candidate_count: int, band_basis: str) -> bool:
    """Only a unique prefixed label inside a detected question box is low ambiguity."""
    return (
        anchor is None
        or not anchor.strong
        or anchor_ambiguous
        or candidate_count != 1
        or band_basis != "enclosing-question-box"
    )


@dataclass
class Proposal:
    box: tuple[int, int, int, int]
    score: float
    method: str
    line_count: int
    density: float
    reasons: list[str] = field(default_factory=list)


def iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1, ix2, iy2 = max(ax1, bx1), max(ay1, by1), min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    intersection = (ix2 - ix1) * (iy2 - iy1)
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - intersection
    return intersection / union if union else 0.0


def find_question_rectangles(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    height, width = mask.shape
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    rectangles: list[tuple[int, int, int, int]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w < width * 0.55 or h < height * 0.055 or h > height * 0.50:
            continue
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.015 * perimeter, True) if perimeter else contour
        if len(approx) > 10:
            continue
        rectangles.append((x, y, x + w, y + h))
    return rectangles


def safe_band(mask: np.ndarray, anchor: Anchor | None, tokens: list[dict[str, Any]]) -> tuple[float, float, str]:
    height, _ = mask.shape
    if anchor is None:
        return 0.05, 0.72, "unanchored-page-zone"
    rectangles = find_question_rectangles(mask)
    containing = [box for box in rectangles if box[1] / height - 0.015 <= anchor.y <= box[3] / height]
    if containing:
        # The smallest enclosing box is more likely the exercise, rather than a
        # page frame.  Stay inside it; answers printed below the box are excluded.
        box = min(containing, key=lambda value: (value[2] - value[0]) * (value[3] - value[1]))
        return max(0.0, box[1] / height), min(1.0, box[3] / height), "enclosing-question-box"
    end = min(0.94, anchor.y + 0.34)
    following = next_strong_anchor(tokens, anchor.y)
    if following is not None:
        end = min(end, following - 0.018)
    return max(0.0, anchor.y - 0.035), max(anchor.y + 0.08, end), "anchor-limited-band"


def count_lines(gray_crop: np.ndarray) -> int:
    edges = cv2.Canny(gray_crop, 60, 160)
    threshold = max(18, int(min(gray_crop.shape) * 0.12))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=threshold,
                            minLineLength=max(12, int(min(gray_crop.shape) * 0.16)),
                            maxLineGap=max(3, int(min(gray_crop.shape) * 0.025)))
    return 0 if lines is None else min(99, len(lines))


def proposal_boxes(gray: np.ndarray, band: tuple[float, float, str]) -> list[Proposal]:
    height, width = gray.shape
    _, mask = cv2.threshold(gray, 195, 255, cv2.THRESH_BINARY_INV)
    mask[: max(1, int(height * 0.015)), :] = 0
    mask[int(height * 0.985):, :] = 0
    y_min, y_max = int(band[0] * height), int(band[1] * height)
    page_area = width * height
    raw: list[Proposal] = []
    for kernel_size, iterations, method in ((3, 1, "ink-cluster-3"), (5, 1, "ink-cluster-5"), (7, 2, "ink-cluster-7")):
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
        merged = cv2.dilate(mask, kernel, iterations=iterations)
        contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if y + h < y_min or y > y_max:
                continue
            area_ratio = (w * h) / page_area
            if w < width * 0.045 or h < height * 0.032 or area_ratio < 0.0012:
                continue
            if w > width * 0.78 or h > height * 0.42 or area_ratio > 0.24:
                continue
            pad_x, pad_y = int(width * 0.012), int(height * 0.010)
            box = (max(0, x - pad_x), max(y_min, y - pad_y),
                   min(width, x + w + pad_x), min(y_max, y + h + pad_y))
            x1, yy1, x2, yy2 = box
            if x2 <= x1 or yy2 <= yy1:
                continue
            crop_gray = gray[yy1:yy2, x1:x2]
            crop_mask = mask[yy1:yy2, x1:x2]
            density = float(np.count_nonzero(crop_mask)) / crop_mask.size
            if density < 0.004 or density > 0.30:
                continue
            line_count = count_lines(crop_gray)
            # Text paragraphs create dense horizontal strips. Require a useful
            # geometry signal or a genuinely two-dimensional ink distribution.
            row_ink = np.count_nonzero(crop_mask, axis=1) / max(1, crop_mask.shape[1])
            active_rows = float(np.count_nonzero(row_ink > 0.012)) / max(1, len(row_ink))
            two_dimensional = active_rows > 0.34 and h > height * 0.055
            aspect = (x2 - x1) / max(1, yy2 - yy1)
            # Short, very wide islands are overwhelmingly formulas or text
            # lines in these books, not standalone figures.
            if (yy2 - yy1) < height * 0.055 and aspect > 3.0:
                continue
            if line_count < 4:
                continue
            score = min(1.2, line_count / 12) + min(0.5, active_rows) + min(0.35, area_ratio * 5)
            reasons = [band[2], f"geometry-lines:{line_count}", f"active-row-ratio:{active_rows:.3f}"]
            if x > width * 0.48:
                score += 0.18
                reasons.append("right-side-figure-prior")
            if line_count < 4:
                score -= 0.15
                reasons.append("weak-line-evidence")
            raw.append(Proposal(box, score, method, line_count, density, reasons))

    raw.sort(key=lambda item: item.score, reverse=True)
    selected: list[Proposal] = []
    for proposal in raw:
        if any(iou(proposal.box, other.box) > 0.62 for other in selected):
            continue
        selected.append(proposal)
        if len(selected) >= 8:
            break
    return selected


def run_tesseract(image_path: Path, command: str | None) -> tuple[list[dict[str, Any]], str]:
    if not command:
        return [], "disabled"
    executable = resolve_tesseract(command)
    if not executable:
        return [], "unavailable"
    image = Image.open(image_path)
    image_width, image_height = image.size
    try:
        proc = subprocess.run(
            [str(executable), str(image_path), "stdout", "-l", "eng", "--psm", "6", "tsv"],
            check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", errors="replace", timeout=90,
        )
    finally:
        image.close()
    if proc.returncode != 0:
        return [], f"failed:{proc.returncode}"
    return parse_tesseract_tsv(proc.stdout, image_width, image_height), "eng-only"


def normalized_box(box: tuple[int, int, int, int], width: int, height: int) -> dict[str, float]:
    x1, y1, x2, y2 = box
    return {
        "x": round(x1 / width, 6), "y": round(y1 / height, 6),
        "width": round((x2 - x1) / width, 6), "height": round((y2 - y1) / height, 6),
    }


def render_pdf_crop(pdf: fitz.Document, page_index: int, bbox: dict[str, float], dpi: int, output: Path) -> tuple[int, int]:
    page = pdf[page_index - 1]
    rect = page.rect
    clip = fitz.Rect(
        rect.x0 + bbox["x"] * rect.width,
        rect.y0 + bbox["y"] * rect.height,
        rect.x0 + (bbox["x"] + bbox["width"]) * rect.width,
        rect.y0 + (bbox["y"] + bbox["height"]) * rect.height,
    ) & rect
    if clip.width < rect.width * 0.03 or clip.height < rect.height * 0.02:
        raise CandidateError("Refusing an implausibly small PDF crop")
    if clip.get_area() > rect.get_area() * 0.25:
        raise CandidateError("Refusing a crop covering more than 25% of a PDF page")
    pixmap = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), clip=clip, alpha=False)
    output.parent.mkdir(parents=True, exist_ok=True)
    pixmap.save(output)
    return pixmap.width, pixmap.height


def build_contact_sheets(records: list[dict[str, Any]], output_dir: Path, columns: int = 4) -> list[str]:
    candidates = [(record, candidate) for record in records for candidate in record["candidates"]]
    if not candidates:
        return []
    paths: list[str] = []
    chunk_size = columns * 5
    font = ImageFont.load_default()
    for sheet_index in range(math.ceil(len(candidates) / chunk_size)):
        chunk = candidates[sheet_index * chunk_size:(sheet_index + 1) * chunk_size]
        cell_w, cell_h = 420, 340
        sheet = Image.new("RGB", (columns * cell_w, math.ceil(len(chunk) / columns) * cell_h), "#e9e6de")
        draw = ImageDraw.Draw(sheet)
        for index, (record, candidate) in enumerate(chunk):
            col, row = index % columns, index // columns
            x, y = col * cell_w, row * cell_h
            image_path = output_dir / candidate["path"]
            with Image.open(image_path) as source:
                preview = source.convert("RGB")
                preview.thumbnail((cell_w - 20, cell_h - 58), Image.Resampling.LANCZOS)
                px = x + (cell_w - preview.width) // 2
                py = y + 35 + (cell_h - 45 - preview.height) // 2
                sheet.paste(preview, (px, py))
            draw.text((x + 8, y + 7), f"{record['assetId']} / {candidate['candidateId']}", fill="#201f1b", font=font)
            draw.text((x + 8, y + cell_h - 17), "REVIEW ONLY - NOT STUDENT USABLE", fill="#8b261c", font=font)
        sheet_path = output_dir / "contact-sheets" / f"candidates-{sheet_index + 1:03d}.jpg"
        sheet_path.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(sheet_path, quality=88, optimize=True)
        paths.append(sheet_path.relative_to(output_dir).as_posix())
    return paths


def generate(options: argparse.Namespace) -> dict[str, Any]:
    manifest_path = Path(options.manifest).resolve()
    output_dir = Path(options.output).resolve()
    ensure_private_temp_output(output_dir)
    manifest = read_json(manifest_path)
    validate_review_manifest(manifest)
    review_root = manifest_path.parent
    pdf_root = Path(options.pdf_root or manifest.get("inputs", {}).get("pdfRoot", "")).resolve()
    if not pdf_root.is_dir():
        raise CandidateError(f"PDF root does not exist: {pdf_root}")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise CandidateError(f"Output directory must be new or empty: {output_dir}")

    books: dict[str, dict[str, Any]] = {}
    for book in manifest["books"]:
        book_id = safe_segment(book.get("bookId"), "book id")
        pdf_path = (pdf_root / book["file"]).resolve()
        try:
            pdf_path.relative_to(pdf_root)
        except ValueError as exc:
            raise CandidateError(f"PDF path escapes root for {book_id}") from exc
        if not pdf_path.is_file():
            raise CandidateError(f"Missing source PDF for {book_id}: {pdf_path}")
        actual_sha = sha256_file(pdf_path)
        if actual_sha != str(book.get("sha256", "")).lower():
            raise CandidateError(f"PDF SHA-256 mismatch for {book_id}")
        document = fitz.open(pdf_path)
        if document.page_count != int(book.get("pageCount", -1)):
            document.close()
            raise CandidateError(f"PDF page count mismatch for {book_id}")
        books[book_id] = {"meta": book, "path": pdf_path, "document": document, "sha256": actual_sha}

    page_refs: dict[tuple[str, int], dict[str, Any]] = {}
    for page in manifest["pageReferences"]:
        key = (safe_segment(page.get("bookId"), "book id"), int(page.get("pageIndex", 0)))
        low_res = (review_root / page["path"]).resolve()
        try:
            low_res.relative_to(review_root)
        except ValueError as exc:
            raise CandidateError(f"Review page escapes review root: {page.get('path')}") from exc
        if not low_res.is_file() or sha256_file(low_res) != str(page.get("sha256", "")).lower():
            raise CandidateError(f"Low-resolution review page failed hash validation: {page.get('path')}")
        page_refs[key] = {**page, "file": low_res}

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / ".private-output-do-not-upload").write_text(
        "PRIVATE COPYRIGHTED CROP CANDIDATES\nREVIEW ONLY - NEVER UPLOAD OR SERVE TO STUDENTS\n",
        encoding="utf-8",
    )
    page_analysis: dict[tuple[str, int], dict[str, Any]] = {}
    records: list[dict[str, Any]] = []
    try:
        for group in manifest["assetGroups"]:
            book_id, page_index = group["bookId"], group["pageIndex"]
            key = (book_id, page_index)
            if key not in page_refs or book_id not in books:
                raise CandidateError(f"Missing verified source for {group['assetId']}")
            if key not in page_analysis:
                low_res_path = page_refs[key]["file"]
                gray = cv2.imread(str(low_res_path), cv2.IMREAD_GRAYSCALE)
                if gray is None or gray.size == 0:
                    raise CandidateError(f"Cannot decode review page: {low_res_path}")
                tokens, ocr_mode = run_tesseract(low_res_path, options.tesseract)
                page_analysis[key] = {"gray": gray, "tokens": tokens, "ocrMode": ocr_mode}
            analysis = page_analysis[key]
            gray, tokens = analysis["gray"], analysis["tokens"]
            number = target_number(group.get("exerciseId", ""))
            anchor, anchor_ambiguous = locate_anchor(tokens, number)
            band = safe_band(cv2.threshold(gray, 195, 255, cv2.THRESH_BINARY_INV)[1], anchor, tokens)
            proposals = proposal_boxes(gray, band)

            # Unanchored regions remain high-risk: only keep strong geometric
            # proposals and fewer variants.  This is coverage, never approval.
            if anchor is None:
                # Without a reliable exercise anchor, page-level geometry can
                # easily select a worked answer or the next exercise.  Return
                # no crop instead of guessing.
                proposals = []
            else:
                proposals = [item for item in proposals if item.score >= 0.62]
            proposals = proposals[:3]
            candidate_entries: list[dict[str, Any]] = []
            candidate_rejections: list[dict[str, str]] = []
            for index, proposal in enumerate(proposals, 1):
                h, w = gray.shape
                bbox = normalized_box(proposal.box, w, h)
                candidate_id = f"{group['assetId']}-c{index}"
                candidate_path = Path("candidates") / safe_segment(book_id, "book id") / f"{safe_segment(candidate_id, 'candidate id')}.png"
                try:
                    width, height = render_pdf_crop(
                        books[book_id]["document"], page_index, bbox, options.render_dpi,
                        output_dir / candidate_path,
                    )
                except CandidateError as exc:
                    # A bad machine proposal is an ordinary no-candidate result,
                    # not a reason to weaken the crop size/area safety gate.
                    candidate_rejections.append({
                        "proposal": f"machine-proposal-{index}",
                        "reason": str(exc),
                    })
                    continue
                candidate_entries.append({
                    "candidateId": candidate_id,
                    "candidateStatus": "machine-proposed-human-review-required",
                    "studentUsable": False,
                    "verified": False,
                    "path": candidate_path.as_posix(),
                    "sha256": sha256_file(output_dir / candidate_path),
                    "mime": "image/png",
                    "width": width,
                    "height": height,
                    "bboxNormalized": bbox,
                    "detector": {
                        "method": proposal.method,
                        "score": round(proposal.score, 4),
                        "lineCount": proposal.line_count,
                        "inkDensity": round(proposal.density, 6),
                        "reasons": proposal.reasons,
                    },
                    "safety": {
                        "sourcePdfHashVerified": True,
                        "lowResolutionReferenceHashVerified": True,
                        "notFullPage": True,
                        "containsAnswer": "unknown",
                        "containsSolution": "unknown",
                        "containsHandwriting": "unknown",
                        "questionRoleVerified": False,
                        "independentlyReviewed": False,
                        "safeForStudent": False,
                    },
                })
            no_candidate = not candidate_entries
            ambiguous = ambiguity_status(anchor, anchor_ambiguous, len(candidate_entries), band[2])
            records.append({
                "assetId": group["assetId"],
                "exerciseId": group["exerciseId"],
                "questionIds": group["questionIds"],
                "bookId": book_id,
                "pageIndex": page_index,
                "sourcePdfSha256": books[book_id]["sha256"],
                "targetNumber": number,
                "anchor": None if anchor is None else {
                    "token": anchor.token, "x": round(anchor.x, 6), "y": round(anchor.y, 6),
                    "score": round(anchor.score, 4), "strong": anchor.strong,
                },
                "anchorAmbiguous": anchor_ambiguous,
                "safeBand": {"top": round(band[0], 6), "bottom": round(band[1], 6), "basis": band[2]},
                "ocrMode": analysis["ocrMode"],
                "candidateCount": len(candidate_entries),
                "candidateRejections": candidate_rejections,
                "noCandidate": no_candidate,
                "ambiguous": ambiguous,
                "studentUsable": False,
                "verified": False,
                "candidates": candidate_entries,
            })
    finally:
        for entry in books.values():
            entry["document"].close()

    total = len(records)
    covered = sum(not record["noCandidate"] for record in records)
    no_candidate = total - covered
    ambiguous = sum(record["ambiguous"] for record in records)
    candidate_count = sum(record["candidateCount"] for record in records)
    rejection_count = sum(len(record["candidateRejections"]) for record in records)
    contacts = build_contact_sheets(records, output_dir)
    result = {
        "kind": "private-figure-candidate-review",
        "schema": SCHEMA_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "privacy": {
            "localOnly": True,
            "uploadPerformed": False,
            "automaticVerificationPerformed": False,
            "studentUsableAssets": 0,
            "verifiedAssets": 0,
            "fullPagesEmittedAsCandidates": 0,
        },
        "inputs": {
            "reviewManifest": manifest_path.name,
            "reviewManifestSha256": sha256_file(manifest_path),
            "pdfRoot": str(pdf_root),
            "renderDpi": options.render_dpi,
            "tesseractMode": "eng-only-if-available",
        },
        "limitations": [
            "Candidates are machine proposals only and cannot be promoted without independent visual review.",
            "Traditional-Chinese answer/solution detection is unavailable in the local OCR layer; all content safety flags remain unknown.",
            "Handwriting detection is not trusted; all handwriting safety flags remain unknown.",
            "No full-page render is a candidate asset.",
        ],
        "summary": {
            "assetGroups": total,
            "groupsWithCandidates": covered,
            "candidateCrops": candidate_count,
            "rejectedMachineProposals": rejection_count,
            "noCandidateGroups": no_candidate,
            "ambiguousGroups": ambiguous,
            "coverageRate": round(covered / total, 6) if total else 0,
            "noCandidateRate": round(no_candidate / total, 6) if total else 0,
            "ambiguityRate": round(ambiguous / total, 6) if total else 0,
            "verifiedAssets": 0,
            "studentUsableAssets": 0,
        },
        "contactSheets": contacts,
        "assetGroups": records,
    }
    (output_dir / "candidate-manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def parser() -> argparse.ArgumentParser:
    arg_parser = argparse.ArgumentParser(description="Generate private review-only figure crop candidates")
    arg_parser.add_argument("--manifest", required=True, help="private review-manifest.json")
    arg_parser.add_argument("--pdf-root", help="override PDF root stored in review manifest")
    arg_parser.add_argument("--output", required=True, help="empty private directory outside the repository")
    arg_parser.add_argument("--render-dpi", type=int, default=180)
    arg_parser.add_argument("--tesseract", default="tesseract", help="Tesseract executable or empty string to disable")
    return arg_parser


def main(argv: Iterable[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.render_dpi < 120 or args.render_dpi > 300:
        raise CandidateError("--render-dpi must be between 120 and 300")
    result = generate(args)
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CandidateError, OSError, fitz.FileDataError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
