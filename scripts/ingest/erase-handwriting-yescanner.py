#!/usr/bin/env python3
"""Create review-only handwriting-removal candidates with YesScanner.

The printed source remains authoritative.  This tool sends only explicitly
selected stem crops, stores lossless cleaned/difference images and provenance,
and never promotes a result into the student bank.  Credentials are read only
from YESCANNER_CLIENT_ID and YESCANNER_CLIENT_SECRET.
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
    # YesScanner normalizes many document crops to a larger inference canvas.
    # Permit only near-uniform scaling; crop/dewarp/rotation remains forbidden.
    if aspect_drift > 0.005:
        raise EraseError(
            "YesScanner changed image geometry beyond uniform scaling: "
            f"{before.size} -> {output.size} (aspect drift {aspect_drift:.6f})"
        )
    normalized = output.resize(before.size, Image.Resampling.LANCZOS)
    return normalized, {
        "method": "uniform-resize-lanczos",
        "providerWidth": output.width,
        "providerHeight": output.height,
        "normalizedWidth": before.width,
        "normalizedHeight": before.height,
        "aspectDrift": aspect_drift,
    }


def atomic_write(path: Path, document: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(path)


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


def risk_flags(metrics: dict[str, Any], geometry: dict[str, Any]) -> list[str]:
    flags = []
    if float(metrics.get("changedFraction") or 0) >= 0.03:
        flags.append("large-ink-removal")
    if geometry.get("method") != "identity":
        flags.append("provider-resampled")
    return flags


def write_review_html(output: Path, items: list[dict[str, Any]]) -> None:
    cards = []
    for item in items:
        item_dir = Path(item["cleaned"]).parent
        source_uri = Path(item["source"]).resolve().as_uri()
        cleaned = item_dir.relative_to(output).as_posix() + "/cleaned.png"
        diff = item_dir.relative_to(output).as_posix() + "/changed-pixels.png"
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
    document = """<!doctype html><meta charset='utf-8'><title>YesScanner 去手寫複核</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f1eb;color:#332f2a;margin:24px}article{background:#fff;padding:20px;margin:0 auto 24px;max-width:1500px;border:1px solid #d8d3c8;border-radius:12px}h2{font-size:18px}.warning{color:#9b332d;font-weight:700}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{margin:0}figcaption{margin-bottom:8px;font-weight:600}img{width:100%;height:auto;border:1px solid #ccc;background:white}@media(max-width:900px){.grid{grid-template-columns:1fr}}</style>""" + "".join(cards)
    (output / "review.html").write_text(document, encoding="utf-8")


def erase(
    work: Path,
    ids: list[str],
    output: Path,
    client_id: str,
    client_secret: str,
) -> dict[str, Any]:
    outside_repo(output)
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "yescanner-handwriting-cleanup.json"
    old_by_id: dict[str, Any] = {}
    if manifest_path.is_file():
        old = json.loads(manifest_path.read_text(encoding="utf-8"))
        if old.get("service") == SERVICE:
            old_by_id = {item["id"]: item for item in old.get("items") or []}
    result = {
        "schema": 2,
        "kind": "private-handwriting-cleanup-candidates",
        "service": SERVICE,
        "endpoint": ENDPOINT,
        "scene": SCENE,
        "releaseAuthority": False,
        "humanPixelReviewRequired": True,
        "generatedAt": None,
        "items": [],
    }
    for index, question_id in enumerate(ids, 1):
        source = find_stem(work, question_id)
        source_hash = sha256(source)
        previous = old_by_id.get(question_id)
        if previous and _valid_previous(previous, source_hash):
            item = previous
            status = "reused"
        else:
            try:
                original = Image.open(source).convert("RGB")
                original.load()
            except OSError as error:
                raise EraseError(f"{question_id}: source crop is not a readable image") from error
            if previous and _valid_provider_previous(previous, source_hash):
                try:
                    provider_output = Image.open(previous["providerOutput"]).convert("RGB")
                    provider_output.load()
                except OSError as error:
                    raise EraseError(f"{question_id}: saved provider output is unreadable") from error
                provider = previous.get("provider") or {}
                status = "rebuilt"
            else:
                cleaned_bytes, provider = request_clean(source, client_id, client_secret)
                try:
                    provider_output = Image.open(io.BytesIO(cleaned_bytes)).convert("RGB")
                    provider_output.load()
                except OSError as error:
                    raise EraseError(f"{question_id}: YesScanner result is not a readable image") from error
                status = "cleaned"
            cleaned, geometry = normalize_geometry(original, provider_output)
            overlay, mask, metrics = diff_artifacts(original, cleaned)
            item_dir = output / question_id
            item_dir.mkdir(parents=True, exist_ok=True)
            provider_path = item_dir / "provider-output.png"
            cleaned_path = item_dir / "cleaned.png"
            diff_path = item_dir / "changed-pixels.png"
            mask_path = item_dir / "changed-mask.png"
            provider_output.save(provider_path, format="PNG", optimize=True)
            cleaned.save(cleaned_path, format="PNG", optimize=True)
            overlay.save(diff_path, format="PNG", optimize=True)
            mask.save(mask_path, format="PNG", optimize=True)
            item = {
                "id": question_id,
                "artifactSchema": ARTIFACT_SCHEMA,
                "source": str(source.resolve()),
                "sourceSha256": source_hash,
                "providerOutput": str(provider_path.resolve()),
                "providerOutputSha256": sha256(provider_path),
                "cleaned": str(cleaned_path.resolve()),
                "cleanedSha256": sha256(cleaned_path),
                "diff": str(diff_path.resolve()),
                "diffSha256": sha256(diff_path),
                "mask": str(mask_path.resolve()),
                "maskSha256": sha256(mask_path),
                "provider": provider,
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
        result["items"].append(item)
        atomic_write(manifest_path, result)
        write_review_html(output, result["items"])
        print(f"{status} {index}/{len(ids)}: {question_id}", flush=True)
    result["generatedAt"] = datetime.now(timezone.utc).isoformat()
    atomic_write(manifest_path, result)
    write_review_html(output, result["items"])
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path)
    parser.add_argument("--ids", help="comma-separated question IDs")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
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
        if not args.work or not args.ids or not args.out:
            raise EraseError("--work, --ids and --out are required for cleanup")
        ids = [value.strip() for value in args.ids.split(",") if value.strip()]
        if not ids or len(ids) != len(set(ids)):
            raise EraseError("--ids must contain unique question IDs")
        client_id, client_secret = load_credentials(args.credentials)
        result = erase(args.work, ids, args.out, client_id, client_secret)
        print(
            json.dumps(
                {
                    "service": result["service"],
                    "items": len(result["items"]),
                    "manifest": str((args.out / "yescanner-handwriting-cleanup.json").resolve()),
                    "review": str((args.out / "review.html").resolve()),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except (OSError, ValueError, EraseError) as error:
        print(f"erase-handwriting-yescanner: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
