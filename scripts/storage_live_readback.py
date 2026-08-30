"""Authenticated, read-only Supabase Storage downloads for release verification.

The service-role credential is fetched from the Supabase CLI, held only in
memory, and never written to disk or included in the verification manifest.
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote
from urllib.request import Request, urlopen


class LiveReadbackError(RuntimeError):
    pass


def service_role_key(npx: str, project_ref: str) -> str:
    completed = subprocess.run(
        [npx, "supabase", "projects", "api-keys", "--project-ref", project_ref,
         "--output", "json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=90, check=False,
    )
    if completed.returncode != 0:
        raise LiveReadbackError(
            (completed.stderr or "cannot obtain temporary Storage read credential").strip()
        )
    try:
        rows = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise LiveReadbackError("Supabase API-key response is not valid JSON") from error
    matches = [
        row.get("api_key") or row.get("key")
        for row in rows if isinstance(row, dict) and row.get("name") == "service_role"
    ] if isinstance(rows, list) else []
    matches = [value for value in matches if isinstance(value, str) and value]
    if len(matches) != 1:
        raise LiveReadbackError("Supabase service-role read credential is missing or ambiguous")
    return matches[0]


def download_assets(
    expected: dict[str, dict[str, Any]], destination: Path, *,
    project_ref: str, bucket: str, npx: str,
    key_loader: Callable[[str, str], str] = service_role_key,
    opener: Callable[..., Any] = urlopen,
    attempts: int = 4,
    retry_delays: tuple[float, ...] = (1.0, 3.0, 7.0),
) -> Path:
    """Download every expected object into a new local tree.

    Object paths come only from the already hash-bound manifest.  A failed or
    partial response aborts verification; cached files are never consulted.
    """
    destination = destination.resolve()
    if destination.exists() and any(destination.iterdir()):
        raise LiveReadbackError("live readback destination must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    credential = key_loader(npx, project_ref)
    base = f"https://{project_ref}.supabase.co/storage/v1/object/authenticated"
    try:
        for relative in sorted(expected):
            encoded = quote(relative.replace("\\", "/"), safe="/")
            url = f"{base}/{quote(bucket, safe='')}/{encoded}"
            request = Request(url, headers={
                "apikey": credential,
                "Authorization": f"Bearer {credential}",
            })
            body: bytes | None = None
            last_error: Exception | None = None
            for attempt in range(attempts):
                try:
                    with opener(request, timeout=180) as response:
                        body = response.read()
                    break
                except Exception as error:
                    last_error = error
                    if attempt + 1 < attempts:
                        delay_index = min(attempt, len(retry_delays) - 1)
                        time.sleep(retry_delays[delay_index])
            if body is None:
                raise LiveReadbackError(
                    f"live Storage download failed after {attempts} attempts: {relative}"
                ) from last_error
            path = destination / Path(relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_suffix(path.suffix + ".part")
            partial.write_bytes(body)
            partial.replace(path)
    finally:
        credential = ""  # best-effort lifetime minimization; never serialize it
    return destination
