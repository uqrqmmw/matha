#!/usr/bin/env python3
"""Verify the private official-paper Storage objects against local source assets.

The command is read-only: it lists the linked Supabase bucket, hashes a prior
Storage readback directory, and writes a private verification manifest.  It
never uploads, deletes, calls OCR/OpenAI, or prints answer keys.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from scripts.storage_live_readback import download_assets
except ModuleNotFoundError:  # direct `python scripts/...py` execution
    from storage_live_readback import download_assets


KIND = "matha-official-paper-storage-verification-v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def expected_assets(manifest_path: Path) -> dict[str, dict[str, Any]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    paper_count = int(manifest.get("paperCount") or 0)
    asset_count = int(manifest.get("assetCount") or 0)
    if (manifest.get("kind") != "matha-official-paper-assets-v1"
            or paper_count < 1 or asset_count < paper_count):
        raise ValueError("private paper asset manifest has an invalid asset count")
    rows: dict[str, dict[str, Any]] = {}
    for paper in manifest.get("papers") or []:
        paper_id = str(paper.get("paperId") or "")
        assets = paper.get("assets") or []
        question_pages = paper.get("questionPdfPages") or []
        if (not paper_id or not assets or len(assets) != len(question_pages)
                or len(paper.get("questionPageMap") or []) != 20):
            raise ValueError("private paper assets must match their explicit question pages")
        for row in assets:
            relative = str(row.get("file") or "").replace("\\", "/")
            if not relative.startswith(f"{paper_id}/") or relative in rows:
                raise ValueError("official asset path is missing, duplicated, or outside its paper")
            rows[relative] = row
    if len(rows) != asset_count:
        raise ValueError("official asset manifest asset count does not match unique assets")
    return rows


def verify_readback(expected: dict[str, dict[str, Any]], readback_root: Path,
                    remote_names: dict[str, list[str]]) -> list[dict[str, Any]]:
    expected_paths = set(expected)
    listed_paths = {
        f"{paper_id}/{name}" for paper_id, names in remote_names.items() for name in names
    }
    if listed_paths != expected_paths:
        missing = sorted(expected_paths - listed_paths)
        extra = sorted(listed_paths - expected_paths)
        raise ValueError(f"remote listing mismatch; missing={missing[:3]}, extra={extra[:3]}")
    expected_paper_dirs = {relative.split("/", 1)[0] for relative in expected_paths}
    actual_files = {
        path.relative_to(readback_root).as_posix()
        for paper_dir in expected_paper_dirs
        for path in (readback_root / paper_dir).rglob("*") if path.is_file()
    }
    if actual_files != expected_paths:
        missing = sorted(expected_paths - actual_files)
        extra = sorted(actual_files - expected_paths)
        raise ValueError(f"readback file set mismatch; missing={missing[:3]}, extra={extra[:3]}")
    verified = []
    for relative in sorted(expected_paths):
        path = readback_root / Path(relative)
        digest = sha256(path)
        row = expected[relative]
        if digest != str(row.get("sha256") or "").lower():
            raise ValueError(f"readback hash mismatch: {relative}")
        if path.stat().st_size != int(row.get("bytes") or -1):
            raise ValueError(f"readback byte count mismatch: {relative}")
        verified.append({"file": relative, "sha256": digest, "bytes": path.stat().st_size})
    return verified


def supabase_version(npx: str) -> str:
    completed = subprocess.run(
        [npx, "supabase", "--version"], capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=60, check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or "supabase --version failed").strip())
    return completed.stdout.strip()


def list_remote(npx: str, bucket: str, paper_ids: list[str]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for paper_id in paper_ids:
        completed = subprocess.run(
            [npx, "supabase", "storage", "ls", f"ss:///{bucket}/{paper_id}/",
             "--linked", "--experimental", "--output-format", "json"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=90, check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or f"Storage listing failed: {paper_id}").strip())
        payload = json.loads(completed.stdout)
        paths = payload.get("paths")
        if not isinstance(paths, list) or any(not isinstance(name, str) for name in paths):
            raise RuntimeError(f"Storage listing is invalid: {paper_id}")
        result[paper_id] = sorted(paths)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-manifest", required=True, type=Path)
    parser.add_argument("--readback-root", type=Path,
                        help="prior cache; accepted only together with --offline-readback")
    parser.add_argument("--offline-readback", action="store_true",
                        help="diagnostic only; cannot satisfy the live release gate")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--bucket", default="matha-papers")
    parser.add_argument("--npx", default=shutil.which("npx") or "npx")
    args = parser.parse_args()

    manifest_path = args.asset_manifest.resolve()
    expected = expected_assets(manifest_path)
    paper_ids = sorted({relative.split("/", 1)[0] for relative in expected})
    remote_names = list_remote(args.npx, args.bucket, paper_ids)
    if args.offline_readback:
        if args.readback_root is None:
            raise ValueError("--offline-readback requires --readback-root")
        verified = verify_readback(expected, args.readback_root.resolve(), remote_names)
        readback_mode = "offline-cache"
    else:
        with tempfile.TemporaryDirectory(prefix="matha-paper-live-readback-") as temporary:
            readback_root = download_assets(
                expected, Path(temporary), project_ref=args.project_ref,
                bucket=args.bucket, npx=args.npx,
            )
            verified = verify_readback(expected, readback_root, remote_names)
        readback_mode = "live-authenticated-download"
    output = {
        "kind": KIND,
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "releaseAuthority": False,
        "readOnlyVerification": True,
        "readbackMode": readback_mode,
        "credentialsSerialized": False,
        "projectRef": args.project_ref,
        "bucket": args.bucket,
        "supabaseCliVersion": supabase_version(args.npx),
        "sourceManifestSha256": sha256(manifest_path),
        "paperCount": len(paper_ids),
        "assetCount": len(verified),
        "remoteHashMismatches": 0,
        "papers": [{"paperId": paper_id, "remoteNames": remote_names[paper_id]}
                   for paper_id in paper_ids],
        "assets": verified,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output.resolve()), "papers": len(paper_ids),
        "assets": len(verified), "mismatches": 0,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
