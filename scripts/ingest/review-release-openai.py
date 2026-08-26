#!/usr/bin/env python3
"""Second-pass visual audit of private release contact sheets with GPT-5.5.

The output is evidence for a human reviewer, never a release signature.  It is
written after every sheet and can be resumed without paying for completed
sheets again.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MODEL = "gpt-5.5"
API_URL = "https://api.openai.com/v1/responses"
AUDIT_METHOD = "original-stem-and-answer-crops-v2"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent


class AuditError(RuntimeError):
    pass


def outside_repo(path: Path) -> None:
    try:
        path.resolve().relative_to(REPO_ROOT)
    except ValueError:
        return
    raise AuditError(f"Private audit output must stay outside Git: {path.resolve()}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def output_text(response: dict[str, Any]) -> str:
    direct = response.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct
    for item in response.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if isinstance(content, dict) and content.get("type") == "output_text":
                text = content.get("text")
                if isinstance(text, str) and text.strip():
                    return text
    raise AuditError("GPT-5.5 response had no output_text")


def validate_items(raw: str, expected_ids: list[str]) -> list[dict[str, Any]]:
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise AuditError(f"GPT-5.5 returned invalid JSON: {error}") from error
    items = document.get("items") if isinstance(document, dict) else None
    if not isinstance(items, list):
        raise AuditError("GPT-5.5 audit must contain an items array")
    if [item.get("id") for item in items if isinstance(item, dict)] != expected_ids:
        raise AuditError("GPT-5.5 audit IDs/order do not match the contact sheet")
    required_bool = ("fullStem", "allOptions", "containsAnswer", "containsSolution",
                     "containsHandwriting", "containsAdjacentQuestion")
    for item in items:
        if not isinstance(item, dict) or any(not isinstance(item.get(key), bool)
                                             for key in required_bool):
            raise AuditError("GPT-5.5 audit is missing explicit crop-safety booleans")
        if not isinstance(item.get("answerText"), str):
            raise AuditError("GPT-5.5 audit answerText must be a string")
        count = item.get("optionCount")
        if count is not None and (not isinstance(count, int) or isinstance(count, bool)
                                  or not 2 <= count <= 10):
            raise AuditError("GPT-5.5 audit optionCount is invalid")
        indexes = item.get("answerIndexes")
        if not isinstance(indexes, list) or any(not isinstance(value, int) for value in indexes):
            raise AuditError("GPT-5.5 audit answerIndexes must be integer indexes")
    return items


def schema() -> dict[str, Any]:
    item = {
        "type": "object",
        "additionalProperties": False,
        "required": ["id", "fullStem", "allOptions", "containsAnswer", "containsSolution",
                     "containsHandwriting", "containsAdjacentQuestion", "answerText",
                     "optionCount", "answerIndexes", "notes"],
        "properties": {
            "id": {"type": "string"},
            "fullStem": {"type": "boolean"},
            "allOptions": {"type": "boolean"},
            "containsAnswer": {"type": "boolean"},
            "containsSolution": {"type": "boolean"},
            "containsHandwriting": {"type": "boolean"},
            "containsAdjacentQuestion": {"type": "boolean"},
            "answerText": {"type": "string"},
            "optionCount": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
            "answerIndexes": {"type": "array", "items": {"type": "integer"}},
            "notes": {"type": "string"},
        },
    }
    return {
        "type": "object", "additionalProperties": False, "required": ["items"],
        "properties": {"items": {"type": "array", "items": item}},
    }


def image_content(path: Path) -> dict[str, str]:
    image = base64.b64encode(path.read_bytes()).decode("ascii")
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    return {"type": "input_image", "image_url": f"data:{mime};base64,{image}", "detail": "high"}


def request_sheet(api_key: str, sheet: Path, metadata: list[dict[str, Any]], work: Path) -> dict[str, Any]:
    ids = [str(item["id"]) for item in metadata]
    prompt = (
        "你是獨立的數學教材影像稽核員。接下來每題會依序提供原尺寸的『原題』及『官方答案』兩張 PNG。"
        "逐題檢查：題幹、圖表與所有選項是否完整；原題是否洩漏答案、詳解、前手圈選、填答、計算筆跡或鄰題；"
        "並只從該題的官方答案 PNG 精確抄錄正解。選擇題回傳選項數及 0 起算 answerIndexes；填充題 answerIndexes=[]。"
        "印刷題號與原書圖線不是手寫。只要疑似鉛筆字、圈選或填入答案，containsHandwriting=true。"
        "不要解題猜答案；看不清就 fullStem=false 並在 notes 說明。必須依下列順序原樣回傳 ID。\n"
        + json.dumps(metadata, ensure_ascii=False)
    )
    content: list[dict[str, str]] = [{"type": "input_text", "text": prompt}]
    input_assets = []
    for item in metadata:
        stem = work / item["stemCrop"]
        answer = work / item["answerCrop"]
        if not stem.is_file() or not answer.is_file():
            raise AuditError(f"Missing original crop pair for {item['id']}")
        content.append({"type": "input_text", "text": f"{item['id']}｜原題 PNG"})
        content.append(image_content(stem))
        content.append({"type": "input_text", "text": f"{item['id']}｜官方答案 PNG"})
        content.append(image_content(answer))
        input_assets.append({"id": item["id"], "stemSha256": sha256(stem),
                             "answerSha256": sha256(answer)})
    body = {
        "model": MODEL,
        "reasoning": {"effort": "medium"},
        "input": [{
            "role": "user",
            "content": content,
        }],
        "text": {"format": {
            "type": "json_schema", "name": "textbook_crop_audit",
            "strict": True, "schema": schema(),
        }},
    }
    request = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        message = error.read().decode("utf-8", errors="replace")[:1200]
        raise AuditError(f"OpenAI API HTTP {error.code}: {message}") from error
    items = validate_items(output_text(payload), ids)
    return {
        "sheet": str(sheet.resolve()), "sheetSha256": sha256(sheet),
        "auditMethod": AUDIT_METHOD, "inputAssets": input_assets,
        "responseId": payload.get("id"), "model": payload.get("model") or MODEL,
        "usage": payload.get("usage") or {}, "items": items,
    }


def atomic_write(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(path)


def run(listing_path: Path, queue_path: Path, output: Path, api_key: str) -> dict[str, Any]:
    outside_repo(output)
    listing = json.loads(listing_path.read_text(encoding="utf-8"))
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    if listing.get("queueSha256") != sha256(queue_path):
        raise AuditError("Contact sheets were not rendered from this exact queue")
    by_id = {item["id"]: item for item in queue.get("items") or []}
    previous: dict[str, Any] = {}
    if output.is_file():
        old = json.loads(output.read_text(encoding="utf-8"))
        if (old.get("queueSha256") == listing["queueSha256"] and old.get("model") == MODEL
                and old.get("auditMethod") == AUDIT_METHOD):
            previous = {row["sheetSha256"]: row for row in old.get("sheets") or []
                        if row.get("auditMethod") == AUDIT_METHOD}
    result = {
        "schema": 1, "kind": "openai-independent-visual-audit",
        "releaseAuthority": False, "humanSignoffStillRequired": True,
        "model": MODEL, "auditMethod": AUDIT_METHOD, "queue": str(queue_path.resolve()),
        "queueSha256": listing["queueSha256"], "completedAt": None, "sheets": [],
    }
    for sheet_row in listing.get("sheets") or []:
        sheet = Path(sheet_row["path"])
        digest = sha256(sheet)
        if digest in previous:
            audited = previous[digest]
        else:
            metadata = []
            for question_id in sheet_row["questionIds"]:
                item = by_id.get(question_id)
                if not item:
                    raise AuditError(f"Sheet references missing queue item {question_id}")
                metadata.append({
                    "id": question_id, "type": item["suggestedType"],
                    "bookTitle": item["bookTitle"], "printedPage": item["printedPage"],
                    "stemCrop": item["stemCrop"], "answerCrop": item["answerCrop"],
                })
            audited = request_sheet(api_key, sheet, metadata, Path(queue["workRoot"]))
        result["sheets"].append(audited)
        atomic_write(output, result)
        print(f"audited {len(result['sheets'])}/{len(listing.get('sheets') or [])}: {sheet.name}", flush=True)
    result["completedAt"] = datetime.now(timezone.utc).isoformat()
    atomic_write(output, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listing", required=True, type=Path)
    parser.add_argument("--queue", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        api_key = os.environ.get("OPENAI_API_KEY", "")
        if not api_key:
            raise AuditError("OPENAI_API_KEY is missing")
        result = run(args.listing, args.queue, args.out, api_key)
        print(json.dumps({"model": result["model"], "sheets": len(result["sheets"]),
                          "completedAt": result["completedAt"]}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, AuditError) as error:
        print(f"review-release-openai: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
