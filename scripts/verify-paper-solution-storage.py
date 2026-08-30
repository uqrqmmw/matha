#!/usr/bin/env python3
"""Read-only hash verification for private regional solution Storage objects."""

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


KIND = "matha-private-paper-solution-storage-verification-v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def expected_assets(manifest_path: Path) -> dict[str, dict[str, Any]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("kind") == "matha-official-solution-assets-v1":
        source_id = str(manifest.get("appSourceId") or "")
        assets = manifest.get("assets") or []
        bindings = manifest.get("questionPageMap") or []
        if (not source_id or len(assets) < 1 or len(bindings) != 20
                or int(manifest.get("sourcePages") or 0) != len(assets)):
            raise ValueError("official solution manifest is invalid")
        rows: dict[str, dict[str, Any]] = {}
        for row in assets:
            relative = str(row.get("file") or "").replace("\\", "/")
            if not relative.startswith(f"{source_id}/") or relative in rows:
                raise ValueError("official solution asset path is invalid or duplicated")
            rows[relative] = row
        return rows
    if (manifest.get("kind") != "matha-private-paper-solution-assets-v1"
            or int(manifest.get("paperCount") or 0) < 1):
        raise ValueError("private solution asset manifest is invalid")
    rows: dict[str, dict[str, Any]] = {}
    for paper in manifest.get("papers") or []:
        source_id = str(paper.get("appSourceId") or "")
        assets = paper.get("assets") or []
        bindings = paper.get("questionSolutionFiles") or []
        if not source_id or not assets or len(bindings) != 20:
            raise ValueError("private solution assets require 20 explicit bindings")
        known = {str(row.get("file") or "").replace("\\", "/") for row in assets}
        if any(not files or any(file not in known for file in files) for files in bindings):
            raise ValueError("private solution question binding is outside its assets")
        for row in assets:
            relative = str(row.get("file") or "").replace("\\", "/")
            if not relative.startswith(f"{source_id}/") or relative in rows:
                raise ValueError("private solution asset path is invalid or duplicated")
            rows[relative] = row
    if len(rows) != int(manifest.get("assetCount") or -1):
        raise ValueError("private solution asset count does not match")
    return rows


def verify_readback(expected: dict[str, dict[str, Any]], readback_root: Path,
                    remote_names: dict[str, list[str]]) -> list[dict[str, Any]]:
    expected_paths = set(expected)
    listed_paths = {f"{source_id}/{name}" for source_id, names in remote_names.items()
                    for name in names}
    if listed_paths != expected_paths:
        raise ValueError("remote solution listing does not exactly match the manifest")
    source_dirs = {relative.split("/", 1)[0] for relative in expected_paths}
    actual_paths = {path.relative_to(readback_root).as_posix()
                    for source_dir in source_dirs
                    for path in (readback_root / source_dir).rglob("*") if path.is_file()}
    if actual_paths != expected_paths:
        raise ValueError("solution readback file set does not exactly match the manifest")
    verified = []
    for relative in sorted(expected_paths):
        path = readback_root / relative
        row = expected[relative]
        digest = sha256(path)
        if digest != str(row.get("sha256") or "").lower():
            raise ValueError(f"solution readback hash mismatch: {relative}")
        if path.stat().st_size != int(row.get("bytes") or -1):
            raise ValueError(f"solution readback byte mismatch: {relative}")
        verified.append({"file": relative, "sha256": digest, "bytes": path.stat().st_size})
    return verified


def list_remote(npx: str, project_ref: str, bucket: str,
                source_ids: list[str]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for source_id in source_ids:
        completed = subprocess.run(
            [npx, "supabase", "--experimental", "storage", "ls",
             f"ss:///{bucket}/{source_id}/", "--project-ref", project_ref,
             "--output-format", "json"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=90, check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError((completed.stderr or f"Storage listing failed: {source_id}").strip())
        paths = json.loads(completed.stdout).get("paths")
        if not isinstance(paths, list) or any(not isinstance(name, str) for name in paths):
            raise RuntimeError(f"Storage listing is invalid: {source_id}")
        result[source_id] = sorted(paths)
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
    parser.add_argument("--bucket", default="matha-solutions")
    parser.add_argument("--npx", default=shutil.which("npx") or "npx")
    args = parser.parse_args()
    manifest_path = args.asset_manifest.resolve()
    expected = expected_assets(manifest_path)
    source_ids = sorted({relative.split("/", 1)[0] for relative in expected})
    remote_names = list_remote(args.npx, args.project_ref, args.bucket, source_ids)
    if args.offline_readback:
        if args.readback_root is None:
            raise ValueError("--offline-readback requires --readback-root")
        verified = verify_readback(expected, args.readback_root.resolve(), remote_names)
        readback_mode = "offline-cache"
    else:
        with tempfile.TemporaryDirectory(prefix="matha-solution-live-readback-") as temporary:
            readback_root = download_assets(
                expected, Path(temporary), project_ref=args.project_ref,
                bucket=args.bucket, npx=args.npx,
            )
            verified = verify_readback(expected, readback_root, remote_names)
        readback_mode = "live-authenticated-download"
    version = subprocess.run([args.npx, "supabase", "--version"], capture_output=True,
                             text=True, encoding="utf-8", errors="replace", timeout=60,
                             check=True).stdout.strip()
    output = {
        "kind": KIND, "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "releaseAuthority": False, "readOnlyVerification": True,
        "readbackMode": readback_mode, "credentialsSerialized": False,
        "projectRef": args.project_ref, "bucket": args.bucket,
        "supabaseCliVersion": version, "sourceManifestSha256": sha256(manifest_path),
        "paperCount": len(source_ids), "assetCount": len(verified),
        "remoteHashMismatches": 0,
        "papers": [{"appSourceId": source_id, "remoteNames": remote_names[source_id]}
                   for source_id in source_ids],
        "assets": verified,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    print(json.dumps({"output": str(args.output.resolve()), "papers": len(source_ids),
                      "assets": len(verified), "mismatches": 0}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
