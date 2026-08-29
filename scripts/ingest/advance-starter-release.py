#!/usr/bin/env python3
"""Advance one human-reviewed starter batch to a signed private bundle.

This coordinator does not weaken any gate and never calls OCR or a model.
``stage`` discovers the exact batch-bound human review exports (or accepts
explicit paths), runs the dual-review intersection, and prepares the fixed
visual release sample. ``finalize`` discovers the exact release signoff, checks
it, and assembles the immutable Storage upload plan. Upload remains a separate
explicit operation so an unsigned or ambiguous file can never switch production.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
PRIVATE_SERIES = "matha-starter-v4"
PRIVATE_DATE = "20260829"


class AdvanceError(RuntimeError):
    pass


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    if spec is None or spec.loader is None:
        raise AdvanceError(f"cannot load pipeline module: {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


intersection = load_module("matha_intersection", "intersect-cleaned-human-reviews.py")
release = load_module("matha_starter_release", "prepare-starter-private-release.py")
bundle = load_module("matha_release_bundle", "assemble-private-release.py")
deployment = load_module("matha_release_deployment", "deploy-private-release.py")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise AdvanceError(f"{label} does not exist: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AdvanceError(f"{label} must be a JSON object")
    return value


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise AdvanceError(f"private workflow output must stay outside Git: {resolved}")


def reviewed_time(value: Any) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as error:
        raise AdvanceError("reviewedAt is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise AdvanceError("reviewedAt must include a timezone")
    return parsed


def discover_review(downloads: Path, *, kind: str, candidate_hash: str,
                    explicit: Path | None) -> Path:
    if explicit is not None:
        candidates = [explicit.resolve()]
    else:
        prefix = (
            "cleaned-handwriting-human-review"
            if kind == "matha-private-cleaned-handwriting-human-review"
            else "cleaned-answer-human-review"
        )
        candidates = sorted(downloads.glob(f"{prefix}*.json")) if downloads.is_dir() else []
    matches: list[tuple[datetime, int, str, Path]] = []
    for path in candidates:
        try:
            value = load_json(path, "human review")
            if value.get("kind") != kind or value.get("candidateManifestSha256") != candidate_hash:
                continue
            when = reviewed_time(value.get("reviewedAt"))
            matches.append((when, path.stat().st_mtime_ns, sha256(path), path.resolve()))
        except (AdvanceError, OSError, ValueError, json.JSONDecodeError):
            if explicit is not None:
                raise
    if not matches:
        raise AdvanceError(f"no exact {kind} export was found")
    matches.sort(key=lambda row: (row[0], row[1]), reverse=True)
    newest = matches[0]
    tied = [row for row in matches if row[0] == newest[0] and row[2] != newest[2]]
    if tied:
        raise AdvanceError(f"ambiguous {kind} exports share the newest reviewedAt")
    return newest[3]


def batch_paths(private_root: Path, batch_number: int) -> dict[str, Path]:
    batch = f"{batch_number:02d}"
    queue_root = private_root / f"matha-starter-queue-v4-{PRIVATE_DATE}"
    pixel_root = private_root / f"{PRIVATE_SERIES}-batch-{batch}-pixel-{PRIVATE_DATE}"
    answer_root = private_root / f"{PRIVATE_SERIES}-batch-{batch}-answer-{PRIVATE_DATE}"
    return {
        "candidate": queue_root / f"batch-{batch}-cleaned-candidates.json",
        "selection": queue_root / "starter-review-selection.json",
        "pixelTemplate": pixel_root / "cleaned-handwriting-human-review.template.json",
        "answerBinding": answer_root / "answer-binding-candidates.json",
    }


def validate_existing_dual(path: Path, expected: dict[str, str]) -> dict[str, Any]:
    value = load_json(path, "existing dual review")
    if (value.get("kind") != "matha-private-cleaned-dual-review-candidates"
            or value.get("releaseAuthority") is not False
            or value.get("uploadPerformed") is not False):
        raise AdvanceError("existing dual review is not a safe staged manifest")
    for field, wanted in expected.items():
        if value.get(field) != wanted:
            raise AdvanceError(f"existing dual review {field} does not match current input")
    return value


def validate_existing_preparation(path: Path, dual_file: Path,
                                  selection_file: Path) -> dict[str, Any]:
    packet = load_json(path / "release-review-packet.json", "release review packet")
    source = path / "unsigned-private-question-source.json"
    assets = path / "asset-manifest.json"
    if (packet.get("kind") != "matha-starter-private-release-review-packet"
            or packet.get("releaseAuthority") is not False
            or packet.get("selectionSha256") != sha256(selection_file)
            or packet.get("dualReviewSha256") != [sha256(dual_file)]
            or packet.get("unsignedSourceSha256") != sha256(source)
            or packet.get("assetManifestSha256") != sha256(assets)):
        raise AdvanceError("existing release preparation does not match current inputs")
    return packet


def rebase_bundle_plan(plan_file: Path, bundle_root: Path) -> None:
    plan = load_json(plan_file, "upload plan after atomic bundle move")
    buckets = plan.get("buckets")
    if not isinstance(buckets, dict) or not buckets:
        raise AdvanceError("upload plan has no bucket roots to rebase")
    for bucket_name, payload in buckets.items():
        root = (bundle_root / str(bucket_name)).resolve()
        if not isinstance(payload, dict) or not root.is_dir():
            raise AdvanceError(f"moved bundle is missing bucket directory: {bucket_name}")
        payload["root"] = str(root)
    partial = plan_file.with_suffix(".partial.json")
    partial.write_text(json.dumps(plan, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    partial.replace(plan_file)


def stage(*, batch_number: int, private_root: Path, downloads: Path,
          pdf_root: Path, work_root: Path, pixel_review: Path | None,
          answer_review: Path | None) -> dict[str, Any]:
    work_root = outside_repo(work_root)
    paths = batch_paths(private_root, batch_number)
    for label, path in paths.items():
        if not path.is_file():
            raise AdvanceError(f"missing {label}: {path}")
    candidate_hash = sha256(paths["candidate"])
    pixel = discover_review(
        downloads, kind="matha-private-cleaned-handwriting-human-review",
        candidate_hash=candidate_hash, explicit=pixel_review,
    )
    answer = discover_review(
        downloads, kind="matha-private-cleaned-answer-human-review",
        candidate_hash=candidate_hash, explicit=answer_review,
    )
    work_root.mkdir(parents=True, exist_ok=True)
    dual_file = work_root / "dual-review.json"
    expected = {
        "candidateManifestSha256": candidate_hash,
        "pixelReviewTemplateSha256": sha256(paths["pixelTemplate"]),
        "pixelReviewSha256": sha256(pixel),
        "answerBindingSha256": sha256(paths["answerBinding"]),
        "answerReviewSha256": sha256(answer),
    }
    if dual_file.exists():
        dual = validate_existing_dual(dual_file, expected)
    else:
        dual_partial = work_root / "dual-review.partial.json"
        dual_partial.unlink(missing_ok=True)
        dual = intersection.intersect(
            paths["candidate"], paths["pixelTemplate"], pixel,
            paths["answerBinding"], answer, dual_partial,
        )
        dual_partial.replace(dual_file)
    if not dual.get("items"):
        raise AdvanceError("both reviews produced zero eligible questions")
    preparation = work_root / "release-preparation"
    if preparation.exists():
        packet = validate_existing_preparation(preparation, dual_file, paths["selection"])
    else:
        preparation_partial = work_root / "release-preparation.partial"
        if preparation_partial.exists():
            shutil.rmtree(preparation_partial)
        packet = release.prepare(
            [dual_file], paths["selection"], pdf_root, preparation_partial
        )
        preparation_partial.replace(preparation)
    return {
        "phase": "awaiting-release-signoff",
        "batch": batch_number,
        "eligibleQuestions": len(dual.get("items") or []),
        "pixelReview": str(pixel), "answerReview": str(answer),
        "dualReview": str(dual_file),
        "releaseReview": str(preparation / "release-review.html"),
        "releaseId": packet.get("releaseId"),
        "sampleSize": packet.get("sampleSize"),
        "next": "Open release-review.html, complete the exact visual sample, and export the signoff JSON.",
    }


def discover_signoff(downloads: Path, source_file: Path,
                     explicit: Path | None) -> Path:
    source = load_json(source_file, "unsigned private source")
    source_hash = sha256(source_file)
    candidates = [explicit.resolve()] if explicit else (
        sorted(downloads.glob("starter-private-release-signoff*.json"))
        if downloads.is_dir() else []
    )
    matches: list[tuple[datetime, int, str, Path]] = []
    for path in candidates:
        try:
            value = load_json(path, "release signoff")
            if (value.get("kind") != "matha-starter-private-release-signoff"
                    or value.get("releaseId") != source.get("releaseId")
                    or value.get("unsignedSourceSha256") != source_hash):
                continue
            when = reviewed_time(value.get("approvedAt"))
            matches.append((when, path.stat().st_mtime_ns, sha256(path), path.resolve()))
        except (AdvanceError, OSError, ValueError, json.JSONDecodeError):
            if explicit is not None:
                raise
    if not matches:
        raise AdvanceError("no exact release signoff export was found")
    matches.sort(key=lambda row: (row[0], row[1]), reverse=True)
    newest = matches[0]
    if any(row[0] == newest[0] and row[2] != newest[2] for row in matches):
        raise AdvanceError("ambiguous release signoffs share the newest approvedAt")
    return newest[3]


def finalize(*, work_root: Path, downloads: Path,
             signoff: Path | None) -> dict[str, Any]:
    work_root = outside_repo(work_root)
    preparation = work_root / "release-preparation"
    source_file = preparation / "unsigned-private-question-source.json"
    asset_file = preparation / "asset-manifest.json"
    signoff_file = discover_signoff(downloads, source_file, signoff)
    signed_file = work_root / "signed-private-question-source.json"
    if signed_file.exists():
        signed = load_json(signed_file, "existing signed source")
        approval = signed.get("releaseApproval") or {}
        if (approval.get("signoffSha256") != sha256(signoff_file)
                or approval.get("unsignedSourceSha256") != sha256(source_file)
                or approval.get("assetManifestSha256") != sha256(asset_file)):
            raise AdvanceError("existing signed source does not match current signoff")
    else:
        signed_partial = work_root / "signed-private-question-source.partial.json"
        signed_partial.unlink(missing_ok=True)
        release.finalize(source_file, asset_file, signoff_file, signed_partial)
        signed_partial.replace(signed_file)
    output = work_root / "private-bundle"
    if output.exists():
        plan_file = output / "upload-plan.json"
        plan, versioned, alias = deployment.validate_plan(plan_file)
        if plan.get("sourceSha256") != sha256(signed_file):
            raise AdvanceError("existing bundle does not match current signed source")
    else:
        output_partial = work_root / "private-bundle.partial"
        if output_partial.exists():
            shutil.rmtree(output_partial)
        result = bundle.assemble(signed_file, preparation / "promotion", output_partial)
        output_partial.replace(output)
        plan_file = output / Path(result["uploadPlan"]).name
        rebase_bundle_plan(plan_file, output)
        plan, versioned, alias = deployment.validate_plan(plan_file)
    return {
        "phase": "ready-for-explicit-supabase-deploy",
        "releaseId": plan.get("releaseId"),
        "questions": (plan.get("summary") or {}).get("questions"),
        "versionedObjects": len(versioned),
        "manifestAlias": alias.get("path"),
        "uploadPlan": str(plan_file),
        "uploadPlanSha256": sha256(plan_file),
        "signoff": str(signoff_file),
        "next": "Deploy with deploy-private-release.py only after recording the current remote alias hash.",
    }


def main(argv: list[str] | None = None) -> int:
    desktop = Path.home() / "Desktop"
    default_private = desktop / "數學檔案"
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    stage_parser = commands.add_parser("stage")
    stage_parser.add_argument("--batch", type=int, choices=range(1, 12), default=1)
    stage_parser.add_argument("--private-root", type=Path, default=default_private)
    stage_parser.add_argument("--downloads", type=Path, default=Path.home() / "Downloads")
    stage_parser.add_argument("--pdf-root", type=Path, default=default_private / "蝦皮掃描檔")
    stage_parser.add_argument("--work-root", type=Path)
    stage_parser.add_argument("--pixel-review", type=Path)
    stage_parser.add_argument("--answer-review", type=Path)
    final_parser = commands.add_parser("finalize")
    final_parser.add_argument("--work-root", type=Path, required=True)
    final_parser.add_argument("--downloads", type=Path, default=Path.home() / "Downloads")
    final_parser.add_argument("--signoff", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "stage":
            work_root = args.work_root or (
                args.private_root / f"{PRIVATE_SERIES}-batch-{args.batch:02d}-release-workflow-{PRIVATE_DATE}"
            )
            result = stage(
                batch_number=args.batch, private_root=args.private_root.resolve(),
                downloads=args.downloads.resolve(), pdf_root=args.pdf_root.resolve(),
                work_root=work_root.resolve(), pixel_review=args.pixel_review,
                answer_review=args.answer_review,
            )
        else:
            result = finalize(
                work_root=args.work_root.resolve(), downloads=args.downloads.resolve(),
                signoff=args.signoff,
            )
    except (AdvanceError, intersection.DualReviewError, release.StarterReleaseError,
            bundle.BundleError, deployment.DeploymentError, OSError, ValueError,
            json.JSONDecodeError) as error:
        print(f"advance-starter-release: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
