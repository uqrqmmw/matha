#!/usr/bin/env python3
"""Erase handwriting from selected private stem crops with TextIn.

This tool never promotes its output.  It keeps provenance and a pixel-difference
mask so a reviewer can verify that printed mathematics was not altered.
Credentials are read only from TEXTIN_APP_ID and TEXTIN_SECRET_CODE.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ENDPOINT = "https://api.textin.com/ai/service/v1/handwritten_erase"
SERVICE = "textin-handwritten-erase-v1"


class EraseError(RuntimeError):
    pass


def outside_repo(path: Path) -> None:
    try:
        path.resolve().relative_to(REPO_ROOT)
    except ValueError:
        return
    raise EraseError(f"Private cleaned output must stay outside Git: {path.resolve()}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def find_stem(work: Path, question_id: str) -> Path:
    matches = list(work.glob(f"*/crops/{question_id}/stem.png"))
    if len(matches) != 1:
        raise EraseError(f"{question_id}: expected one stem crop, found {len(matches)}")
    return matches[0]


def request_clean(source: Path, app_id: str, secret: str) -> tuple[bytes, str, int]:
    # The service defaults to dewarp + enhancement.  Disable both so this call
    # only erases handwriting and cannot silently reshape or sharpen equations.
    query = urllib.parse.urlencode({
        "crop": 0, "doc_direction": 0, "dewarp": 0,
        "binarization": 0, "image_type": 1,
    })
    request = urllib.request.Request(
        f"{ENDPOINT}?{query}", data=source.read_bytes(), method="POST",
        headers={
            "x-ti-app-id": app_id, "x-ti-secret-code": secret,
            "Content-Type": "application/octet-stream",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
            request_id = response.headers.get("x-ti-request-id", "")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        raise EraseError(f"TextIn HTTP {error.code}: {detail}") from error
    if int(payload.get("code", 0)) != 200 or not (payload.get("result") or {}).get("image"):
        raise EraseError(f"TextIn refused image: code={payload.get('code')} message={payload.get('message')}")
    try:
        image = base64.b64decode(payload["result"]["image"], validate=True)
    except (ValueError, TypeError) as error:
        raise EraseError("TextIn returned an invalid base64 image") from error
    return image, request_id or str(payload.get("x_request_id") or ""), int(payload.get("duration") or 0)


def diff_artifacts(original: Image.Image, cleaned: Image.Image) -> tuple[Image.Image, dict[str, Any]]:
    before = original.convert("RGB")
    after = cleaned.convert("RGB")
    if before.size != after.size:
        raise EraseError(f"TextIn changed image dimensions: {before.size} -> {after.size}")
    difference = ImageChops.difference(before, after).convert("L")
    mask = difference.point(lambda value: 255 if value >= 12 else 0)
    # Pillow 14 deprecates getdata(); keep compatibility with older releases.
    pixels = mask.get_flattened_data() if hasattr(mask, "get_flattened_data") else mask.getdata()
    changed = sum(1 for value in pixels if value)
    total = before.width * before.height
    overlay = before.copy()
    red = Image.new("RGB", before.size, (190, 58, 52))
    overlay.paste(red, mask=mask)
    return overlay, {
        "width": before.width, "height": before.height,
        "changedPixels": changed, "changedFraction": changed / total if total else 0,
        "changedBbox": list(mask.getbbox()) if mask.getbbox() else None,
        "threshold": 12,
    }


def atomic_write(path: Path, document: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(path)


def erase(work: Path, ids: list[str], output: Path, app_id: str, secret: str) -> dict[str, Any]:
    outside_repo(output)
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "textin-handwriting-cleanup.json"
    old_by_id: dict[str, Any] = {}
    if manifest_path.is_file():
        old = json.loads(manifest_path.read_text(encoding="utf-8"))
        if old.get("service") == SERVICE:
            old_by_id = {item["id"]: item for item in old.get("items") or []}
    result = {
        "schema": 1, "kind": "private-handwriting-cleanup-candidates",
        "service": SERVICE, "releaseAuthority": False,
        "humanPixelReviewRequired": True, "generatedAt": None, "items": [],
    }
    for index, question_id in enumerate(ids, 1):
        source = find_stem(work, question_id)
        source_hash = sha256(source)
        previous = old_by_id.get(question_id)
        if previous and previous.get("sourceSha256") == source_hash:
            item = previous
        else:
            cleaned_bytes, request_id, duration = request_clean(source, app_id, secret)
            try:
                cleaned = Image.open(io.BytesIO(cleaned_bytes)).convert("RGB")
                cleaned.load()
            except OSError as error:
                raise EraseError(f"{question_id}: TextIn result is not a readable image") from error
            original = Image.open(source).convert("RGB")
            overlay, metrics = diff_artifacts(original, cleaned)
            item_dir = output / question_id
            item_dir.mkdir(parents=True, exist_ok=True)
            cleaned_path = item_dir / "cleaned.jpg"
            diff_path = item_dir / "changed-pixels.jpg"
            cleaned.save(cleaned_path, quality=96, subsampling=0)
            overlay.save(diff_path, quality=92, subsampling=0)
            item = {
                "id": question_id, "source": str(source.resolve()),
                "sourceSha256": source_hash, "cleaned": str(cleaned_path.resolve()),
                "cleanedSha256": sha256(cleaned_path), "diff": str(diff_path.resolve()),
                "diffSha256": sha256(diff_path), "textInRequestId": request_id,
                "durationMs": duration, "metrics": metrics,
                "review": {"printedContentIntact": None, "allHandwritingRemoved": None,
                           "noAnswerLeak": None, "decision": ""},
            }
        result["items"].append(item)
        atomic_write(manifest_path, result)
        print(f"cleaned {index}/{len(ids)}: {question_id}", flush=True)
    result["generatedAt"] = datetime.now(timezone.utc).isoformat()
    atomic_write(manifest_path, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--ids", required=True, help="comma-separated question IDs")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        ids = [value.strip() for value in args.ids.split(",") if value.strip()]
        if not ids or len(ids) != len(set(ids)):
            raise EraseError("--ids must contain unique question IDs")
        app_id = os.environ.get("TEXTIN_APP_ID", "")
        secret = os.environ.get("TEXTIN_SECRET_CODE", "")
        if not app_id or not secret:
            raise EraseError("Set TEXTIN_APP_ID and TEXTIN_SECRET_CODE; credentials are never stored in files")
        result = erase(args.work, ids, args.out, app_id, secret)
        print(json.dumps({"service": result["service"], "items": len(result["items"]),
                          "manifest": str((args.out / 'textin-handwriting-cleanup.json').resolve())},
                         ensure_ascii=False))
        return 0
    except (OSError, ValueError, EraseError) as error:
        print(f"erase-handwriting-textin: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
