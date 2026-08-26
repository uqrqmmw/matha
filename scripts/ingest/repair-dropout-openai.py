#!/usr/bin/env python3
"""Repair one explicitly reviewed OCR dropout with OpenAI vision.

The original whole-document OCR response is immutable.  This tool writes a
provider-labelled raw response and a normalized candidate outside the public
repository.  Downstream indexing must still verify the source PDF/page/render
hashes before it may use the candidate, and OCR remains index-only metadata.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import cv2
import fitz
import numpy as np

OPENAI_URL = "https://api.openai.com/v1/responses"
MODEL = "gpt-5.5"
NORMALIZED_SIZE = 1000
RENDER_DPI = 240


class RepairError(RuntimeError):
    """The repair request or its provenance validation failed."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False,
        suffix=".tmp",
    ) as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        temporary = Path(stream.name)
    temporary.replace(path)


def atomic_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False,
                                     suffix=".tmp") as stream:
        stream.write(value)
        temporary = Path(stream.name)
    temporary.replace(path)


def load_api_key(secret: str, project: str) -> str:
    executable = shutil.which("gcloud.cmd" if os.name == "nt" else "gcloud")
    if not executable:
        raise RepairError("gcloud CLI not found")
    result = subprocess.run(
        [executable, "secrets", "versions", "access", "latest",
         f"--secret={secret}", f"--project={project}"],
        check=True, capture_output=True, text=True, encoding="utf-8",
    )
    key = result.stdout.strip()
    if len(key) < 20 or any(character.isspace() for character in key):
        raise RepairError("OpenAI secret is empty or malformed")
    return key


def verify_render_source(source: Path, page_number: int, render: Path) -> dict[str, Any]:
    """Prove the supplied JPEG is the requested source PDF page, not just a file.

    JPEG is lossy, so byte equality with a fresh PDF render is impossible.  We
    require exact dimensions plus a tight pixel-error bound against a fresh
    240 dpi render.  This check happens before an API request can spend money.
    """
    if page_number < 1:
        raise RepairError("Source page number must be positive")
    try:
        document = fitz.open(source)
    except (OSError, RuntimeError) as error:
        raise RepairError(f"Cannot open source PDF: {error}") from error
    try:
        if page_number > document.page_count:
            raise RepairError(
                f"Source page {page_number} exceeds PDF page count {document.page_count}")
        pixmap = document[page_number - 1].get_pixmap(dpi=RENDER_DPI, alpha=False)
        expected = cv2.imdecode(
            np.frombuffer(pixmap.tobytes("png"), dtype=np.uint8), cv2.IMREAD_COLOR)
    finally:
        document.close()
    try:
        actual = cv2.imdecode(np.fromfile(render, dtype=np.uint8), cv2.IMREAD_COLOR)
    except OSError as error:
        raise RepairError(f"Cannot read repair render: {error}") from error
    if expected is None or actual is None:
        raise RepairError("Cannot decode source page or repair render")
    if expected.shape != actual.shape:
        raise RepairError(
            f"Repair render dimensions {actual.shape[:2]} differ from source "
            f"page {expected.shape[:2]}")
    difference = np.abs(expected.astype(np.int16) - actual.astype(np.int16))
    mean_error = float(np.mean(difference))
    percentile_99 = float(np.percentile(difference, 99))
    expected_gray = cv2.cvtColor(expected, cv2.COLOR_BGR2GRAY)
    actual_gray = cv2.cvtColor(actual, cv2.COLOR_BGR2GRAY)
    expected_ink = cv2.GaussianBlur(255 - expected_gray, (3, 3), 0).astype(np.float32)
    actual_ink = cv2.GaussianBlur(255 - actual_gray, (3, 3), 0).astype(np.float32)
    denominator = float(np.linalg.norm(expected_ink) * np.linalg.norm(actual_ink))
    ink_cosine = float(np.sum(expected_ink * actual_ink) / denominator) if denominator else 0.0
    if mean_error > 3.0 or percentile_99 > 80.0 or ink_cosine < 0.88:
        raise RepairError(
            "Repair render pixels do not match the requested source PDF page "
            f"(MAE={mean_error:.4f}, p99={percentile_99:.1f}, "
            f"ink cosine={ink_cosine:.4f})")
    return {
        "method": "fresh-pdf-page-render-240dpi-rgb-error-v1",
        "width": int(actual.shape[1]), "height": int(actual.shape[0]),
        "meanAbsoluteError": round(mean_error, 6),
        "percentile99AbsoluteError": round(percentile_99, 3),
        "inkCosineSimilarity": round(ink_cosine, 6),
    }


def response_schema() -> dict[str, Any]:
    box = {
        "type": "array", "minItems": 4, "maxItems": 4,
        "items": {"type": "integer", "minimum": 0, "maximum": 1000},
    }
    block = {
        "type": "object", "additionalProperties": False,
        "properties": {
            "bbox": box,
            "text": {"type": "string"},
            "blockType": {
                "type": "string",
                "enum": ["header", "text", "equation", "footer"],
            },
        },
        "required": ["bbox", "text", "blockType"],
    }
    return {
        "type": "object", "additionalProperties": False,
        "properties": {
            "pageMarkdown": {"type": "string"},
            "blocks": {"type": "array", "items": block},
            "qualityWarnings": {
                "type": "array", "items": {"type": "string"},
            },
        },
        "required": ["pageMarkdown", "blocks", "qualityWarnings"],
    }


def build_request(image_bytes: bytes, source_file: str, page_number: int) -> dict[str, Any]:
    prompt = (
        "你是數學教材的忠實 OCR 引擎。逐字抄錄這一頁的所有印刷題目與小標題；"
        "不得解題、不得填答案、不得更正文意、不得憑常識補上看不清楚的字。"
        "矩陣、行列式、向量與公式請用可讀的 LaTeX。依頁面由上到下輸出自然區塊，"
        "題號必須與題幹放在同一區塊。bbox 使用整頁正規化 0 到 1000 的"
        "[x0,y0,x1,y1] 整數座標，且 x1>x0、y1>y0。空白與純頁碼可省略。"
        "任何不確定處不要猜，照可見內容轉錄並在 qualityWarnings 說明。"
    )
    return {
        "model": MODEL,
        "instructions": prompt,
        "input": [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": (
                    f"來源檔：{source_file}；PDF 第 {page_number} 頁。請只做本頁 OCR。"
                )},
                {"type": "input_image", "detail": "original",
                 "image_url": "data:image/jpeg;base64," +
                 base64.b64encode(image_bytes).decode("ascii")},
            ],
        }],
        "reasoning": {"effort": "medium"},
        "max_output_tokens": 5000,
        "store": False,
        "metadata": {"app": "matha-ingest", "task": "ocr-dropout-repair"},
        "text": {"format": {
            "type": "json_schema", "name": "matha_ocr_dropout_repair",
            "strict": True, "schema": response_schema(),
        }},
    }


def call_openai(api_key: str, request_body: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    body = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        OPENAI_URL, data=body, method="POST",
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1200]
        raise RepairError(f"OpenAI HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RepairError(f"OpenAI request failed: {error.reason}") from error
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RepairError("OpenAI response is not JSON") from error
    if parsed.get("status") != "completed":
        raise RepairError(f"OpenAI response did not complete: {parsed.get('status')}")
    return raw, parsed


def extract_output(response: dict[str, Any]) -> dict[str, Any]:
    texts = [
        item.get("text")
        for output in response.get("output", []) if isinstance(output, dict)
        for item in output.get("content", []) if isinstance(item, dict)
        and item.get("type") == "output_text" and isinstance(item.get("text"), str)
    ]
    if len(texts) != 1:
        raise RepairError(f"Expected one structured output text, received {len(texts)}")
    try:
        value = json.loads(texts[0])
    except json.JSONDecodeError as error:
        raise RepairError("Structured output text is not JSON") from error
    if not isinstance(value, dict) or not isinstance(value.get("blocks"), list):
        raise RepairError("Structured OCR output has no blocks array")
    previous_y = -1
    for number, block in enumerate(value["blocks"], 1):
        box = block.get("bbox") if isinstance(block, dict) else None
        text = block.get("text") if isinstance(block, dict) else None
        if not isinstance(box, list) or len(box) != 4 \
                or any(not isinstance(item, int) for item in box):
            raise RepairError(f"OCR block {number} has an invalid bbox")
        x0, y0, x1, y1 = box
        if not (0 <= x0 < x1 <= NORMALIZED_SIZE and 0 <= y0 < y1 <= NORMALIZED_SIZE):
            raise RepairError(f"OCR block {number} lies outside normalized page")
        if y0 < previous_y:
            raise RepairError("OCR blocks are not in top-to-bottom order")
        if not isinstance(text, str) or not text.strip():
            raise RepairError(f"OCR block {number} has no text")
        previous_y = y0
    return value


def normalize_candidate(
    output: dict[str, Any], response: dict[str, Any], raw_sha: str,
    source: Path, source_sha: str, page_number: int, render_sha: str,
    render_verification: dict[str, Any],
) -> dict[str, Any]:
    blocks = [{
        "top_left_x": block["bbox"][0],
        "top_left_y": block["bbox"][1],
        "bottom_right_x": block["bbox"][2],
        "bottom_right_y": block["bbox"][3],
        "content": block["text"],
        "type": block["blockType"],
    } for block in output["blocks"]]
    return {
        "sourceFile": source.name,
        "sourceSha256": source_sha,
        "sourcePageIndex": page_number - 1,
        "sourcePageNumber": page_number,
        "repairReason": "whole-document-ocr-dropout",
        "repairProvider": "openai",
        "repairModel": MODEL,
        "repairResolvedModel": response.get("model"),
        "repairMethod": "single-page-jpeg-240dpi-structured-vision",
        "renderSha256": render_sha,
        "renderSourceVerification": render_verification,
        "rawResponseSha256": raw_sha,
        "responseId": response.get("id"),
        "generatedAt": response.get("created_at"),
        "page": {
            "index": 0,
            "markdown": output["pageMarkdown"],
            "images": [], "tables": [], "hyperlinks": [],
            "header": None, "footer": None,
            "dimensions": {"dpi": 0, "height": NORMALIZED_SIZE,
                           "width": NORMALIZED_SIZE},
            "blocks": blocks,
        },
        "qualityWarnings": output["qualityWarnings"],
        "usageInfo": response.get("usage"),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--page", required=True, type=int)
    parser.add_argument("--render", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--secret", default="openai-api-key")
    parser.add_argument("--project", default="cutea-499709")
    args = parser.parse_args(argv)
    try:
        if not args.source.is_file() or not args.render.is_file():
            raise RepairError("Source PDF or page render does not exist")
        actual_source_sha = sha256(args.source)
        if actual_source_sha != args.source_sha256:
            raise RepairError("Source PDF SHA-256 mismatch")
        render_verification = verify_render_source(args.source, args.page, args.render)
        render_bytes = args.render.read_bytes()
        render_sha = hashlib.sha256(render_bytes).hexdigest()
        api_key = load_api_key(args.secret, args.project)
        raw_bytes, response = call_openai(
            api_key, build_request(render_bytes, args.source.name, args.page))
        raw_sha = hashlib.sha256(raw_bytes).hexdigest()
        output = extract_output(response)
        basename = f"{actual_source_sha[:16]}-p{args.page:04d}"
        raw_file = args.out / "raw" / f"{basename}-openai.json"
        candidate_file = args.out / "candidates" / f"{basename}.json"
        atomic_bytes(raw_file, raw_bytes)
        candidate = normalize_candidate(
            output, response, raw_sha, args.source, actual_source_sha,
            args.page, render_sha, render_verification)
        atomic_json(candidate_file, candidate)
        print(json.dumps({
            "status": "completed", "provider": "openai", "model": MODEL,
            "sourceFile": args.source.name, "sourcePageNumber": args.page,
            "blocks": len(output["blocks"]),
            "qualityWarnings": output["qualityWarnings"],
            "candidate": str(candidate_file),
        }, ensure_ascii=False, indent=2))
        return 0
    except (OSError, subprocess.CalledProcessError, RepairError, ValueError) as error:
        print(f"repair-dropout-openai: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
