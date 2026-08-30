#!/usr/bin/env python3
"""Fail closed when the public Git tree contains secrets or private study assets."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
POLICY_VERSION = 1
ALLOWED_BINARY_FILES = {"icon-192.png", "icon-512.png"}
PRIVATE_EXTENSIONS = {
    ".pdf", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".zip",
    ".7z", ".rar", ".doc", ".docx",
}
PRIVATE_PATH_PATTERNS = tuple(re.compile(pattern, re.I) for pattern in (
    r"(?:^|/)(?:private-content|matha-content|matha-figures|matha-papers|matha-solutions|matha-audit-private)(?:/|$)",
    r"(?:^|/)(?:signed|unsigned)-private-question-source\.json$",
    r"(?:^|/)answer-binding-candidates\.json$",
    r"(?:^|/)(?:private-release-runtime|private-app-loader)-verification[^/]*\.json$",
    r"(?:^|/)(?:deployment|rollback)(?:-|\.)[^/]*\.json$",
    r"(?:^|/)upload-plan\.json$",
    r"(?:^|/)assets/[^/]+/(?:answer|question|cleaned)\.png$",
    r"(?:^|/)[^/]*(?:credential|service-role|private-key)[^/]*$",
))
SECRET_PATTERNS = (
    ("OpenAI key", re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("GitHub token", re.compile(rb"\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b")),
    ("Supabase secret key", re.compile(rb"\bsb_secret_[A-Za-z0-9_-]{20,}\b")),
    ("private key", re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("assigned secret", re.compile(
        rb"(?i)\b(?:OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|MISTRAL_API_KEY|"
        rb"YESCANNER_CLIENT_(?:ID|SECRET)|SUPABASE_USER_ACCESS_TOKEN|GITHUB_TOKEN)"
        rb"\s*[=:]\s*['\"](?!\s*(?:<|\$\{|example|test|placeholder))[^'\"\r\n]{8,}['\"]"
    )),
)
PRIVATE_JSON_KINDS = {
    "private-question-source",
    "matha-private-storage-upload-plan",
    "matha-private-storage-deployment",
    "matha-private-storage-rollback",
    "matha-private-release-runtime-verification",
    "matha-private-app-loader-verification",
    "cleaned-answer-binding-candidates",
}


class PublicRepoAuditError(RuntimeError):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def tracked_paths(root: Path = REPO_ROOT) -> list[str]:
    completed = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, capture_output=True, check=False,
    )
    if completed.returncode:
        raise PublicRepoAuditError("git ls-files failed")
    try:
        values = [part.decode("utf-8") for part in completed.stdout.split(b"\0") if part]
    except UnicodeDecodeError as error:
        raise PublicRepoAuditError("tracked filename is not valid UTF-8") from error
    if not values or len(values) != len(set(values)):
        raise PublicRepoAuditError("tracked file inventory is empty or duplicated")
    return sorted(values)


def _private_json_reason(data: bytes, relative: str) -> str | None:
    if not relative.lower().endswith(".json") or len(data) > 20 * 1024 * 1024:
        return None
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    kind = value.get("kind")
    if kind in PRIVATE_JSON_KINDS or (isinstance(kind, str) and kind.startswith("matha-private-")):
        return f"private JSON kind {kind}"
    questions = value.get("questions")
    if isinstance(questions, list) and questions and any(
        isinstance(row, dict) and ("stemAsset" in row or "answerVerification" in row)
        for row in questions[:10]
    ):
        return "question source with private stem/answer bindings"
    return None


def audit_paths(root: Path, paths: Iterable[str]) -> dict[str, Any]:
    root = root.resolve()
    rows: list[dict[str, Any]] = []
    violations: list[str] = []
    for relative in sorted(paths):
        normalized = relative.replace("\\", "/")
        if normalized.startswith("/") or ".." in Path(normalized).parts:
            violations.append(f"unsafe tracked path: {normalized}")
            continue
        path = (root / Path(normalized)).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            violations.append(f"tracked path escapes repository: {normalized}")
            continue
        if not path.is_file():
            violations.append(f"tracked file is missing: {normalized}")
            continue
        suffix = path.suffix.lower()
        if suffix in PRIVATE_EXTENSIONS or (
            suffix == ".png" and normalized not in ALLOWED_BINARY_FILES
        ):
            violations.append(f"private/binary asset is not allowlisted: {normalized}")
        if any(pattern.search(normalized) for pattern in PRIVATE_PATH_PATTERNS):
            violations.append(f"private evidence path is tracked: {normalized}")
        data = path.read_bytes()
        for label, pattern in SECRET_PATTERNS:
            if pattern.search(data):
                violations.append(f"{label} detected in tracked file: {normalized}")
        json_reason = _private_json_reason(data, normalized)
        if json_reason:
            violations.append(f"{json_reason}: {normalized}")
        rows.append({"path": normalized, "sha256": sha256(data), "bytes": len(data)})
    if violations:
        raise PublicRepoAuditError("; ".join(sorted(set(violations))))
    canonical = json.dumps(
        rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True,
    ).encode("utf-8")
    return {
        "policyVersion": POLICY_VERSION,
        "trackedFiles": len(rows),
        "treeSha256": sha256(canonical),
        "privateAssetViolations": 0,
        "secretViolations": 0,
    }


def audit_tracked_tree(root: Path = REPO_ROOT) -> dict[str, Any]:
    return audit_paths(root, tracked_paths(root))


def main() -> int:
    try:
        result = audit_tracked_tree()
    except (OSError, PublicRepoAuditError) as error:
        print(f"audit-public-repo: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
