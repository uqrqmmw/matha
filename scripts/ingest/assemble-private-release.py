#!/usr/bin/env python3
"""Build and assemble an upload-ready private content/asset release bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import re
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MANIFEST_ALIAS = "manifest-mistral-ocr4-verified-v1.json"
SAFE_RELEASE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{7,63}$")


class BundleError(RuntimeError):
    """A fail-closed private bundle assembly error."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise BundleError(f"Expected JSON object: {path}")
    return value


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
    raise BundleError(f"Private release bundle must stay outside Git: {resolved}")


def safe_join(root: Path, relative: str) -> Path:
    if not relative or relative.startswith(("/", "\\")) or ".." in Path(relative).parts:
        raise BundleError(f"Unsafe asset path: {relative!r}")
    target = (root / Path(relative)).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError as error:
        raise BundleError(f"Asset path escapes bundle: {relative!r}") from error
    return target


def assemble(source_file: Path, promotion_root: Path, output_root: Path) -> dict[str, Any]:
    promotion_root, output_root = outside_repo(promotion_root), outside_repo(output_root)
    if output_root.exists() and any(output_root.iterdir()):
        raise BundleError("Output directory must be empty to prevent stale upload files")
    output_root.mkdir(parents=True, exist_ok=True)
    source = read_json(source_file)
    if source.get("kind") != "private-question-source" \
            or source.get("mathematicalCorrectnessVerified") is not True \
            or not source.get("releaseApprovedBy"):
        raise BundleError("Source must be mathematically verified and human-signed")
    release_id = source.get("releaseId")
    if not isinstance(release_id, str) or not SAFE_RELEASE_ID.fullmatch(release_id):
        raise BundleError("Source releaseId is missing or unsafe")
    release_prefix = f"releases/{release_id}"

    build_root = output_root / "_build"
    command = ["node", str(REPO_ROOT / "scripts" / "build-private-bank.js"),
               "--source", str(source_file.resolve()), "--output", str(build_root)]
    completed = subprocess.run(
        command, cwd=REPO_ROOT, text=True, encoding="utf-8",
        capture_output=True, check=False,
    )
    if completed.returncode:
        raise BundleError(f"Private bank build failed: {completed.stderr[:1200]}")
    manifest = read_json(build_root / "manifest.json")
    if manifest.get("releaseReady") is not True or not all((manifest.get("releaseChecks") or {}).values()):
        raise BundleError("Built manifest did not pass every release check")

    content_root = output_root / "matha-content"
    figure_root = output_root / "matha-figures"
    content_root.mkdir(parents=True, exist_ok=True)
    figure_root.mkdir(parents=True, exist_ok=True)
    content_files = []
    for pack in manifest.get("packs") or []:
        filename = pack["file"]
        source_path = build_root / filename
        versioned = f"{release_prefix}/content/{filename}"
        target = safe_join(content_root, versioned)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target)
        pack["file"] = versioned
        content_files.append({"path": versioned, "sha256": sha256(target), "bytes": target.stat().st_size})
    pending_source = build_root / "pending-visuals.json"
    pending_versioned = f"{release_prefix}/content/pending-visuals.json"
    pending_target = safe_join(content_root, pending_versioned)
    pending_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(pending_source, pending_target)
    content_files.append({"path": pending_versioned, "sha256": sha256(pending_target),
                          "bytes": pending_target.stat().st_size})
    manifest["releaseId"] = release_id
    if isinstance(manifest.get("pendingVisuals"), dict):
        manifest["pendingVisuals"]["file"] = pending_versioned
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    versioned_manifest_path = f"{release_prefix}/manifest.json"
    versioned_manifest = safe_join(content_root, versioned_manifest_path)
    versioned_manifest.parent.mkdir(parents=True, exist_ok=True)
    versioned_manifest.write_bytes(manifest_bytes)
    content_files.append({"path": versioned_manifest_path, "sha256": sha256(versioned_manifest),
                          "bytes": versioned_manifest.stat().st_size})
    manifest_target = content_root / MANIFEST_ALIAS
    manifest_target.write_bytes(manifest_bytes)
    content_files.append({"path": MANIFEST_ALIAS, "sha256": sha256(manifest_target),
                          "bytes": manifest_target.stat().st_size})

    figure_files = []
    seen_paths = set()
    for question in source.get("questions") or []:
        asset = question.get("stemAsset") or {}
        relative = str(asset.get("path") or "")
        if relative in seen_paths:
            raise BundleError(f"Duplicate stem asset path: {relative}")
        seen_paths.add(relative)
        source_asset = safe_join(
            promotion_root / "promoted" / question["bookId"] / "stem-assets", relative)
        if not source_asset.is_file() or sha256(source_asset) != asset.get("sha256"):
            raise BundleError(f"Promoted asset missing or hash mismatch: {question['id']}")
        target = safe_join(figure_root, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_asset, target)
        if sha256(target) != asset["sha256"]:
            raise BundleError(f"Copied stem asset changed: {question['id']}")
        figure_files.append({"path": relative, "sha256": asset["sha256"],
                             "bytes": target.stat().st_size, "questionId": question["id"]})

    plan = {
        "kind": "matha-private-storage-upload-plan", "version": 1,
        "releaseReady": True, "uploadPerformed": False,
        "releaseId": release_id,
        "manifestAlias": MANIFEST_ALIAS,
        "versionedManifest": versioned_manifest_path,
        "source": str(source_file.resolve()), "sourceSha256": sha256(source_file),
        "releaseApprovedBy": source["releaseApprovedBy"],
        "buckets": {
            "matha-content": {"root": str(content_root), "files": content_files},
            "matha-figures": {"root": str(figure_root), "files": figure_files},
        },
        "summary": {"questions": len(source.get("questions") or []),
                    "contentFiles": len(content_files), "stemAssets": len(figure_files)},
    }
    plan_file = output_root / "upload-plan.json"
    plan_file.write_text(json.dumps(plan, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {**plan["summary"], "manifestAlias": MANIFEST_ALIAS,
            "releaseId": release_id, "versionedManifest": versioned_manifest_path,
            "uploadPlan": str(plan_file), "uploadPlanSha256": sha256(plan_file)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--promotion-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = assemble(args.source, args.promotion_root, args.output)
    except (BundleError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"assemble-private-release: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
