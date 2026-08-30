#!/usr/bin/env python3
"""Ephemeral PostgreSQL harness for the paper protocol integration tests.

The production SQL expects the Supabase-provided ``auth`` and ``storage``
schemas.  This harness supplies only those host-owned primitives, then applies
the real ``supabase/schema.sql`` and every checked-in migration with psql's
``ON_ERROR_STOP`` enabled.  Nothing is written to the repository or a remote
project.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class PostgreSQLUnavailable(RuntimeError):
    """Raised when a local disposable PostgreSQL cluster cannot be started."""


def _find_pg_binary(name: str) -> Path | None:
    suffix = ".exe" if os.name == "nt" else ""
    explicit = os.environ.get("MATHA_PG_BIN", "").strip()
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit) / f"{name}{suffix}")
    located = shutil.which(name)
    if located:
        candidates.append(Path(located))
    if os.name == "nt":
        candidates.extend(
            [
                Path.home() / ".tools" / "pgsql" / "bin" / f"{name}.exe",
                Path("C:/Program Files/PostgreSQL/17/bin") / f"{name}.exe",
                Path("C:/Program Files/PostgreSQL/16/bin") / f"{name}.exe",
                Path("C:/Program Files/PostgreSQL/15/bin") / f"{name}.exe",
            ]
        )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def postgres_prerequisite_error() -> str | None:
    missing = [
        name
        for name in ("initdb", "pg_ctl", "psql")
        if _find_pg_binary(name) is None
    ]
    if missing:
        return "local PostgreSQL binaries unavailable: " + ", ".join(missing)
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        return "Python package psycopg2 is unavailable"
    return None


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class EphemeralPostgres:
    """Own and clean up a throwaway loopback-only PostgreSQL cluster."""

    def __init__(self, repo_root: Path = REPO_ROOT) -> None:
        self.repo_root = repo_root.resolve()
        self.root: Path | None = None
        self.data_dir: Path | None = None
        self.log_path: Path | None = None
        self.port: int | None = None
        self.started = False
        self.initdb = _find_pg_binary("initdb")
        self.pg_ctl = _find_pg_binary("pg_ctl")
        self.psql = _find_pg_binary("psql")

    @property
    def dsn(self) -> str:
        if self.port is None:
            raise RuntimeError("PostgreSQL cluster is not started")
        return (
            f"host=127.0.0.1 port={self.port} dbname=postgres "
            "user=postgres connect_timeout=5"
        )

    def _run(
        self,
        command: list[str],
        *,
        timeout: int = 60,
        capture: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            command,
            cwd=self.repo_root,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
        if completed.returncode != 0:
            rendered = " ".join(command)
            raise PostgreSQLUnavailable(
                f"command failed ({completed.returncode}): {rendered}\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return completed

    def start(self) -> None:
        prerequisite = postgres_prerequisite_error()
        if prerequisite:
            raise PostgreSQLUnavailable(prerequisite)
        assert self.initdb and self.pg_ctl and self.psql
        self.root = Path(tempfile.mkdtemp(prefix="matha-pg-protocol-"))
        self.data_dir = self.root / "data"
        self.log_path = self.root / "postgres.log"
        self.port = _free_loopback_port()
        try:
            self._run(
                [
                    str(self.initdb),
                    "-D",
                    str(self.data_dir),
                    "-U",
                    "postgres",
                    "-A",
                    "trust",
                    "--encoding=UTF8",
                    "--no-locale",
                ],
                timeout=120,
            )
            self._run(
                [
                    str(self.pg_ctl),
                    "-D",
                    str(self.data_dir),
                    "-l",
                    str(self.log_path),
                    "-o",
                    f"-F -p {self.port} -h 127.0.0.1",
                    "-w",
                    "start",
                ],
                timeout=120,
                # On Windows the server spawned by pg_ctl inherits redirected
                # pipe handles.  communicate() would then wait for the server
                # lifetime even though pg_ctl itself has exited.  pg_ctl's -l
                # already captures the useful server log, so use DEVNULL here.
                capture=False,
            )
            self.started = True
            self._bootstrap_supabase_host_schemas()
            self._apply_production_sql()
        except Exception:
            self.stop()
            raise

    def stop(self) -> None:
        if self.started and self.pg_ctl and self.data_dir:
            subprocess.run(
                [str(self.pg_ctl), "-D", str(self.data_dir), "-m", "fast", "-w", "stop"],
                cwd=self.repo_root,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=60,
                check=False,
            )
        self.started = False
        if self.root:
            shutil.rmtree(self.root, ignore_errors=True)

    def connect(self):
        import psycopg2

        return psycopg2.connect(self.dsn)

    def _psql_file(self, path: Path) -> None:
        assert self.psql and self.port is not None
        self._run(
            [
                str(self.psql),
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                "127.0.0.1",
                "-p",
                str(self.port),
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-f",
                str(path),
            ],
            timeout=180,
        )

    def _bootstrap_supabase_host_schemas(self) -> None:
        bootstrap = r"""
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create table if not exists auth.users (
  id uuid primary key,
  created_at timestamptz not null default now()
);
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null default ''
);
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
"""
        connection = self.connect()
        try:
            connection.autocommit = True
            with connection.cursor() as cursor:
                cursor.execute(bootstrap)
        finally:
            connection.close()

    def _apply_production_sql(self) -> None:
        schema = self.repo_root / "supabase" / "schema.sql"
        migrations = sorted((self.repo_root / "supabase" / "migrations").glob("*.sql"))
        if not schema.is_file() or not migrations:
            raise PostgreSQLUnavailable("production schema or migrations are missing")
        self._psql_file(schema)
        for migration in migrations:
            self._psql_file(migration)

    def server_version(self) -> str:
        connection = self.connect()
        try:
            with connection.cursor() as cursor:
                cursor.execute("select version()")
                return str(cursor.fetchone()[0])
        finally:
            connection.close()

    def __enter__(self) -> "EphemeralPostgres":
        self.start()
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.stop()
