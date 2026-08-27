#!/usr/bin/env python3
"""Create review-only handwriting-removal candidates with YesScanner.

The printed source remains authoritative. This tool can process explicit IDs
or discover every stem crop in the core chapter corpus, stores lossless
cleaned/difference images and provenance after every item, and never promotes a
result into the student bank. Long runs are sequential, resumable, retry only
transient failures, and stop after repeated provider failures so an exhausted
quota cannot burn requests in a loop.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import ctypes.wintypes
import hashlib
import html
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageFilter

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ENDPOINT = "https://scanb.yescanner.com/vision"
SCENE = "handwriting-remover"
SIGN_METHOD = "SHA3-256"
SERVICE = "yescanner-handwriting-remover-v1"
ARTIFACT_SCHEMA = 3
DEFAULT_CREDENTIALS = Path.home() / ".matha" / "yescanner-credentials.json"
DEFAULT_CATALOG = REPO_ROOT / "textbook-catalog.js"
TRANSIENT_ERROR_RE = re.compile(r"(?:HTTP (?:429|5\d\d)|timed? out|temporar|request failed)", re.I)


class EraseError(RuntimeError):
    pass


class DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


def _blob(data: bytes) -> tuple[DataBlob, Any]:
    buffer = (ctypes.c_byte * len(data)).from_buffer_copy(data)
    return DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def _protect_secret(secret: str) -> bytes:
    if os.name != "nt":
        raise EraseError("Persistent YesScanner credentials require Windows DPAPI")
    source, source_buffer = _blob(secret.encode("utf-8"))
    output = DataBlob()
    crypt32 = ctypes.windll.crypt32
    crypt32.CryptProtectData.restype = ctypes.wintypes.BOOL
    ok = crypt32.CryptProtectData(
        ctypes.byref(source),
        "matha YesScanner API credential",
        None,
        None,
        None,
        0,
        ctypes.byref(output),
    )
    del source_buffer
    if not ok:
        raise EraseError("Windows could not protect the YesScanner credential")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(output.pbData)


def _unprotect_secret(protected: bytes) -> str:
    if os.name != "nt":
        raise EraseError("Persistent YesScanner credentials require Windows DPAPI")
    source, source_buffer = _blob(protected)
    output = DataBlob()
    crypt32 = ctypes.windll.crypt32
    crypt32.CryptUnprotectData.restype = ctypes.wintypes.BOOL
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(output)
    )
    del source_buffer
    if not ok:
        raise EraseError("Windows could not decrypt the YesScanner credential for this user")
    try:
        return ctypes.string_at(output.pbData, output.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(output.pbData)


def store_credentials(
    client_id: str,
    client_secret: str,
    path: Path = DEFAULT_CREDENTIALS,
) -> Path:
    if len(client_id.strip()) < 8 or len(client_secret.strip()) < 16:
        raise EraseError("YesScanner credentials have an unexpected shape")
    outside_repo(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {
        "schema": 1,
        "service": SERVICE,
        "clientId": client_id.strip(),
        "encryptedClientSecret": base64.b64encode(
            _protect_secret(client_secret.strip())
        ).decode("ascii"),
        "protection": "Windows-DPAPI-current-user",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    atomic_write(path, document)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def load_credentials(path: Path = DEFAULT_CREDENTIALS) -> tuple[str, str]:
    env_id = os.environ.get("YESCANNER_CLIENT_ID", "")
    env_secret = os.environ.get("YESCANNER_CLIENT_SECRET", "")
    if env_id and env_secret:
        return env_id, env_secret
    if env_id or env_secret:
        raise EraseError("Set both YESCANNER_CLIENT_ID and YESCANNER_CLIENT_SECRET, or neither")
    if not path.is_file():
        raise EraseError(
            "No YesScanner credentials found; set environment variables or run --store-credentials"
        )
    document = json.loads(path.read_text(encoding="utf-8"))
    if (
        document.get("service") != SERVICE
        or document.get("protection") != "Windows-DPAPI-current-user"
    ):
        raise EraseError("Stored YesScanner credential metadata is invalid")
    try:
        protected = base64.b64decode(document["encryptedClientSecret"], validate=True)
        secret = _unprotect_secret(protected)
    except (KeyError, ValueError, TypeError) as error:
        raise EraseError("Stored YesScanner credential is corrupt") from error
    client_id = str(document.get("clientId") or "")
    if len(client_id) < 8 or len(secret) < 16:
        raise EraseError("Stored YesScanner credentials have an unexpected shape")
    return client_id, secret


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


def core_chapter_book_ids(catalog: Path) -> list[str]:
    """Read only the stable non-content book metadata from the JS catalog."""
    books = []
    for line in catalog.read_text(encoding="utf-8").splitlines():
        id_match = re.search(r"\bid:'([\w-]+)'", line)
        if not id_match:
            continue
        kind = re.search(r"\bkind:'([^']+)'", line)
        eligibility = re.search(r"\beligibility:'([^']+)'", line)
        if kind and kind.group(1) == "chapter" and eligibility and eligibility.group(1) == "core":
            books.append(id_match.group(1))
    if not books or len(books) != len(set(books)):
        raise EraseError("Catalog did not yield a unique core chapter book list")
    return sorted(books)


def discover_core_chapter_stems(work: Path, catalog: Path) -> list[str]:
    ids = []
    for book_id in core_chapter_book_ids(catalog):
        crop_root = work / book_id / "crops"
        if not crop_root.is_dir():
            raise EraseError(f"Core chapter crop directory is missing: {crop_root}")
        ids.extend(path.parent.name for path in sorted(crop_root.glob("*/stem.png")))
    if not ids or len(ids) != len(set(ids)):
        raise EraseError("Discovered stem IDs are empty or not globally unique")
    return ids


def read_ids_file(path: Path) -> list[str]:
    ids = [line.strip() for line in path.read_text(encoding="utf-8").splitlines()
           if line.strip() and not line.lstrip().startswith("#")]
    if not ids or len(ids) != len(set(ids)):
        raise EraseError("ID file must contain unique non-empty question IDs")
    return ids


def read_queue_ids(path: Path) -> list[str]:
    document = json.loads(path.read_text(encoding="utf-8"))
    ids = [str(item.get("id") or "").strip() for item in document.get("items") or []
           if isinstance(item, dict)]
    if not ids or any(not value for value in ids) or len(ids) != len(set(ids)):
        raise EraseError("Queue must contain unique non-empty question IDs")
    return ids


def selected_ids(args: argparse.Namespace) -> list[str]:
    selectors = [bool(args.ids), bool(args.ids_file), bool(args.queue), bool(args.all_core_chapter_crops)]
    if sum(selectors) != 1:
        raise EraseError(
            "Select exactly one of --ids, --ids-file, --queue, or --all-core-chapter-crops"
        )
    if args.ids:
        ids = [value.strip() for value in args.ids.split(",") if value.strip()]
    elif args.ids_file:
        ids = read_ids_file(args.ids_file)
    elif args.queue:
        ids = read_queue_ids(args.queue)
    else:
        ids = discover_core_chapter_stems(args.work, args.catalog)
    if not ids or len(ids) != len(set(ids)):
        raise EraseError("Selected question IDs must be unique and non-empty")
    if args.start_after:
        try:
            start = ids.index(args.start_after) + 1
        except ValueError as error:
            raise EraseError(f"--start-after ID is not in the selected corpus: {args.start_after}") from error
        ids = ids[start:]
    if args.limit is not None:
        if args.limit < 1:
            raise EraseError("--limit must be positive")
        ids = ids[:args.limit]
    if not ids:
        raise EraseError("Selection window contains no question IDs")
    return ids


def signature(client_id: str, client_secret: str, nonce: str, timestamp: int) -> str:
    raw = f"{client_id}_vision_{SIGN_METHOD}_{nonce}_{timestamp}_{client_secret}"
    return hashlib.sha3_256(raw.encode("utf-8")).hexdigest()


def _decode_image(value: Any) -> bytes:
    if not isinstance(value, str) or not value.strip():
        raise EraseError("YesScanner response did not contain data.base64img")
    encoded = value.strip()
    if encoded.startswith("data:"):
        try:
            encoded = encoded.split(",", 1)[1]
        except IndexError as error:
            raise EraseError("YesScanner returned an invalid image data URI") from error
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise EraseError("YesScanner returned invalid base64 image data") from error


def request_clean(
    source: Path,
    client_id: str,
    client_secret: str,
    *,
    nonce: str | None = None,
    timestamp: int | None = None,
) -> tuple[bytes, dict[str, Any]]:
    request_nonce = nonce or uuid.uuid4().hex
    request_timestamp = timestamp if timestamp is not None else int(time.time() * 1000)
    payload = {
        "clientId": client_id,
        "signature": signature(client_id, client_secret, request_nonce, request_timestamp),
        "signMethod": SIGN_METHOD,
        "signNonce": request_nonce,
        "timestamp": request_timestamp,
        "scene": SCENE,
        "imageBase64": base64.b64encode(source.read_bytes()).decode("ascii"),
    }
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = json.loads(response.read().decode("utf-8"))
            response_request_id = (
                response.headers.get("x-request-id")
                or response.headers.get("x-yescanner-request-id")
                or ""
            )
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        raise EraseError(f"YesScanner HTTP {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise EraseError(f"YesScanner request failed: {error.reason}") from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EraseError("YesScanner returned a non-JSON response") from error

    if not isinstance(body, dict) or body.get("success") is not True:
        code = body.get("errorCode") if isinstance(body, dict) else None
        message = body.get("errorMsg") if isinstance(body, dict) else None
        raise EraseError(f"YesScanner refused image: code={code or 'unknown'} message={message or 'unknown'}")
    data = body.get("data")
    if not isinstance(data, dict):
        raise EraseError("YesScanner response did not contain a result object")
    if data.get("has_rectified") is True or int(data.get("predict_rotate_angle") or 0) != 0:
        raise EraseError("YesScanner changed page geometry; the result is unsafe for source-bound review")

    cleaned = _decode_image(data.get("base64img"))
    metadata = {
        "requestId": response_request_id,
        "timestampMs": request_timestamp,
        "signMethod": SIGN_METHOD,
        "scene": SCENE,
        "costMs": int(body.get("costMs") or 0),
        "hasRectified": bool(data.get("has_rectified")),
        "predictRotateAngle": int(data.get("predict_rotate_angle") or 0),
        "reportedWidth": int(data.get("cropped_image_width") or 0),
        "reportedHeight": int(data.get("cropped_image_height") or 0),
        "imageClass": str(data.get("image_cls") or data.get("cls") or ""),
        "strategyBucket": int(data.get("strategy_bucket") or 0),
        "decoderCacheHit": bool(data.get("match_decoder_cache")),
    }
    return cleaned, metadata


def request_clean_with_retry(
    source: Path,
    client_id: str,
    client_secret: str,
    retries: int,
) -> tuple[bytes, dict[str, Any]]:
    if retries < 0:
        raise EraseError("Retry count cannot be negative")
    for attempt in range(retries + 1):
        try:
            return request_clean(source, client_id, client_secret)
        except EraseError as error:
            if attempt >= retries or not TRANSIENT_ERROR_RE.search(str(error)):
                raise
            time.sleep(min(2 ** attempt, 8))
    raise AssertionError("unreachable retry loop")


def diff_artifacts(
    original: Image.Image, cleaned: Image.Image
) -> tuple[Image.Image, Image.Image, dict[str, Any]]:
    before = original.convert("RGB")
    after = cleaned.convert("RGB")
    if before.size != after.size:
        raise EraseError(f"YesScanner changed image dimensions: {before.size} -> {after.size}")
    before_gray = before.convert("L")
    after_gray = after.convert("L")
    raw_difference = ImageChops.difference(before_gray, after_gray)
    raw_mask = raw_difference.point(lambda value: 255 if value >= 12 else 0)
    # YesScanner resizes its inference output.  Exact pixel subtraction paints
    # harmless sub-pixel shifts around every printed glyph.  Compare the
    # darkest pixel in a 3x3 neighbourhood instead: preserved printed strokes
    # still have nearby ink, while actually erased ink becomes much lighter.
    before_min = before_gray.filter(ImageFilter.MinFilter(3))
    after_min = after_gray.filter(ImageFilter.MinFilter(3))
    removed_delta = ImageChops.subtract(after_min, before_min)
    mask = removed_delta.point(lambda value: 255 if value >= 40 else 0)
    pixels = mask.get_flattened_data() if hasattr(mask, "get_flattened_data") else mask.getdata()
    changed = sum(1 for value in pixels if value)
    raw_pixels = raw_mask.get_flattened_data() if hasattr(raw_mask, "get_flattened_data") else raw_mask.getdata()
    raw_changed = sum(1 for value in raw_pixels if value)
    total = before.width * before.height
    overlay = before.copy()
    red = Image.new("RGB", before.size, (190, 58, 52))
    overlay.paste(red, mask=mask)
    return overlay, mask, {
        "width": before.width,
        "height": before.height,
        "changedPixels": changed,
        "changedFraction": changed / total if total else 0,
        "changedBbox": list(mask.getbbox()) if mask.getbbox() else None,
        "threshold": 40,
        "neighbourhood": 3,
        "rawChangedPixelsAt12": raw_changed,
        "rawChangedFractionAt12": raw_changed / total if total else 0,
    }


def normalize_geometry(
    original: Image.Image, provider_output: Image.Image
) -> tuple[Image.Image, dict[str, Any]]:
    before = original.convert("RGB")
    output = provider_output.convert("RGB")
    if output.size == before.size:
        return output, {
            "method": "identity",
            "providerWidth": output.width,
            "providerHeight": output.height,
            "normalizedWidth": before.width,
            "normalizedHeight": before.height,
            "aspectDrift": 0.0,
        }
    if not before.width or not before.height or not output.width or not output.height:
        raise EraseError("YesScanner returned an empty image")
    source_aspect = before.width / before.height
    output_aspect = output.width / output.height
    aspect_drift = abs(output_aspect / source_aspect - 1.0)
    # Very wide one-line crops can gain/lose one raster row when the provider
    # scales onto its inference canvas. Account for at most two rows of integer
    # quantization while still rejecting meaningful crop/dewarp changes.
    allowed_aspect_drift = min(
        0.03, max(0.005, 2 / min(before.height, output.height))
    )
    # YesScanner normalizes many document crops to a larger inference canvas.
    # Permit only near-uniform scaling; crop/dewarp/rotation remains forbidden.
    if aspect_drift > allowed_aspect_drift:
        raise EraseError(
            "YesScanner changed image geometry beyond uniform scaling: "
            f"{before.size} -> {output.size} (aspect drift {aspect_drift:.6f}, "
            f"allowed {allowed_aspect_drift:.6f})"
        )
    normalized = output.resize(before.size, Image.Resampling.LANCZOS)
    return normalized, {
        "method": "uniform-resize-lanczos",
        "providerWidth": output.width,
        "providerHeight": output.height,
        "normalizedWidth": before.width,
        "normalizedHeight": before.height,
        "aspectDrift": aspect_drift,
        "allowedAspectDrift": allowed_aspect_drift,
    }


def atomic_write(path: Path, document: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(path)


def load_item_record(output: Path, question_id: str, source_hash: str) -> dict[str, Any] | None:
    path = output / question_id / "item-record.json"
    if not path.is_file():
        return None
    try:
        item = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if item.get("service") != SERVICE or not _valid_previous(item, source_hash):
        return None
    return item


def load_provider_record(
    output: Path, question_id: str, source_hash: str
) -> dict[str, Any] | None:
    path = output / question_id / "provider-record.json"
    if not path.is_file():
        return None
    try:
        item = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if item.get("service") != SERVICE or not _valid_provider_previous(item, source_hash):
        return None
    return item


def _valid_previous(item: dict[str, Any], source_hash: str) -> bool:
    if item.get("artifactSchema") != ARTIFACT_SCHEMA or item.get("sourceSha256") != source_hash:
        return False
    for path_key, hash_key in (
        ("providerOutput", "providerOutputSha256"),
        ("cleaned", "cleanedSha256"),
        ("diff", "diffSha256"),
        ("mask", "maskSha256"),
    ):
        candidate = Path(str(item.get(path_key) or ""))
        if not candidate.is_file() or sha256(candidate) != item.get(hash_key):
            return False
    return True


def _valid_provider_previous(item: dict[str, Any], source_hash: str) -> bool:
    if item.get("sourceSha256") != source_hash:
        return False
    candidate = Path(str(item.get("providerOutput") or ""))
    return candidate.is_file() and sha256(candidate) == item.get("providerOutputSha256")


def recover_existing_item(
    output: Path,
    question_id: str,
    source: Path,
    source_hash: str,
) -> dict[str, Any] | None:
    """Recover an interrupted item only when every pixel artifact still matches.

    Older runs wrote the four PNGs before the selection manifest. Recomputing
    cleaned/diff/mask from the current source and saved provider image binds the
    orphaned files to the exact current source without trusting filenames or
    timestamps and avoids paying for the provider request again.
    """
    item_dir = output / question_id
    paths = {
        "providerOutput": item_dir / "provider-output.png",
        "cleaned": item_dir / "cleaned.png",
        "diff": item_dir / "changed-pixels.png",
        "mask": item_dir / "changed-mask.png",
    }
    if not all(path.is_file() for path in paths.values()):
        return None
    try:
        original = Image.open(source).convert("RGB")
        original.load()
        provider_output = Image.open(paths["providerOutput"]).convert("RGB")
        provider_output.load()
        expected_cleaned, geometry = normalize_geometry(original, provider_output)
        expected_diff, expected_mask, metrics = diff_artifacts(original, expected_cleaned)
        actual_cleaned = Image.open(paths["cleaned"]).convert("RGB")
        actual_diff = Image.open(paths["diff"]).convert("RGB")
        actual_mask = Image.open(paths["mask"]).convert("L")
        for image in (actual_cleaned, actual_diff, actual_mask):
            image.load()
    except OSError:
        return None
    if (
        ImageChops.difference(expected_cleaned, actual_cleaned).getbbox()
        or ImageChops.difference(expected_diff, actual_diff).getbbox()
        or ImageChops.difference(expected_mask, actual_mask).getbbox()
    ):
        return None
    return {
        "id": question_id,
        "artifactSchema": ARTIFACT_SCHEMA,
        "source": str(source.resolve()),
        "sourceSha256": source_hash,
        "providerOutput": str(paths["providerOutput"].resolve()),
        "providerOutputSha256": sha256(paths["providerOutput"]),
        "cleaned": str(paths["cleaned"].resolve()),
        "cleanedSha256": sha256(paths["cleaned"]),
        "diff": str(paths["diff"].resolve()),
        "diffSha256": sha256(paths["diff"]),
        "mask": str(paths["mask"].resolve()),
        "maskSha256": sha256(paths["mask"]),
        "provider": {"recoveredFrom": "pixel-verified-local-artifacts"},
        "geometryNormalization": geometry,
        "metrics": metrics,
        "riskFlags": risk_flags(metrics, geometry),
        "review": {
            "printedContentIntact": None,
            "allHandwritingRemoved": None,
            "noAnswerLeak": None,
            "decision": "",
        },
    }


def risk_flags(metrics: dict[str, Any], geometry: dict[str, Any]) -> list[str]:
    flags = []
    if float(metrics.get("changedFraction") or 0) >= 0.03:
        flags.append("large-ink-removal")
    if geometry.get("method") != "identity":
        flags.append("provider-resampled")
    return flags


def review_cards(items: list[dict[str, Any]]) -> str:
    cards = []
    for item in items:
        if not item.get("cleaned"):
            continue
        source_uri = Path(item["source"]).resolve().as_uri()
        cleaned = Path(item["cleaned"]).resolve().as_uri()
        diff = Path(item["diff"]).resolve().as_uri()
        removed = 100 * float((item.get("metrics") or {}).get("changedFraction") or 0)
        flags = item.get("riskFlags") or []
        warning = (
            "<p class='warning'>自動風險：" + html.escape("、".join(flags)) + "</p>"
            if flags else ""
        )
        cards.append(
            "<article><h2>" + html.escape(item["id"]) + "</h2>"
            "<p>只可人工複核，不具發布權。依序核對：印刷公式／圖線完整、手寫全消失、沒有答案洩漏。</p>"
            f"<p>移除墨跡候選：{removed:.3f}%</p>" + warning +
            "<div class='grid'>"
            f"<figure><figcaption>原始裁圖</figcaption><img src='{html.escape(source_uri)}'></figure>"
            f"<figure><figcaption>去手寫候選</figcaption><img src='{html.escape(cleaned)}'></figure>"
            f"<figure><figcaption>被移除的墨跡候選（紅）</figcaption><img src='{html.escape(diff)}'></figure>"
            "</div></article>"
        )
    return "".join(cards)


def review_document(body: str, navigation: str = "") -> str:
    return """<!doctype html><meta charset='utf-8'><title>YesScanner 去手寫複核</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f1eb;color:#332f2a;margin:24px}article{background:#fff;padding:20px;margin:0 auto 24px;max-width:1500px;border:1px solid #d8d3c8;border-radius:12px}h2{font-size:18px}.warning{color:#9b332d;font-weight:700}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{margin:0}figcaption{margin-bottom:8px;font-weight:600}img{width:100%;height:auto;border:1px solid #ccc;background:white}nav{max-width:1500px;margin:0 auto 20px;padding:14px;background:#fff;border:1px solid #d8d3c8;border-radius:12px}nav a{display:inline-block;margin:4px 10px 4px 0}@media(max-width:900px){.grid{grid-template-columns:1fr}}</style>""" + navigation + body


def write_review_html(output: Path, items: list[dict[str, Any]], page_size: int = 50) -> None:
    if page_size < 1:
        raise EraseError("Review page size must be positive")
    successful = [item for item in items if item.get("cleaned")]
    if len(successful) <= page_size:
        (output / "review.html").write_text(
            review_document(review_cards(successful)), encoding="utf-8"
        )
        return
    pages_root = output / "review-pages"
    pages_root.mkdir(parents=True, exist_ok=True)
    page_count = (len(successful) + page_size - 1) // page_size
    links = "<nav><strong>去筆跡複核頁：</strong>" + "".join(
        f"<a href='review-pages/page-{number:04d}.html'>{number}</a>"
        for number in range(1, page_count + 1)
    ) + "</nav>"
    (output / "review.html").write_text(review_document("", links), encoding="utf-8")
    for offset in range(0, len(successful), page_size):
        number = offset // page_size + 1
        previous = f"page-{number - 1:04d}.html" if number > 1 else "../review.html"
        following = f"page-{number + 1:04d}.html" if number < page_count else "../review.html"
        navigation = (
            f"<nav><a href='{previous}'>上一頁</a>"
            f"<strong>{number}/{page_count}</strong>"
            f" <a href='{following}'>下一頁</a> <a href='../review.html'>索引</a></nav>"
        )
        document = review_document(
            review_cards(successful[offset:offset + page_size]), navigation
        )
        (pages_root / f"page-{number:04d}.html").write_text(document, encoding="utf-8")


def erase(
    work: Path,
    ids: list[str],
    output: Path,
    client_id: str,
    client_secret: str,
    *,
    retries: int = 2,
    max_consecutive_errors: int = 5,
    review_every: int = 25,
) -> dict[str, Any]:
    if retries < 0 or max_consecutive_errors < 1 or review_every < 1:
        raise EraseError("Retry, consecutive-error, and review interval values are invalid")
    outside_repo(output)
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "yescanner-handwriting-cleanup.json"
    old_by_id: dict[str, Any] = {}
    old_failures: dict[str, Any] = {}
    prior_started_at = None
    if manifest_path.is_file():
        old = json.loads(manifest_path.read_text(encoding="utf-8"))
        if old.get("service") == SERVICE:
            cached_items = old.get("cacheItems") or old.get("items") or []
            cached_failures = old.get("cacheFailures") or old.get("failures") or []
            old_by_id = {item["id"]: item for item in cached_items}
            old_failures = {item["id"]: item for item in cached_failures}
            prior_started_at = old.get("startedAt")
    items_by_id = dict(old_by_id)
    failures_by_id = dict(old_failures)
    result = {
        "schema": 3,
        "kind": "private-handwriting-cleanup-candidates",
        "service": SERVICE,
        "endpoint": ENDPOINT,
        "scene": SCENE,
        "releaseAuthority": False,
        "humanPixelReviewRequired": True,
        "selectionCount": len(ids),
        "selectionSha256": hashlib.sha256("\n".join(ids).encode("utf-8")).hexdigest(),
        "startedAt": prior_started_at or datetime.now(timezone.utc).isoformat(),
        "generatedAt": None,
        "stoppedEarly": False,
        "progress": {},
        "items": [],
        "failures": [],
        "cacheItems": [],
        "cacheFailures": [],
    }
    progress_path = output / "handwriting-progress.json"
    successful_processed = 0
    failed_processed = 0

    def persist(processed: int, stopped: bool = False, *, manifest: bool = True) -> None:
        completed_ids = ids[:processed]
        ordered_items = [items_by_id[qid] for qid in completed_ids if qid in items_by_id]
        ordered_failures = [failures_by_id[qid] for qid in completed_ids if qid in failures_by_id]
        result["items"] = ordered_items
        result["failures"] = ordered_failures
        result["stoppedEarly"] = stopped
        result["progress"] = {
            "processed": processed,
            "successful": successful_processed,
            "failed": failed_processed,
            "pending": max(0, len(ids) - processed),
        }
        atomic_write(progress_path, {
            "schema": 1,
            "service": SERVICE,
            "selectionCount": len(ids),
            "selectionSha256": result["selectionSha256"],
            "progress": result["progress"],
            "stoppedEarly": stopped,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        })
        if manifest:
            result["cacheItems"] = [items_by_id[qid] for qid in sorted(items_by_id)]
            result["cacheFailures"] = [failures_by_id[qid] for qid in sorted(failures_by_id)]
            atomic_write(manifest_path, result)

    consecutive_errors = 0
    processed = 0
    for index, question_id in enumerate(ids, 1):
        try:
            source = find_stem(work, question_id)
            source_hash = sha256(source)
            previous = (
                load_item_record(output, question_id, source_hash)
                or old_by_id.get(question_id)
            )
            previous_failure = (
                load_provider_record(output, question_id, source_hash)
                or old_failures.get(question_id)
            )
            if previous and _valid_previous(previous, source_hash):
                item = previous
                status = "reused"
            else:
                recovered = recover_existing_item(
                    output, question_id, source, source_hash
                )
                if recovered:
                    item = recovered
                    status = "recovered"
                    items_by_id[question_id] = item
                    failures_by_id.pop(question_id, None)
                    consecutive_errors = 0
                    processed = index
                    successful_processed += 1
                    item_record = {**item, "service": SERVICE}
                    atomic_write(output / question_id / "item-record.json", item_record)
                    persist(processed, manifest=index % review_every == 0)
                    if index % review_every == 0:
                        write_review_html(output, result["items"])
                    print(f"{status} {index}/{len(ids)}: {question_id}", flush=True)
                    continue
                try:
                    original = Image.open(source).convert("RGB")
                    original.load()
                except OSError as error:
                    raise EraseError(f"{question_id}: source crop is not a readable image") from error

                provider_previous = previous if previous and _valid_provider_previous(
                    previous, source_hash
                ) else previous_failure
                if provider_previous and _valid_provider_previous(provider_previous, source_hash):
                    try:
                        provider_output = Image.open(
                            provider_previous["providerOutput"]
                        ).convert("RGB")
                        provider_output.load()
                    except OSError as error:
                        raise EraseError(
                            f"{question_id}: saved provider output is unreadable"
                        ) from error
                    provider = provider_previous.get("provider") or {}
                    status = "rebuilt"
                else:
                    cleaned_bytes, provider = request_clean_with_retry(
                        source, client_id, client_secret, retries
                    )
                    try:
                        provider_output = Image.open(io.BytesIO(cleaned_bytes)).convert("RGB")
                        provider_output.load()
                    except OSError as error:
                        raise EraseError(
                            f"{question_id}: YesScanner result is not a readable image"
                        ) from error
                    status = "cleaned"

                item_dir = output / question_id
                item_dir.mkdir(parents=True, exist_ok=True)
                provider_path = item_dir / "provider-output.png"
                provider_output.save(provider_path, format="PNG", optimize=True)
                provider_record = {
                    "service": SERVICE,
                    "id": question_id,
                    "source": str(source.resolve()),
                    "sourceSha256": source_hash,
                    "providerOutput": str(provider_path.resolve()),
                    "providerOutputSha256": sha256(provider_path),
                    "provider": provider,
                }
                atomic_write(item_dir / "provider-record.json", provider_record)
                # Preserve the paid provider output before local geometry/diff
                # processing. If local QA fails, a resume can rebuild without
                # another provider request.
                failures_by_id[question_id] = {
                    **provider_record,
                    "error": "local-postprocessing-pending",
                    "failedAt": datetime.now(timezone.utc).isoformat(),
                }
                persist(index - 1, manifest=False)

                cleaned, geometry = normalize_geometry(original, provider_output)
                overlay, mask, metrics = diff_artifacts(original, cleaned)
                cleaned_path = item_dir / "cleaned.png"
                diff_path = item_dir / "changed-pixels.png"
                mask_path = item_dir / "changed-mask.png"
                cleaned.save(cleaned_path, format="PNG", optimize=True)
                overlay.save(diff_path, format="PNG", optimize=True)
                mask.save(mask_path, format="PNG", optimize=True)
                item = {
                    **provider_record,
                    "artifactSchema": ARTIFACT_SCHEMA,
                    "cleaned": str(cleaned_path.resolve()),
                    "cleanedSha256": sha256(cleaned_path),
                    "diff": str(diff_path.resolve()),
                    "diffSha256": sha256(diff_path),
                    "mask": str(mask_path.resolve()),
                    "maskSha256": sha256(mask_path),
                    "geometryNormalization": geometry,
                    "metrics": metrics,
                    "riskFlags": risk_flags(metrics, geometry),
                    "review": (previous or {}).get("review") or {
                        "printedContentIntact": None,
                        "allHandwritingRemoved": None,
                        "noAnswerLeak": None,
                        "decision": "",
                    },
                }
            items_by_id[question_id] = item
            failures_by_id.pop(question_id, None)
            consecutive_errors = 0
            processed = index
            successful_processed += 1
            atomic_write(
                output / question_id / "item-record.json",
                {**item, "service": SERVICE},
            )
            persist(processed, manifest=index % review_every == 0)
            if index % review_every == 0:
                write_review_html(output, result["items"])
            print(f"{status} {index}/{len(ids)}: {question_id}", flush=True)
        except (OSError, ValueError, EraseError) as error:
            failures_by_id[question_id] = {
                **(failures_by_id.get(question_id) or {}),
                "id": question_id,
                "error": str(error),
                "failedAt": datetime.now(timezone.utc).isoformat(),
            }
            items_by_id.pop(question_id, None)
            consecutive_errors += 1
            processed = index
            failed_processed += 1
            stopped = consecutive_errors >= max_consecutive_errors
            persist(processed, stopped)
            print(f"failed {index}/{len(ids)}: {question_id}: {error}", file=sys.stderr, flush=True)
            if stopped:
                break
    result["generatedAt"] = datetime.now(timezone.utc).isoformat()
    persist(processed, result["stoppedEarly"])
    write_review_html(output, result["items"])
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path)
    parser.add_argument("--ids", help="comma-separated question IDs")
    parser.add_argument("--ids-file", type=Path, help="UTF-8 file with one question ID per line")
    parser.add_argument("--queue", type=Path, help="review queue JSON whose items contain IDs")
    parser.add_argument(
        "--all-core-chapter-crops",
        action="store_true",
        help="discover every current stem crop in core chapter books",
    )
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--start-after", help="resume selection after this question ID")
    parser.add_argument("--limit", type=int, help="process only the first N selected IDs")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--max-consecutive-errors", type=int, default=5)
    parser.add_argument("--review-every", type=int, default=25)
    parser.add_argument(
        "--store-credentials",
        action="store_true",
        help="read clientId/clientSecret JSON from stdin and store with Windows DPAPI",
    )
    args = parser.parse_args()
    try:
        if args.store_credentials:
            supplied = json.loads(sys.stdin.read())
            stored = store_credentials(
                str(supplied.get("clientId") or ""),
                str(supplied.get("clientSecret") or ""),
                args.credentials,
            )
            print(json.dumps({"stored": str(stored.resolve()), "protection": "Windows-DPAPI-current-user"}))
            return 0
        if not args.work or not args.out:
            raise EraseError("--work and --out are required for cleanup")
        ids = selected_ids(args)
        client_id, client_secret = load_credentials(args.credentials)
        result = erase(
            args.work,
            ids,
            args.out,
            client_id,
            client_secret,
            retries=args.retries,
            max_consecutive_errors=args.max_consecutive_errors,
            review_every=args.review_every,
        )
        print(
            json.dumps(
                {
                    "service": result["service"],
                    "selected": result["selectionCount"],
                    "items": len(result["items"]),
                    "failures": len(result["failures"]),
                    "stoppedEarly": result["stoppedEarly"],
                    "manifest": str((args.out / "yescanner-handwriting-cleanup.json").resolve()),
                    "review": str((args.out / "review.html").resolve()),
                },
                ensure_ascii=False,
            )
        )
        return 2 if result["stoppedEarly"] else 0
    except (OSError, ValueError, EraseError) as error:
        print(f"erase-handwriting-yescanner: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
