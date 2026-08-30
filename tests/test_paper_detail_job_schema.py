import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300011_create_paper_detail_jobs.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"
EDGE = ROOT / "supabase" / "functions" / "openai-proxy" / "index.ts"
APP = ROOT / "app.js"
START = "-- BEGIN PAPER DETAIL JOB PROTOCOL 202608300011"
END = "-- END PAPER DETAIL JOB PROTOCOL 202608300011"


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()


class PaperDetailJobSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = text(MIGRATION)
        schema = text(SCHEMA)
        start = schema.index(START)
        end = schema.index(END, start) + len(END)
        cls.schema_block = schema[start:end]
        cls.edge = text(EDGE)
        cls.app = text(APP)

    def test_migration_is_mirrored_exactly(self):
        self.assertEqual(self.schema_block, self.sql)

    def test_business_identity_prevents_hash_drift_from_creating_paid_job(self):
        marker = "create unique index if not exists paper_detail_job_one_binding_per_generation"
        exact = "create unique index if not exists paper_detail_job_exact_identity"
        one_binding = self.sql[self.sql.index(marker):self.sql.index(exact)]
        for field in (
            "user_id", "run_id", "source_id", "question_no",
            "retry_receipt_id", "generation",
        ):
            self.assertIn(field, one_binding)
        self.assertNotIn("model_input_binding_sha256", one_binding)
        self.assertNotIn("input_background_sha256", one_binding)
        self.assertIn("paper detail immutable binding changed", self.sql)

    def test_authority_requires_exact_accepted_attempt_and_retry_receipt(self):
        for value in (
            "status = 'accepted'",
            "decision_reason = 'accepted-first-for-run'",
            "accepted_attempt_id = p_accepted_attempt_id",
            "receipt_id = p_retry_receipt_id",
            "canonical_digest = p_retry_receipt_digest",
            "exact immutable correction retry receipt required",
        ):
            self.assertIn(value, self.sql)
        self.assertEqual(
            self.sql.count(
                "matha_canonical_jsonb_text(p_model_input_binding)"
            ),
            2,
        )
        self.assertEqual(
            self.sql.count("matha_canonical_jsonb_text(p_input_background)"),
            2,
        )

    def test_generation_zero_is_implicit_and_reanalysis_is_server_issued_cas(self):
        self.assertIn("generation = 0 and issuance_request_id is null", self.sql)
        self.assertIn("v_generation := p_previous_generation + 1", self.sql)
        self.assertIn("issuance_request_id = p_issuance_request_id", self.sql)
        self.assertIn("paper detail previous generation is stale", self.sql)
        self.assertIn("paper detail previous generation is unknown", self.sql)
        self.assertIn("paper detail generation must be server issued", self.sql)
        self.assertIn("pg_advisory_xact_lock", self.sql)

    def test_dispatched_never_auto_reinvokes_and_completed_replays_exactly(self):
        claim_start = self.sql.index("create or replace function public.matha_paper_detail_job_claim")
        dispatch_start = self.sql.index("create or replace function public.matha_paper_detail_job_mark_dispatched")
        claim = self.sql[claim_start:dispatch_start]
        self.assertIn("v_job.status = 'dispatched'", claim)
        self.assertIn("'pending'", claim)
        self.assertIn("v_job.status = 'completed'", claim)
        self.assertIn("'completed'", claim)
        self.assertIn("lease_expires_at <= now()", claim)
        self.assertNotIn("status = 'dispatched', lease_token", claim)
        self.assertIn("completed paper detail payload changed", self.sql)
        self.assertIn("v_job.normalized_result is distinct from p_normalized_result", self.sql)
        self.assertIn("v_job.model_metadata is distinct from p_model_metadata", self.sql)

    def test_server_builds_complete_immutable_result_receipt(self):
        for value in (
            "supabase-immutable-paper-detail-result-v1",
            "'jobKind', 'paper_detail'",
            "'generation', v_job.generation",
            "'acceptedAttemptId', v_job.accepted_attempt_id",
            "'retryReceiptId', v_job.retry_receipt_id",
            "'retryReceiptDigest', v_job.retry_receipt_digest",
            "'modelInputBindingSha256', v_job.model_input_binding_sha256",
            "'inputBackgroundSha256', v_job.input_background_sha256",
            "'normalizedResultSha256', v_result_sha256",
            "'modelMetadataSha256', v_metadata_sha256",
            "public.matha_canonical_jsonb_text(v_core)",
        ):
            self.assertIn(value, self.sql)
        self.assertIn("result_receipt_sha256 = v_receipt_sha256", self.sql)

    def test_jobs_are_private_owner_read_only_and_service_role_written(self):
        self.assertIn("force row level security", self.sql)
        self.assertIn("for select to authenticated", self.sql)
        self.assertIn("auth.uid() = user_id", self.sql)
        self.assertIn("revoke all on table public.paper_detail_jobs", self.sql)
        self.assertNotIn("grant insert", self.sql.lower())
        self.assertNotIn("grant update", self.sql.lower())
        for rpc in (
            "matha_paper_detail_issue_generation",
            "matha_paper_detail_job_claim",
            "matha_paper_detail_job_mark_dispatched",
            "matha_paper_detail_job_complete",
            "matha_paper_detail_job_status",
        ):
            self.assertIn(f"create or replace function public.{rpc}", self.sql)
            self.assertIn(f"grant execute on function public.{rpc}", self.sql)

    def test_detail_and_correction_grade_are_independent_job_tables(self):
        self.assertIn("create table if not exists public.paper_detail_jobs", self.sql)
        self.assertNotIn("insert into public.paper_correction_grade_jobs", self.sql)
        correction = text(
            ROOT / "supabase" / "migrations" /
            "202608300010_create_paper_correction_grade_jobs.sql"
        )
        self.assertIn("create table if not exists public.paper_correction_grade_jobs", correction)
        self.assertNotIn("insert into public.paper_detail_jobs", correction)

    def test_edge_claims_and_dispatches_before_model_then_completes_once(self):
        claim = self.edge.index('serviceRpc("matha_paper_detail_job_claim"')
        budget = self.edge.index("const budget = await claimAiBudget", claim)
        dispatch = self.edge.index(
            '"matha_paper_detail_job_mark_dispatched"', budget
        )
        model = self.edge.index("openAiResponse = await fetch(OPENAI_URL", dispatch)
        complete = self.edge.index(
            '"matha_paper_detail_job_complete"', model
        )
        self.assertLess(claim, budget)
        self.assertLess(budget, dispatch)
        self.assertLess(dispatch, model)
        self.assertLess(model, complete)
        self.assertIn("paperDetailPendingResponse", self.edge[model:complete])

    def test_edge_status_is_read_only_and_browser_authority_is_rejected(self):
        status_start = self.edge.index(
            'if (responseType === "paper_detail_status")'
        )
        status_end = self.edge.index("let paperGradeAuthority", status_start)
        status = self.edge[status_start:status_end]
        self.assertIn('serviceRpc("matha_paper_detail_job_status"', status)
        self.assertNotIn("OPENAI_URL", status)
        self.assertNotIn("matha_paper_detail_job_claim", status)
        self.assertIn(
            '["paper_detail", "paper_detail_status", "paper_detail_generation"]',
            self.edge,
        )
        self.assertIn(
            "body.messages !== undefined || body.instructions !== undefined",
            self.edge,
        )

    def test_app_verifies_db_receipt_before_gold_and_reanalysis_is_explicit(self):
        for value in (
            "supabase-immutable-paper-detail-result-v1",
            "supabase-paper-detail-prediction-v2",
            "paper_detail_status",
            "paper_detail_generation",
            "detailGenerationRequestId",
            "paperDetailPayloadVerified",
            "await capabilityCanonicalDigest(receiptCore)",
            "await capabilityCanonicalDigest(predictionCore)",
            "detailResultReceiptSha256",
        ):
            self.assertIn(value, self.app)
        call = self.app[
            self.app.index("async function paperAiDetailCall"):
            self.app.index("async function paperOfficialSolutionCall")
        ]
        self.assertIn("if (force)", call)
        self.assertIn("paper-detail-generation-", call)
        self.assertIn("detailJob.status === 'dispatched'", call)
        self.assertIn("responseType:'paper_detail_status'", call)


if __name__ == "__main__":
    unittest.main()
