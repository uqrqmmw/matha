"""True PostgreSQL race/integration tests for the immutable paper protocol."""

from __future__ import annotations

import json
import hashlib
import sys
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import Json, register_uuid

    register_uuid()
except ImportError:  # The test class reports a clear unittest skip below.
    psycopg2 = None
    Json = None


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from postgres_protocol_harness import (  # noqa: E402
    EphemeralPostgres,
    PostgreSQLUnavailable,
    postgres_prerequisite_error,
)


class PaperProtocolPostgresIntegrationTests(unittest.TestCase):
    cluster: EphemeralPostgres
    _nonce_lock = threading.Lock()
    _nonce = int(time.time() * 1000)

    @classmethod
    def setUpClass(cls) -> None:
        prerequisite = postgres_prerequisite_error()
        if prerequisite:
            raise unittest.SkipTest(prerequisite)
        cls.cluster = EphemeralPostgres(ROOT)
        try:
            cls.cluster.start()
        except PostgreSQLUnavailable as exc:
            raise unittest.SkipTest(str(exc)) from exc
        migrations = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
        print(
            "\n[postgres-protocol] "
            f"server={cls.cluster.server_version().split(',')[0]}; "
            f"schema=supabase/schema.sql; migrations={len(migrations)}; "
            f"loopback_port={cls.cluster.port}",
            flush=True,
        )

    @classmethod
    def tearDownClass(cls) -> None:
        if hasattr(cls, "cluster"):
            cls.cluster.stop()

    @classmethod
    def _next_digits(cls) -> str:
        with cls._nonce_lock:
            cls._nonce += 1
            return str(cls._nonce)

    def setUp(self) -> None:
        self.user_id = uuid.uuid4()
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute("insert into auth.users (id) values (%s)", (self.user_id,))
            cursor.execute(
                "insert into public.app_users (user_id, enabled) values (%s, true)",
                (self.user_id,),
            )

    def tearDown(self) -> None:
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute("delete from auth.users where id = %s", (self.user_id,))

    def _connection(self, *, authenticated: bool = False):
        connection = self.cluster.connect()
        if authenticated:
            with connection.cursor() as cursor:
                cursor.execute(
                    "select set_config('request.jwt.claim.sub', %s, false)",
                    (str(self.user_id),),
                )
            connection.commit()
        return connection

    def _run_race(self, workers):
        barrier = threading.Barrier(len(workers))

        def execute(worker):
            connection = self._connection(authenticated=worker[1])
            try:
                with connection.cursor() as cursor:
                    cursor.execute("select pg_backend_pid()")
                    backend_pid = int(cursor.fetchone()[0])
                    barrier.wait(timeout=10)
                    value = worker[0](cursor)
                connection.commit()
                return {"ok": True, "value": value, "backend_pid": backend_pid}
            except psycopg2.Error as exc:
                connection.rollback()
                return {
                    "ok": False,
                    "sqlstate": exc.pgcode,
                    "message": str(exc).strip(),
                }
            finally:
                connection.close()

        with ThreadPoolExecutor(max_workers=len(workers)) as executor:
            results = list(executor.map(execute, workers))
        successful_pids = {result.get("backend_pid") for result in results if result["ok"]}
        self.assertGreaterEqual(
            len(successful_pids),
            1,
            f"race did not execute any successful PostgreSQL transaction: {results}",
        )
        return results

    def _checkpoint(self, run_id: str, *, mode: str = "paper-source", revision: int = 1,
                    pages: int = 6, run_created_at: int | None = None, question_no: int = 1):
        correction = mode == "paper-correction"
        pages = 1 if correction else pages
        run_created_at = run_created_at or int(time.time() * 1000) - 1000
        self._run_created_at = run_created_at
        manifest = []
        checkpoints = []
        with self._connection() as connection, connection.cursor() as cursor:
          for page in range(pages):
            qid = (f"paper:{run_id}-correction:v1:{page}" if correction
                   else f"paper:{run_id}:v2:{page}")
            client_id = f"client-{uuid.uuid4().hex}"
            proc = {"overlay": True, "mode": mode, "page": page, "revision": revision}
            strokes = {"paper": True, "revision": revision, "s": [{"id": f"stroke-{uuid.uuid4().hex}",
                       "pts": [[0.1, 0.1, 0.1], [0.2, 0.2, 0.2]], "dead": False,
                       "c":"black", "w":1, "t0":1, "t1":2,
                       **({"qno": question_no} if correction else {})}], "deleted": []}
            if correction: strokes["questionTagSchema"] = 1
            cursor.execute(
                """
                insert into public.ink_sessions (
                  user_id, client_id, qid, t0, proc, strokes, updated_at
                ) values (
                  %s, %s, %s, %s, %s, %s,
                  date_trunc('milliseconds', clock_timestamp())
                )
                """,
                (
                    self.user_id,
                    client_id,
                    qid,
                    run_created_at + page,
                    Json(proc),
                    Json(strokes),
                ),
            )
            cursor.execute(
                """
                select
                  encode(extensions.digest(convert_to(
                    public.matha_canonical_jsonb_text(strokes), 'UTF8'
                  ), 'sha256'), 'hex'),
                  to_char(updated_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  to_char(server_updated_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                from public.ink_sessions
                where user_id = %s and client_id = %s
                """,
                (self.user_id, client_id),
            )
            digest, updated_at, server_updated_at = cursor.fetchone()
            item = {
                "page": page,
                "qid": qid,
                "clientId": client_id,
                "revision": revision,
                "cloudSha256": digest,
                "updatedAt": updated_at,
            }
            if correction: item["serverUpdatedAt"] = server_updated_at
            manifest.append(item)
            checkpoints.append({"page":page,"qid":qid,"client_id":client_id,
                                "revision":revision,"proc":proc,"strokes":strokes})
        result = checkpoints[0]
        result.update({"manifest": manifest, "run_created_at": run_created_at})
        return result

    def _replace_correction_checkpoint_strokes(self, checkpoint, strokes):
        checkpoint["strokes"] = strokes
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                update public.ink_sessions
                set strokes = %s, updated_at = date_trunc('milliseconds', clock_timestamp())
                where user_id = %s and client_id = %s and qid = %s
                returning
                  encode(extensions.digest(convert_to(
                    public.matha_canonical_jsonb_text(strokes), 'UTF8'
                  ), 'sha256'), 'hex'),
                  to_char(updated_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  to_char(server_updated_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                """,
                (
                    Json(strokes),
                    self.user_id,
                    checkpoint["client_id"],
                    checkpoint["qid"],
                ),
            )
            digest, updated_at, server_updated_at = cursor.fetchone()
        checkpoint["manifest"] = [{
            "page": checkpoint["page"],
            "qid": checkpoint["qid"],
            "clientId": checkpoint["client_id"],
            "revision": checkpoint["revision"],
            "cloudSha256": digest,
            "updatedAt": updated_at,
            "serverUpdatedAt": server_updated_at,
        }]
        return checkpoint

    def _accept(self, cursor, *, attempt_id, run_id, source_id, manifest):
        cursor.execute(
            """
            select public.matha_paper_submit_accept(
              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb
            )
            """,
            (
                attempt_id,
                run_id,
                source_id,
                4_200_000,
                int(time.time() * 1000),
                "0830b",
                manifest[0].get("runCreatedAt", 0) or self._run_created_at,
                2,
                None if source_id == "paper-mock-1" else self._run_created_at + 1,
                json.dumps(manifest, separators=(",", ":")),
            ),
        )
        return cursor.fetchone()[0]

    def _accepted_run(self, *, source_id: str = "paper-mock-1"):
        run_id = f"paper-run-{self._next_digits()}"
        attempt_id = f"paper-submit-{uuid.uuid4().hex}"
        checkpoint = self._checkpoint(run_id)
        self._run_created_at = checkpoint["run_created_at"]
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            receipt = self._accept(
                cursor,
                attempt_id=attempt_id,
                run_id=run_id,
                source_id=source_id,
                manifest=checkpoint["manifest"],
            )
        self.assertEqual(receipt["status"], "accepted")
        return run_id, attempt_id, checkpoint, receipt

    def _claim(self, cursor, run_id, attempt_id, binding, token, generation=0):
        cursor.execute(
            """
            select public.matha_paper_grade_job_claim(
              %s, %s, %s, %s, %s, %s, 30
            )
            """,
            (self.user_id, run_id, attempt_id, binding, generation, token),
        )
        return cursor.fetchone()[0]

    def test_submit_race_has_exactly_one_accepted_winner(self):
        run_id = f"paper-run-{self._next_digits()}"
        checkpoint = self._checkpoint(run_id)
        attempt_ids = [f"paper-submit-{uuid.uuid4().hex}" for _ in range(2)]

        def submit(attempt_id):
            return lambda cursor: self._accept(
                cursor,
                attempt_id=attempt_id,
                run_id=run_id,
                source_id="paper-mock-1",
                manifest=checkpoint["manifest"],
            )

        results = self._run_race(
            [(submit(attempt_ids[0]), True), (submit(attempt_ids[1]), True)]
        )
        self.assertTrue(all(result["ok"] for result in results), results)
        self.assertEqual(len({result["backend_pid"] for result in results}), 2)
        receipts = [result["value"] for result in results]
        self.assertEqual(sorted(item["status"] for item in receipts), ["accepted", "canceled"])
        winner = next(item for item in receipts if item["status"] == "accepted")
        loser = next(item for item in receipts if item["status"] == "canceled")
        self.assertEqual(loser["winner_attempt_id"], winner["attempt_id"])
        self.assertEqual(loser["winner"]["attempt_id"], winner["attempt_id"])
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select status, count(*) from public.paper_submit_attempts
                where user_id = %s and run_id = %s group by status order by status
                """,
                (self.user_id, run_id),
            )
            self.assertEqual(dict(cursor.fetchall()), {"accepted": 1, "canceled": 1})

    def test_source_registry_exact_pages_and_server_aggregate_are_authority(self):
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute("select source_id,page_count,submit_enabled from public.paper_source_registry")
            registry = {row[0]:(row[1],row[2]) for row in cursor.fetchall()}
        self.assertEqual(registry["paper-mock-1"], (6, True))
        self.assertEqual(registry["paper-mock-2"], (6, False))
        self.assertEqual(registry["paper-mock-3"], (4, True))
        self.assertEqual(sum(enabled for _pages, enabled in registry.values()), 16)
        run_id = f"paper-run-{self._next_digits()}"
        checkpoint = self._checkpoint(run_id)
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            receipt = self._accept(cursor, attempt_id=f"paper-submit-{uuid.uuid4().hex}",
                                   run_id=run_id, source_id="paper-mock-1", manifest=checkpoint["manifest"])
        revisions = [{"page":r["page"],"revision":r["revision"],
                      "persistedRevision":r["revision"],"dirty":False} for r in checkpoint["manifest"]]
        pages = [{"page": r["page"], "qid":r["qid"], "clientId":r["clientId"],
                  "sha256":r["cloudSha256"],"cloudSha256":r["cloudSha256"]}
                 for r in checkpoint["manifest"]]
        canonical = json.dumps({"schema":1,"runId":run_id,"sourceId":"paper-mock-1",
                                "paperLayoutVersion":2,"submittedAt":receipt["submitted_at"],
                                "revisions":revisions,"pages":pages},
                               ensure_ascii=False,sort_keys=True,separators=(",",":"))
        self.assertEqual(receipt["ink_snapshot_sha256"], hashlib.sha256(canonical.encode()).hexdigest())
        self.assertEqual(receipt["run_created_at"], checkpoint["run_created_at"])
        self.assertEqual((receipt["paper_layout_version"],receipt["source_page_count"]),(2,6))
        self.assertIsNone(receipt["freshness_confirmed_at"])
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            cursor.execute("select public.matha_paper_submit_lookup_run(%s)",(run_id,))
            recovered=cursor.fetchone()[0]
        self.assertEqual(recovered["attempt_id"],receipt["attempt_id"])
        self.assertEqual(recovered["ink_snapshot_sha256"],receipt["ink_snapshot_sha256"])
        bad_run = f"paper-run-{self._next_digits()}"
        bad = self._checkpoint(bad_run, pages=5)
        with self.assertRaises(psycopg2.Error) as rejected:
            with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
                self._accept(cursor, attempt_id=f"paper-submit-{uuid.uuid4().hex}", run_id=bad_run,
                             source_id="paper-mock-1", manifest=bad["manifest"])
        self.assertEqual(rejected.exception.pgcode, "22023")

    def test_formal_freshness_is_frozen_in_accepted_attempt(self):
        run_id = f"paper-run-{self._next_digits()}"
        checkpoint = self._checkpoint(run_id, pages=8)
        self._run_created_at = checkpoint["run_created_at"]
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            receipt = self._accept(cursor, attempt_id=f"paper-submit-{uuid.uuid4().hex}",
                                   run_id=run_id, source_id="paper-official-111",
                                   manifest=checkpoint["manifest"])
            cursor.execute("select freshness_confirmed_at from public.paper_submit_attempts where user_id=%s and run_id=%s",
                           (self.user_id, run_id))
            frozen = cursor.fetchone()[0]
        self.assertEqual(receipt["freshness_confirmed_at"], checkpoint["run_created_at"] + 1)
        self.assertEqual(frozen, checkpoint["run_created_at"] + 1)

    def test_ink_update_vs_accept_uses_one_serialization_boundary(self):
        run_id = f"paper-run-{self._next_digits()}"
        attempt_id = f"paper-submit-{uuid.uuid4().hex}"
        checkpoint = self._checkpoint(run_id)
        updated_proc = dict(checkpoint["proc"], revision=2)
        updated_strokes = dict(checkpoint["strokes"], revision=2)

        def accept(cursor):
            return self._accept(
                cursor,
                attempt_id=attempt_id,
                run_id=run_id,
                source_id="paper-mock-1",
                manifest=checkpoint["manifest"],
            )

        def update(cursor):
            cursor.execute(
                """
                update public.ink_sessions
                set proc = %s, strokes = %s,
                    updated_at = date_trunc('milliseconds', clock_timestamp())
                where user_id = %s and client_id = %s
                returning (strokes->>'revision')::integer
                """,
                (
                    Json(updated_proc),
                    Json(updated_strokes),
                    self.user_id,
                    checkpoint["client_id"],
                ),
            )
            return cursor.fetchone()[0]

        results = self._run_race([(accept, True), (update, False)])
        self.assertEqual(sum(1 for result in results if result["ok"]), 1, results)
        loser = next(result for result in results if not result["ok"])
        self.assertIn(loser["sqlstate"], {"40001", "55000"}, results)
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select count(*) from public.paper_submit_attempts
                where user_id = %s and run_id = %s and status = 'accepted'
                """,
                (self.user_id, run_id),
            )
            accepted = cursor.fetchone()[0]
            cursor.execute(
                """
                select (strokes->>'revision')::integer
                from public.ink_sessions where user_id = %s and client_id = %s
                """,
                (self.user_id, checkpoint["client_id"]),
            )
            revision = cursor.fetchone()[0]
        self.assertIn((accepted, revision), {(1, 1), (0, 2)})

    def test_same_generation_dual_claim_has_one_invoker(self):
        run_id, attempt_id, _checkpoint, _receipt = self._accepted_run()
        binding = "b" * 64
        tokens = [f"paper-grade-lease-{uuid.uuid4().hex}" for _ in range(2)]

        def claim(token):
            return lambda cursor: self._claim(cursor, run_id, attempt_id, binding, token)

        results = self._run_race([(claim(tokens[0]), False), (claim(tokens[1]), False)])
        self.assertTrue(all(result["ok"] for result in results), results)
        self.assertEqual(len({result["backend_pid"] for result in results}), 2)
        self.assertEqual(
            sorted(result["value"]["action"] for result in results),
            ["invoke", "pending"],
        )
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select count(*), min(status), count(distinct lease_token)
                from public.paper_grade_jobs
                where user_id = %s and run_id = %s and generation = 0
                """,
                (self.user_id, run_id),
            )
            self.assertEqual(cursor.fetchone(), (1, "leased", 1))

    def test_expired_lease_rebind_rejects_old_token_dispatch(self):
        run_id, attempt_id, _checkpoint, _receipt = self._accepted_run()
        old_binding, new_binding = "c" * 64, "d" * 64
        old_token = f"paper-grade-lease-{uuid.uuid4().hex}"
        new_token = f"paper-grade-lease-{uuid.uuid4().hex}"
        with self._connection() as connection, connection.cursor() as cursor:
            first = self._claim(cursor, run_id, attempt_id, old_binding, old_token)
            self.assertEqual(first["action"], "invoke")
            cursor.execute(
                """
                update public.paper_grade_jobs
                set lease_expires_at = now() - interval '1 second'
                where user_id = %s and run_id = %s and generation = 0
                """,
                (self.user_id, run_id),
            )
        with self._connection() as connection, connection.cursor() as cursor:
            rebound = self._claim(cursor, run_id, attempt_id, new_binding, new_token)
            self.assertEqual(rebound["action"], "invoke")
            self.assertEqual(rebound["model_input_binding_sha256"], new_binding)
        with self.assertRaises(psycopg2.Error) as lost:
            with self._connection() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    select public.matha_paper_grade_job_mark_dispatched(
                      %s, %s, %s, %s, 0, %s
                    )
                    """,
                    (self.user_id, run_id, attempt_id, new_binding, old_token),
                )
        self.assertEqual(lost.exception.pgcode, "55000")
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select public.matha_paper_grade_job_mark_dispatched(
                  %s, %s, %s, %s, 0, %s
                )
                """,
                (self.user_id, run_id, attempt_id, new_binding, new_token),
            )
            dispatched = cursor.fetchone()[0]
        self.assertEqual(dispatched["action"], "dispatched")

    @unittest.skip("legacy completion RPC intentionally removed by migration 007")
    def test_completed_job_is_immutable_and_exactly_readable(self):
        run_id, attempt_id, _checkpoint, _receipt = self._accepted_run()
        binding = "e" * 64
        token = f"paper-grade-lease-{uuid.uuid4().hex}"
        normalized = {"score": 75, "items": [{"q": 1, "ok": True}]}
        metadata = {"model": "gpt-5.5", "generation": 0}
        envelope = {"receipt": "immutable", "version": 1}
        with self._connection() as connection, connection.cursor() as cursor:
            self.assertEqual(
                self._claim(cursor, run_id, attempt_id, binding, token)["action"],
                "invoke",
            )
            cursor.execute(
                """
                select public.matha_paper_grade_job_mark_dispatched(
                  %s, %s, %s, %s, 0, %s
                )
                """,
                (self.user_id, run_id, attempt_id, binding, token),
            )
            self.assertEqual(cursor.fetchone()[0]["action"], "dispatched")
            cursor.execute(
                """
                select public.matha_paper_grade_job_complete(
                  %s, %s, %s, %s, 0, %s, %s, %s, %s
                )
                """,
                (
                    self.user_id,
                    run_id,
                    attempt_id,
                    binding,
                    token,
                    Json(normalized),
                    Json(metadata),
                    Json(envelope),
                ),
            )
            completed = cursor.fetchone()[0]
        self.assertEqual(completed["action"], "completed")
        self.assertEqual(completed["result"]["json"], normalized)
        self.assertTrue(
            all(
                len(value) == 64
                for value in completed["result"]["content_digests"].values()
            )
        )
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "select public.matha_paper_grade_job_status(%s, %s, %s, 0)",
                (self.user_id, run_id, attempt_id),
            )
            readback = cursor.fetchone()[0]
            self.assertEqual(readback["action"], "completed")
            self.assertEqual(readback["result"], completed["result"])
            cursor.execute(
                """
                select public.matha_paper_grade_job_complete(
                  %s, %s, %s, %s, 0, %s, %s, %s, %s
                )
                """,
                (
                    self.user_id,
                    run_id,
                    attempt_id,
                    binding,
                    token,
                    Json(normalized),
                    Json(metadata),
                    Json(envelope),
                ),
            )
            self.assertEqual(cursor.fetchone()[0]["result"], completed["result"])
        with self.assertRaises(psycopg2.Error) as changed:
            with self._connection() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    select public.matha_paper_grade_job_complete(
                      %s, %s, %s, %s, 0, %s, %s, %s, %s
                    )
                    """,
                    (
                        self.user_id,
                        run_id,
                        attempt_id,
                        binding,
                        token,
                        Json({"score": 76}),
                        Json(metadata),
                        Json(envelope),
                    ),
                )
        self.assertEqual(changed.exception.pgcode, "55000")

    def test_legacy_complete_is_removed_and_direct_completed_without_artifact_rejected(self):
        run_id, attempt_id, _checkpoint, _receipt = self._accepted_run()
        binding="e"*64; token=f"paper-grade-lease-{uuid.uuid4().hex}"
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute("select to_regprocedure('public.matha_paper_grade_job_complete(uuid,text,text,text,bigint,text,jsonb,jsonb,jsonb)')")
            self.assertIsNone(cursor.fetchone()[0])
            self._claim(cursor,run_id,attempt_id,binding,token)
            cursor.execute("select public.matha_paper_grade_job_mark_dispatched(%s,%s,%s,%s,0,%s)",
                           (self.user_id,run_id,attempt_id,binding,token))
        with self.assertRaises(psycopg2.Error) as rejected:
            with self._connection() as connection, connection.cursor() as cursor:
                cursor.execute("""update public.paper_grade_jobs set status='completed',completed_at=now(),
                  model_metadata='{}',receipt_envelope='{}'
                  where user_id=%s and run_id=%s and generation=0""",(self.user_id,run_id))
        self.assertIn(rejected.exception.pgcode,{"23514","55000"})
        with self.assertRaises(psycopg2.Error) as direct_update:
            with self._connection() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    update public.paper_grade_jobs set updated_at = clock_timestamp()
                    where user_id = %s and run_id = %s and generation = 0
                    """,
                    (self.user_id, run_id),
                )
        self.assertEqual(direct_update.exception.pgcode, "55000")

    def _dispatched_job(self):
        run_id, attempt_id, _checkpoint, _receipt = self._accepted_run()
        binding = hashlib.sha256(f"binding:{run_id}".encode()).hexdigest()
        token = f"paper-grade-lease-{uuid.uuid4().hex}"
        with self._connection() as connection, connection.cursor() as cursor:
            self.assertEqual(
                self._claim(cursor, run_id, attempt_id, binding, token)["action"],
                "invoke",
            )
            cursor.execute(
                """
                select public.matha_paper_grade_job_mark_dispatched(
                  %s, %s, %s, %s, 0, %s
                )
                """,
                (self.user_id, run_id, attempt_id, binding, token),
            )
            self.assertEqual(cursor.fetchone()[0]["action"], "dispatched")
        return run_id, attempt_id, binding, token

    def _completion_artifact(self, run_id, attempt_id, binding):
        user_binding = "matha_" + hashlib.sha256(str(self.user_id).encode()).hexdigest()[:32]
        path = (
            f"grade-completions/{user_binding}/{run_id}/{attempt_id}/"
            f"generation-0/input-{binding}.json"
        )
        normalized = {"score": 88, "items": [{"q": 1, "ok": True}]}
        request_id = f"resp_{uuid.uuid4().hex}"
        receipt_digest = hashlib.sha256(f"receipt:{run_id}".encode()).hexdigest()
        metadata = {
            "model": "gpt-5.5",
            "requestId": request_id,
            "generation": 0,
        }
        envelope = {
            "privateReadback": {
                "authority": "supabase-service-role-storage-readback",
                "bucket": "matha-audit-private",
                "path": (
                    f"grade-receipts/{user_binding}/{run_id}/"
                    f"grade-{receipt_digest}.json"
                ),
                "sha256": hashlib.sha256(f"readback:{run_id}".encode()).hexdigest(),
                "canonicalDigest": receipt_digest,
                "requestId": request_id,
                "model": "gpt-5.5",
                "submitAttemptId": attempt_id,
                "gradeGeneration": 0,
                "modelInputBindingSha256": binding,
            },
            "receipt": {
                "canonicalDigest": receipt_digest,
                "requestId": request_id,
                "model": "gpt-5.5",
                "submitAttempt": {"attemptId": attempt_id},
                "gradeGeneration": 0,
                "modelInputBinding": {"canonicalDigest": binding},
            },
        }
        artifact = {
            "kind": "matha-paper-grade-completion-artifact-v1",
            "schemaVersion": 1,
            "identity": {
                "userBinding": user_binding,
                "runId": run_id,
                "acceptedAttemptId": attempt_id,
                "generation": 0,
                "modelInputBindingSha256": binding,
            },
            "storage": {"bucket": "matha-audit-private", "path": path},
            "payload": {
                "normalizedModelJson": normalized,
                "modelMetadata": metadata,
                "receiptEnvelope": envelope,
            },
            "contentDigests": {
                "normalizedModelJsonSha256": hashlib.sha256(
                    json.dumps(normalized, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest(),
                "modelMetadataSha256": hashlib.sha256(
                    json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest(),
                "receiptEnvelopeSha256": hashlib.sha256(
                    json.dumps(envelope, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest(),
            },
        }
        core_bytes = json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode()
        artifact["canonicalDigest"] = hashlib.sha256(core_bytes).hexdigest()
        stored_bytes = json.dumps(artifact, sort_keys=True, separators=(",", ":")).encode()
        return artifact, path, hashlib.sha256(stored_bytes).hexdigest(), len(stored_bytes)

    def _recover_artifact(self, cursor, run_id, attempt_id, binding, artifact, path, sha, size):
        cursor.execute(
            """
            select public.matha_paper_grade_job_recover_from_artifact(
              %s, %s, %s, %s, 0, %s, %s, %s, %s
            )
            """,
            (
                self.user_id,
                run_id,
                attempt_id,
                binding,
                Json(artifact),
                path,
                sha,
                size,
            ),
        )
        return cursor.fetchone()[0]

    def test_dispatched_job_recovers_once_from_bound_completion_artifact(self):
        run_id, attempt_id, binding, _token = self._dispatched_job()
        artifact, path, sha, size = self._completion_artifact(run_id, attempt_id, binding)
        tampered = json.loads(json.dumps(artifact))
        tampered["identity"]["runId"] = f"{run_id}9"
        with self.assertRaises(psycopg2.Error) as rejected:
            with self._connection() as connection, connection.cursor() as cursor:
                self._recover_artifact(
                    cursor, run_id, attempt_id, binding, tampered, path, sha, size
                )
        self.assertEqual(rejected.exception.pgcode, "55000")
        with self._connection() as connection, connection.cursor() as cursor:
            recovered = self._recover_artifact(
                cursor, run_id, attempt_id, binding, artifact, path, sha, size
            )
        self.assertEqual(recovered["action"], "completed")
        self.assertEqual(recovered["completion_artifact"]["path"], path)
        self.assertEqual(recovered["completion_artifact"]["sha256"], sha)
        with self._connection() as connection, connection.cursor() as cursor:
            replay = self._recover_artifact(
                cursor, run_id, attempt_id, binding, artifact, path, sha, size
            )
        self.assertEqual(replay["result"], recovered["result"])
        with self.assertRaises(psycopg2.Error) as changed_artifact:
            with self._connection() as connection, connection.cursor() as cursor:
                self._recover_artifact(
                    cursor,
                    run_id,
                    attempt_id,
                    binding,
                    artifact,
                    path,
                    "0" * 64,
                    size,
                )
        self.assertEqual(changed_artifact.exception.pgcode, "55000")
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select status, recovered_from_artifact, completion_artifact_path
                from public.paper_grade_jobs
                where user_id = %s and run_id = %s and generation = 0
                """,
                (self.user_id, run_id),
            )
            self.assertEqual(cursor.fetchone(), ("completed", True, path))

    def test_dispatched_job_becomes_terminal_lost_after_fifteen_minutes(self):
        run_id, attempt_id, _checkpoint, _receipt = self._accepted_run()
        binding = hashlib.sha256(f"lost:{run_id}".encode()).hexdigest()
        token = f"paper-grade-lease-{uuid.uuid4().hex}"
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                insert into public.paper_grade_jobs (
                  user_id, run_id, accepted_attempt_id,
                  model_input_binding_sha256, generation, status,
                  lease_token, lease_expires_at, dispatched_at
                ) values (
                  %s, %s, %s, %s, 0, 'dispatched',
                  %s, null, now() - interval '16 minutes'
                )
                """,
                (self.user_id, run_id, attempt_id, binding, token),
            )
            cursor.execute(
                "select public.matha_paper_grade_job_status(%s, %s, %s, 0)",
                (self.user_id, run_id, attempt_id),
            )
            status = cursor.fetchone()[0]
        self.assertEqual(status["action"], "lost")
        self.assertEqual(status["status"], "dispatched")
        self.assertTrue(status["terminal"])
        self.assertTrue(status["requires_explicit_generation"])

    def test_latest_status_selects_max_generation_without_writing(self):
        run_id, attempt_id, _checkpoint, _receipt = self._accepted_run()
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "select public.matha_paper_grade_latest_status(%s, %s, %s)",
                (self.user_id, run_id, attempt_id),
            )
            missing = cursor.fetchone()[0]
            cursor.execute(
                """
                select count(*) from public.paper_grade_jobs
                where user_id = %s and run_id = %s
                """,
                (self.user_id, run_id),
            )
            self.assertEqual(cursor.fetchone()[0], 0)
        self.assertEqual(missing, {"action": "missing", "status": "missing", "generation": None})

        with self._connection() as connection, connection.cursor() as cursor:
            self._claim(
                cursor,
                run_id,
                attempt_id,
                "6" * 64,
                f"paper-grade-lease-{uuid.uuid4().hex}",
            )
            for previous, digit in ((0, "7"), (1, "8")):
                cursor.execute(
                    """
                    select public.matha_paper_grade_issue_generation(
                      %s, %s, %s, %s, %s, %s
                    )
                    """,
                    (
                        self.user_id,
                        run_id,
                        attempt_id,
                        digit * 64,
                        previous,
                        f"paper-grade-generation-{uuid.uuid4().hex}",
                    ),
                )
                issued = cursor.fetchone()[0]
                self.assertEqual(issued["generation"], previous + 1)
            cursor.execute(
                """
                select public.matha_paper_grade_latest_status(%s, %s, %s)
                """,
                (self.user_id, run_id, attempt_id),
            )
            latest = cursor.fetchone()[0]
        self.assertEqual(latest["generation"], 2)
        self.assertEqual(latest["action"], "pending")

        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                insert into public.paper_grade_jobs (
                  user_id, run_id, accepted_attempt_id,
                  model_input_binding_sha256, generation, issuance_request_id,
                  status, lease_token, lease_expires_at, dispatched_at
                ) values (
                  %s, %s, %s, %s, 3, %s,
                  'dispatched', %s, null, now() - interval '16 minutes'
                )
                """,
                (
                    self.user_id,
                    run_id,
                    attempt_id,
                    "9" * 64,
                    f"paper-grade-generation-{uuid.uuid4().hex}",
                    f"paper-grade-lease-{uuid.uuid4().hex}",
                ),
            )
            cursor.execute(
                """
                select jsonb_agg(to_jsonb(job) order by generation)
                from public.paper_grade_jobs job
                where user_id = %s and run_id = %s
                """,
                (self.user_id, run_id),
            )
            before = cursor.fetchone()[0]
            cursor.execute(
                "select public.matha_paper_grade_latest_status(%s, %s, %s)",
                (self.user_id, run_id, attempt_id),
            )
            lost = cursor.fetchone()[0]
            cursor.execute(
                """
                select jsonb_agg(to_jsonb(job) order by generation)
                from public.paper_grade_jobs job
                where user_id = %s and run_id = %s
                """,
                (self.user_id, run_id),
            )
            after = cursor.fetchone()[0]
        self.assertEqual(lost["generation"], 3)
        self.assertEqual(lost["action"], "lost")
        self.assertTrue(lost["terminal"])
        self.assertEqual(after, before, "latest-status RPC must be read-only")

    def _past_accepted_with_correction(self, *, question_no: int = 1):
        run_id = f"paper-run-{self._next_digits()}"
        attempt_id = f"paper-submit-{uuid.uuid4().hex}"
        original = self._checkpoint(run_id)
        correction = self._checkpoint(run_id, mode="paper-correction", revision=1,
                                      question_no=question_no)
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute("select set_config('matha.submit_run_created_at', %s, true)",
                           (str(original["run_created_at"]),))
            cursor.execute("select set_config('matha.submit_layout_version', '2', true)")
            cursor.execute("select set_config('matha.submit_page_count', '6', true)")
            cursor.execute(
                """
                insert into public.paper_submit_attempts (
                  user_id, attempt_id, run_id, source_id, status, remaining_ms,
                  ink_snapshot_sha256, page_manifest, submitted_at, accepted_at,
                  run_created_app_version, decision_reason
                ) values (
                  %s, %s, %s, 'paper-mock-1', 'accepted', 1000,
                  %s, %s, %s, now() - interval '2 days',
                  '0830b', 'accepted-first-for-run'
                )
                """,
                (
                    self.user_id,
                    attempt_id,
                    run_id,
                    "f" * 64,
                    Json(original["manifest"]),
                    int(time.time() * 1000),
                ),
            )
        return run_id, attempt_id, original, correction

    def _correction_receipt(self, cursor, receipt_id, run_id, attempt_id, question_no, manifest):
        cursor.execute(
            """
            select public.matha_paper_correction_retry_accept(
              %s, %s, 'paper-mock-1', %s, %s, %s::jsonb
            )
            """,
            (
                receipt_id,
                run_id,
                question_no,
                attempt_id,
                json.dumps(manifest, separators=(",", ":")),
            ),
        )
        return cursor.fetchone()[0]

    def _correction_grade_fixture(self):
        run_id, attempt_id, _original, correction = self._past_accepted_with_correction()
        receipt_id = f"paper-correction-retry-{uuid.uuid4().hex}"
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            receipt = self._correction_receipt(
                cursor, receipt_id, run_id, attempt_id, 1, correction["manifest"]
            )
        return {
            "run_id": run_id,
            "source_id": "paper-mock-1",
            "question_no": 1,
            "attempt_id": attempt_id,
            "receipt_id": receipt_id,
            "receipt_digest": receipt["canonicalDigest"],
            "binding": hashlib.sha256(f"binding:{run_id}".encode()).hexdigest(),
        }

    @staticmethod
    def _canonical_digest(value):
        encoded = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _detail_fixture(self):
        identity = self._correction_grade_fixture()
        binding = {
            "promptContractVersion": "paper-detail-server-v1",
            "promptSha256": "a" * 64,
            "acceptedInitialInk": {"fullInkSha256": "b" * 64},
            "correction": {"fullInkSha256": "c" * 64},
        }
        background = {"userNote": "", "attemptLogs": []}
        return {
            **identity,
            "binding_json": binding,
            "binding": self._canonical_digest(binding),
            "background": background,
            "background_digest": self._canonical_digest(background),
        }

    def _detail_claim(self, cursor, identity, *, generation=0, binding_json=None,
                      binding=None, background=None, background_digest=None):
        cursor.execute(
            """
            select public.matha_paper_detail_job_claim(
              %s, %s, %s, %s, %s, %s, %s, %s,
              %s::jsonb, %s, %s::jsonb, %s, 120
            )
            """,
            (
                self.user_id, identity["run_id"], identity["source_id"],
                identity["question_no"], identity["attempt_id"],
                identity["receipt_id"], identity["receipt_digest"], generation,
                json.dumps(binding_json or identity["binding_json"], separators=(",", ":")),
                binding or identity["binding"],
                json.dumps(background or identity["background"], separators=(",", ":")),
                background_digest or identity["background_digest"],
            ),
        )
        return cursor.fetchone()[0]

    def _detail_dispatch(self, cursor, claim):
        cursor.execute(
            "select public.matha_paper_detail_job_mark_dispatched(%s, %s, %s)",
            (self.user_id, claim["job_id"], claim["lease_token"]),
        )
        return cursor.fetchone()[0]

    def _detail_complete(self, cursor, claim, result, metadata):
        cursor.execute(
            """
            select public.matha_paper_detail_job_complete(
              %s, %s, %s, %s::jsonb, %s::jsonb
            )
            """,
            (
                self.user_id, claim["job_id"], claim["lease_token"],
                json.dumps(result, separators=(",", ":")),
                json.dumps(metadata, separators=(",", ":")),
            ),
        )
        return cursor.fetchone()[0]

    def _detail_issue(self, cursor, identity, previous, request_id):
        cursor.execute(
            """
            select public.matha_paper_detail_issue_generation(
              %s, %s, %s, %s, %s, %s, %s,
              %s::jsonb, %s, %s::jsonb, %s, %s, %s
            )
            """,
            (
                self.user_id, identity["run_id"], identity["source_id"],
                identity["question_no"], identity["attempt_id"],
                identity["receipt_id"], identity["receipt_digest"],
                json.dumps(identity["binding_json"], separators=(",", ":")),
                identity["binding"],
                json.dumps(identity["background"], separators=(",", ":")),
                identity["background_digest"], previous, request_id,
            ),
        )
        return cursor.fetchone()[0]

    def _correction_grade_claim(self, cursor, identity, *, binding=None, user_id=None,
                                question_no=None, receipt_id=None, receipt_digest=None,
                                source_id=None):
        cursor.execute(
            """
            select public.matha_paper_correction_grade_job_claim(
              %s, %s, %s, %s, %s, %s, %s, 120
            )
            """,
            (
                user_id or self.user_id,
                identity["run_id"],
                source_id or identity["source_id"],
                question_no or identity["question_no"],
                receipt_id or identity["receipt_id"],
                receipt_digest or identity["receipt_digest"],
                binding or identity["binding"],
            ),
        )
        return cursor.fetchone()[0]

    def _correction_grade_dispatch(self, cursor, identity, claim):
        cursor.execute(
            """
            select public.matha_paper_correction_grade_job_mark_dispatched(
              %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (
                self.user_id,
                identity["run_id"],
                identity["source_id"],
                identity["question_no"],
                identity["receipt_id"],
                identity["receipt_digest"],
                identity["binding"],
                claim["job_id"],
                claim["lease_token"],
            ),
        )
        return cursor.fetchone()[0]

    def _correction_grade_complete(self, cursor, identity, claim, result, metadata):
        cursor.execute(
            """
            select public.matha_paper_correction_grade_job_complete(
              %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (
                self.user_id,
                identity["run_id"],
                identity["source_id"],
                identity["question_no"],
                identity["receipt_id"],
                identity["receipt_digest"],
                identity["binding"],
                claim["job_id"],
                claim["lease_token"],
                Json(result),
                Json(metadata),
            ),
        )
        return cursor.fetchone()[0]

    def test_same_correction_checkpoint_cannot_unlock_two_questions(self):
        run_id, attempt_id, _original, correction = self._past_accepted_with_correction()
        first_id = f"paper-correction-retry-{uuid.uuid4().hex}"
        second_id = f"paper-correction-retry-{uuid.uuid4().hex}"
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            first = self._correction_receipt(
                cursor, first_id, run_id, attempt_id, 1, correction["manifest"]
            )
        self.assertEqual(first["questionNo"], 1)
        self.assertEqual(first["correctionPageManifest"], correction["manifest"])
        self.assertEqual(len(first["correctionNewStrokes"]), 1)
        self.assertEqual(first["correctionNewStrokes"][0]["qno"], 1)
        self.assertEqual(first["correctionNewStrokes"][0]["id"], correction["strokes"]["s"][0]["id"])
        self.assertRegex(first["correctionNewStrokes"][0]["geometryDigest"], r"^[0-9a-f]{64}$")
        with self.assertRaises(psycopg2.Error) as reused:
            with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
                self._correction_receipt(
                    cursor, second_id, run_id, attempt_id, 2, correction["manifest"]
                )
        self.assertEqual(reused.exception.pgcode, "42501")
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select count(*), min(question_no), count(distinct canonical_digest)
                from public.paper_correction_retry_receipts
                where user_id = %s and run_id = %s
                """,
                (self.user_id, run_id),
            )
            self.assertEqual(cursor.fetchone(), (1, 1, 1))

    def test_correction_stroke_for_another_question_is_rejected(self):
        run_id, attempt_id, _original, correction = self._past_accepted_with_correction(question_no=2)
        with self.assertRaises(psycopg2.Error) as rejected:
            with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
                self._correction_receipt(cursor, f"paper-correction-retry-{uuid.uuid4().hex}",
                                         run_id, attempt_id, 1, correction["manifest"])
        self.assertEqual(rejected.exception.pgcode, "42501")

    def test_correction_receipt_freezes_full_geometry_and_rejects_prior_geometry_reuse(self):
        run_id, attempt_id, _original, correction = self._past_accepted_with_correction()
        receipt_id = f"paper-correction-retry-{uuid.uuid4().hex}"
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            receipt = self._correction_receipt(
                cursor, receipt_id, run_id, attempt_id, 1, correction["manifest"]
            )
        self.assertEqual(receipt["correctionLiveStrokes"], receipt["correctionNewStrokes"])
        frozen = receipt["correctionNewStrokes"][0]
        original = correction["strokes"]["s"][0]
        self.assertEqual(
            set(frozen),
            {"id", "qno", "pts", "c", "w", "t0", "t1", "geometryDigest"},
        )
        self.assertEqual(
            {key: frozen[key] for key in ("id", "qno", "pts", "c", "w", "t0", "t1")},
            {key: original[key] for key in ("id", "qno", "pts", "c", "w", "t0", "t1")},
        )

        # ink_sessions remains a mutable checkpoint cache.  Changing it after
        # issuance must neither rewrite nor influence the immutable snapshot.
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                update public.ink_sessions
                set strokes = jsonb_set(strokes, '{s,0,pts,1,0}', '0.9'::jsonb)
                where user_id = %s and client_id = %s and qid = %s
                """,
                (
                    self.user_id,
                    correction["manifest"][0]["clientId"],
                    correction["manifest"][0]["qid"],
                ),
            )
            cursor.execute(
                """
                select receipt->'correctionNewStrokes'->0
                from public.paper_correction_retry_receipts
                where user_id = %s and receipt_id = %s
                """,
                (self.user_id, receipt_id),
            )
            self.assertEqual(cursor.fetchone()[0], frozen)

        with self.assertRaises(psycopg2.Error) as immutable:
            with self._connection() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    update public.paper_correction_retry_receipts
                    set receipt = jsonb_set(
                      receipt, '{correctionNewStrokes,0,pts,1,0}', '0.9'::jsonb
                    )
                    where user_id = %s and receipt_id = %s
                    """,
                    (self.user_id, receipt_id),
                )
        self.assertEqual(immutable.exception.pgcode, "55000")

        # A new ID around the same geometry is not a new correction effort.
        replay = self._checkpoint(
            run_id, mode="paper-correction", revision=2, question_no=1
        )
        with self.assertRaises(psycopg2.Error) as reused_geometry:
            with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
                self._correction_receipt(
                    cursor,
                    f"paper-correction-retry-{uuid.uuid4().hex}",
                    run_id,
                    attempt_id,
                    1,
                    replay["manifest"],
                )
        self.assertEqual(reused_geometry.exception.pgcode, "42501")

    def test_second_correction_receipt_rebuilds_all_live_geometry_and_marks_only_delta_new(self):
        run_id, attempt_id, _original, first_checkpoint = self._past_accepted_with_correction()
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            first = self._correction_receipt(
                cursor,
                f"paper-correction-retry-{uuid.uuid4().hex}",
                run_id,
                attempt_id,
                1,
                first_checkpoint["manifest"],
            )
        old_stroke = first_checkpoint["strokes"]["s"][0]

        continued = self._checkpoint(
            run_id, mode="paper-correction", revision=2, question_no=1
        )
        new_stroke = continued["strokes"]["s"][0]
        new_stroke["pts"] = [[0.3, 0.3, 0.4], [0.45, 0.5, 0.6]]
        continued_strokes = {
            **continued["strokes"],
            "s": [old_stroke, new_stroke],
        }
        continued = self._replace_correction_checkpoint_strokes(
            continued, continued_strokes
        )
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            second = self._correction_receipt(
                cursor,
                f"paper-correction-retry-{uuid.uuid4().hex}",
                run_id,
                attempt_id,
                1,
                continued["manifest"],
            )

        self.assertEqual(
            second["correctionLiveStrokeIds"],
            sorted([old_stroke["id"], new_stroke["id"]]),
        )
        self.assertEqual(second["correctionNewStrokeIds"], [new_stroke["id"]])
        self.assertEqual(
            [stroke["id"] for stroke in second["correctionLiveStrokes"]],
            sorted([old_stroke["id"], new_stroke["id"]]),
        )
        self.assertEqual(
            [stroke["id"] for stroke in second["correctionNewStrokes"]],
            [new_stroke["id"]],
        )
        self.assertEqual(len(first["correctionLiveStrokes"]), 1)

    def test_later_correction_cannot_mutate_or_delete_previously_receipted_geometry(self):
        run_id, attempt_id, _original, first_checkpoint = self._past_accepted_with_correction()
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            self._correction_receipt(
                cursor,
                f"paper-correction-retry-{uuid.uuid4().hex}",
                run_id,
                attempt_id,
                1,
                first_checkpoint["manifest"],
            )
        old_stroke = first_checkpoint["strokes"]["s"][0]

        for mode in ("mutated", "deleted"):
            checkpoint = self._checkpoint(
                run_id, mode="paper-correction", revision=3, question_no=1
            )
            new_stroke = checkpoint["strokes"]["s"][0]
            new_stroke["pts"] = [[0.55, 0.55, 0.4], [0.7, 0.7, 0.6]]
            live = [new_stroke]
            if mode == "mutated":
                changed_old = json.loads(json.dumps(old_stroke))
                changed_old["pts"][1][0] = 0.9
                live.insert(0, changed_old)
            checkpoint = self._replace_correction_checkpoint_strokes(
                checkpoint,
                {**checkpoint["strokes"], "s": live},
            )
            with self.assertRaises(psycopg2.Error) as rejected:
                with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
                    self._correction_receipt(
                        cursor,
                        f"paper-correction-retry-{uuid.uuid4().hex}",
                        run_id,
                        attempt_id,
                        1,
                        checkpoint["manifest"],
                    )
            self.assertEqual(rejected.exception.pgcode, "42501", mode)
            self.assertIn("historical geometry changed or was deleted", str(rejected.exception))

    def test_same_correction_grade_identity_has_exactly_one_concurrent_invoker(self):
        identity = self._correction_grade_fixture()

        def claim(cursor):
            return self._correction_grade_claim(cursor, identity)

        results = self._run_race([(claim, False), (claim, False)])
        self.assertTrue(all(result["ok"] for result in results), results)
        payloads = [result["value"] for result in results]
        self.assertEqual(sorted(payload["action"] for payload in payloads), ["invoke", "pending"])
        self.assertEqual(len({payload["job_id"] for payload in payloads}), 1)
        invoke = next(payload for payload in payloads if payload["action"] == "invoke")
        pending = next(payload for payload in payloads if payload["action"] == "pending")
        self.assertRegex(invoke["lease_token"], r"^paper-correction-grade-lease-")
        self.assertNotIn("lease_token", pending)
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select count(*) from public.paper_correction_grade_jobs
                where user_id = %s and run_id = %s and retry_receipt_id = %s
                """,
                (self.user_id, identity["run_id"], identity["receipt_id"]),
            )
            self.assertEqual(cursor.fetchone()[0], 1)

    def test_correction_grade_claim_rejects_binding_identity_or_receipt_drift(self):
        identity = self._correction_grade_fixture()
        with self._connection() as connection, connection.cursor() as cursor:
            first = self._correction_grade_claim(cursor, identity)
        self.assertEqual(first["action"], "invoke")
        with self._connection() as connection, connection.cursor() as cursor:
            replay = self._correction_grade_claim(cursor, identity)
        self.assertEqual(replay["action"], "pending")
        self.assertEqual(replay["job_id"], first["job_id"])

        bad_cases = (
            {"binding": "f" * 64, "sqlstate": "22023"},
            {"user_id": uuid.uuid4(), "sqlstate": "42501"},
            {"question_no": 2, "sqlstate": "42501"},
            {"receipt_id": f"paper-correction-retry-{uuid.uuid4().hex}", "sqlstate": "42501"},
            {"receipt_digest": "e" * 64, "sqlstate": "42501"},
            {"source_id": "paper-mock-3", "sqlstate": "42501"},
        )
        for case in bad_cases:
            expected = case.pop("sqlstate")
            with self.assertRaises(psycopg2.Error) as rejected:
                with self._connection() as connection, connection.cursor() as cursor:
                    self._correction_grade_claim(cursor, identity, **case)
            self.assertEqual(rejected.exception.pgcode, expected, case)

    def test_dispatched_correction_grade_never_reinvokes_and_completed_replay_is_exact(self):
        identity = self._correction_grade_fixture()
        result = {"correct": True, "read": "x=2", "firstError": None, "marks": []}
        metadata = {"provider": "openai", "model": "gpt-5.5", "responseId": "resp-test-1"}
        with self._connection() as connection, connection.cursor() as cursor:
            claim = self._correction_grade_claim(cursor, identity)
            dispatched = self._correction_grade_dispatch(cursor, identity, claim)
        self.assertEqual(dispatched["action"], "dispatched")
        self.assertEqual(dispatched["status"], "dispatched")

        with self._connection() as connection, connection.cursor() as cursor:
            retry = self._correction_grade_claim(cursor, identity)
            cursor.execute(
                """
                select public.matha_paper_correction_grade_job_status(
                  %s, %s, %s, %s, %s, %s, %s
                )
                """,
                (
                    self.user_id, identity["run_id"], identity["source_id"],
                    identity["question_no"], identity["receipt_id"],
                    identity["receipt_digest"], identity["binding"],
                ),
            )
            status = cursor.fetchone()[0]
        self.assertEqual(retry["action"], "pending")
        self.assertNotIn("lease_token", retry)
        self.assertEqual(status["action"], "pending")

        with self._connection() as connection, connection.cursor() as cursor:
            completed = self._correction_grade_complete(
                cursor, identity, claim, result, metadata
            )
        self.assertEqual(completed["action"], "completed")
        self.assertEqual(completed["result"]["json"], result)
        receipt = completed["result"]["receipt"]
        self.assertEqual(receipt["authority"], "supabase-immutable-paper-correction-grade-result-v1")
        self.assertEqual(receipt["retryReceiptId"], identity["receipt_id"])
        self.assertEqual(receipt["retryReceiptDigest"], identity["receipt_digest"])
        self.assertEqual(receipt["modelInputBindingSha256"], identity["binding"])
        self.assertRegex(receipt["canonicalDigest"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            completed["result"]["content_digests"]["result_receipt_sha256"],
            receipt["canonicalDigest"],
        )

        with self._connection() as connection, connection.cursor() as cursor:
            replay = self._correction_grade_complete(
                cursor, identity, claim, result, metadata
            )
            after = self._correction_grade_claim(cursor, identity)
        self.assertEqual(replay, completed)
        self.assertEqual(after, completed)

        with self.assertRaises(psycopg2.Error) as tampered:
            with self._connection() as connection, connection.cursor() as cursor:
                self._correction_grade_complete(
                    cursor, identity, claim, {**result, "correct": False}, metadata
                )
        self.assertEqual(tampered.exception.pgcode, "55000")

    def test_same_detail_identity_has_one_invoker_and_coexists_with_correction_grade(self):
        identity = self._detail_fixture()
        with self._connection() as connection, connection.cursor() as cursor:
            correction = self._correction_grade_claim(cursor, identity)
        self.assertEqual(correction["action"], "invoke")

        def claim(cursor):
            return self._detail_claim(cursor, identity)

        results = self._run_race([(claim, False), (claim, False)])
        self.assertTrue(all(result["ok"] for result in results), results)
        payloads = [result["value"] for result in results]
        self.assertEqual(sorted(row["action"] for row in payloads), ["invoke", "pending"])
        self.assertEqual(len({row["job_id"] for row in payloads}), 1)
        invoke = next(row for row in payloads if row["action"] == "invoke")
        pending = next(row for row in payloads if row["action"] == "pending")
        self.assertRegex(invoke["lease_token"], r"^paper-detail-lease-")
        self.assertNotIn("lease_token", pending)
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                select
                  (select count(*) from public.paper_detail_jobs
                   where user_id = %s and retry_receipt_id = %s),
                  (select count(*) from public.paper_correction_grade_jobs
                   where user_id = %s and retry_receipt_id = %s)
                """,
                (self.user_id, identity["receipt_id"],
                 self.user_id, identity["receipt_id"]),
            )
            self.assertEqual(cursor.fetchone(), (1, 1))

    def test_detail_dispatched_replays_one_immutable_result_and_rejects_tamper(self):
        identity = self._detail_fixture()
        result = {
            "readable": True, "confidence": "high", "read": "x=2",
            "goodWork": ["代入正確"], "firstErrorEvidence": "x=2",
            "firstError": "下一行漏項", "errorKind": "漏項",
            "whyWrong": "代回不成立", "repair": "補回常數項",
            "explanation": "先整理", "solution": ["整理", "代入"],
            "nextTime": "檢查常數", "marks": [],
        }
        metadata = {
            "model": "gpt-5.5", "requestId": "resp-detail-1",
            "usage": {"input_tokens": 10}, "budget": {"allowed": True},
        }
        with self._connection() as connection, connection.cursor() as cursor:
            claim = self._detail_claim(cursor, identity)
            dispatched = self._detail_dispatch(cursor, claim)
        self.assertEqual(dispatched["action"], "dispatched")
        with self._connection() as connection, connection.cursor() as cursor:
            retry = self._detail_claim(cursor, identity)
            cursor.execute(
                """
                select public.matha_paper_detail_job_status(
                  %s, %s, %s, %s, %s, %s, %s, 0
                )
                """,
                (
                    self.user_id, identity["run_id"], identity["source_id"],
                    identity["question_no"], identity["attempt_id"],
                    identity["receipt_id"], identity["receipt_digest"],
                ),
            )
            pending = cursor.fetchone()[0]
        self.assertEqual(retry["action"], "pending")
        self.assertEqual(pending["action"], "pending")

        with self._connection() as connection, connection.cursor() as cursor:
            completed = self._detail_complete(cursor, claim, result, metadata)
        receipt = completed["result"]["receipt"]
        self.assertEqual(completed["action"], "completed")
        self.assertEqual(receipt["authority"], "supabase-immutable-paper-detail-result-v1")
        self.assertEqual(receipt["jobKind"], "paper_detail")
        self.assertEqual(receipt["generation"], 0)
        self.assertEqual(receipt["acceptedAttemptId"], identity["attempt_id"])
        self.assertEqual(receipt["retryReceiptId"], identity["receipt_id"])
        self.assertEqual(receipt["modelInputBindingSha256"], identity["binding"])
        self.assertEqual(receipt["inputBackgroundSha256"], identity["background_digest"])
        self.assertRegex(receipt["canonicalDigest"], r"^[0-9a-f]{64}$")
        with self._connection() as connection, connection.cursor() as cursor:
            replay = self._detail_complete(cursor, claim, result, metadata)
            after = self._detail_claim(cursor, identity)
        self.assertEqual(replay, completed)
        self.assertEqual(after, completed)
        with self.assertRaises(psycopg2.Error) as tampered:
            with self._connection() as connection, connection.cursor() as cursor:
                self._detail_complete(cursor, claim, {**result, "read": "x=3"}, metadata)
        self.assertEqual(tampered.exception.pgcode, "55000")

    def test_detail_generation_cas_converges_and_hash_drift_fails_closed(self):
        identity = self._detail_fixture()
        with self._connection() as connection, connection.cursor() as cursor:
            initial = self._detail_claim(cursor, identity)
        self.assertEqual(initial["action"], "invoke")

        requests = [f"paper-detail-generation-{uuid.uuid4()}" for _ in range(2)]
        def issue(index):
            return lambda cursor: self._detail_issue(cursor, identity, 0, requests[index])
        results = self._run_race([(issue(0), False), (issue(1), False)])
        self.assertTrue(all(result["ok"] for result in results), results)
        issued = [result["value"] for result in results]
        self.assertEqual({row["generation"] for row in issued}, {1})
        self.assertEqual(len({row["job_id"] for row in issued}), 1)

        with self._connection() as connection, connection.cursor() as cursor:
            generation_one = self._detail_claim(cursor, identity, generation=1)
        self.assertEqual(generation_one["action"], "invoke")
        mutated_binding = {**identity["binding_json"], "promptSha256": "d" * 64}
        with self.assertRaises(psycopg2.Error) as digest_mismatch:
            with self._connection() as connection, connection.cursor() as cursor:
                self._detail_claim(
                    cursor, identity, generation=1,
                    binding_json=mutated_binding, binding=identity["binding"],
                )
        self.assertEqual(digest_mismatch.exception.pgcode, "22023")
        with self.assertRaises(psycopg2.Error) as binding_drift:
            with self._connection() as connection, connection.cursor() as cursor:
                self._detail_claim(
                    cursor, identity, generation=1,
                    binding_json=mutated_binding,
                    binding=self._canonical_digest(mutated_binding),
                )
        self.assertEqual(binding_drift.exception.pgcode, "22023")

    def test_auth_user_delete_cascades_all_protocol_rows(self):
        run_id, attempt_id, _original, correction = self._past_accepted_with_correction()
        receipt_id = f"paper-correction-retry-{uuid.uuid4().hex}"
        token = f"paper-grade-lease-{uuid.uuid4().hex}"
        with self._connection(authenticated=True) as connection, connection.cursor() as cursor:
            correction_receipt = self._correction_receipt(
                cursor, receipt_id, run_id, attempt_id, 1, correction["manifest"]
            )
        correction_grade_identity = {
            "run_id": run_id,
            "source_id": "paper-mock-1",
            "question_no": 1,
            "receipt_id": receipt_id,
            "receipt_digest": correction_receipt["canonicalDigest"],
            "binding": "2" * 64,
        }
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "insert into public.app_state (user_id, data) values (%s, '{}'::jsonb)",
                (self.user_id,),
            )
            self._claim(cursor, run_id, attempt_id, "1" * 64, token)
            self._correction_grade_claim(cursor, correction_grade_identity)
            detail_identity = {
                **correction_grade_identity,
                "attempt_id": attempt_id,
                "binding_json": {"promptSha256": "a" * 64},
                "background": {"userNote": "", "attemptLogs": []},
            }
            detail_identity["binding"] = self._canonical_digest(detail_identity["binding_json"])
            detail_identity["background_digest"] = self._canonical_digest(detail_identity["background"])
            self._detail_claim(cursor, detail_identity)
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute("delete from auth.users where id = %s", (self.user_id,))
        tables = (
            "app_users",
            "app_state",
            "ink_sessions",
            "paper_submit_attempts",
            "paper_grade_jobs",
            "paper_correction_retry_receipts",
            "paper_correction_grade_jobs",
            "paper_detail_jobs",
        )
        with self._connection() as connection, connection.cursor() as cursor:
            for table in tables:
                cursor.execute(
                    f"select count(*) from public.{table} where user_id = %s",
                    (self.user_id,),
                )
                self.assertEqual(cursor.fetchone()[0], 0, table)


if __name__ == "__main__":
    unittest.main(verbosity=2)
