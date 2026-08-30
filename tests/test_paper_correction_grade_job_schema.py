import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300010_create_paper_correction_grade_jobs.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"
START = "-- BEGIN PAPER CORRECTION GRADE JOB PROTOCOL 202608300010"
END = "-- END PAPER CORRECTION GRADE JOB PROTOCOL 202608300010"


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()


class PaperCorrectionGradeJobSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = text(MIGRATION)
        schema = text(SCHEMA)
        start = schema.index(START)
        end = schema.index(END, start) + len(END)
        cls.schema_block = schema[start:end]

    def test_migration_is_mirrored_exactly(self):
        self.assertEqual(self.schema_block, self.sql)

    def test_business_identity_has_one_immutable_binding(self):
        self.assertIn("create unique index if not exists paper_correction_grade_job_one_binding", self.sql)
        one_binding = self.sql[
            self.sql.index("create unique index if not exists paper_correction_grade_job_one_binding"):
            self.sql.index("create unique index if not exists paper_correction_grade_job_exact_identity")
        ]
        self.assertIn("retry_receipt_id", one_binding)
        self.assertNotIn("model_input_binding_sha256", one_binding)
        self.assertIn("raise exception 'paper correction grade binding changed'", self.sql)
        self.assertIn("old.model_input_binding_sha256 is distinct from new.model_input_binding_sha256", self.sql)

    def test_jobs_are_private_owner_read_only_and_rpc_written(self):
        self.assertIn("force row level security", self.sql)
        self.assertIn("for select to authenticated", self.sql)
        self.assertIn("auth.uid() = user_id", self.sql)
        self.assertIn("revoke all on table public.paper_correction_grade_jobs", self.sql)
        self.assertNotIn("grant insert", self.sql.lower())
        self.assertNotIn("grant update", self.sql.lower())
        for rpc in (
            "matha_paper_correction_grade_job_claim",
            "matha_paper_correction_grade_job_mark_dispatched",
            "matha_paper_correction_grade_job_complete",
            "matha_paper_correction_grade_job_status",
        ):
            self.assertIn(f"create or replace function public.{rpc}", self.sql)
            self.assertIn(f"grant execute on function public.{rpc}", self.sql)

    def test_claim_requires_exact_immutable_retry_receipt_and_advisory_lock(self):
        self.assertIn("from public.paper_correction_retry_receipts", self.sql)
        for field in (
            "receipt_id = p_retry_receipt_id",
            "run_id = p_run_id",
            "source_id = p_source_id",
            "question_no = p_question_no",
            "canonical_digest = p_retry_receipt_digest",
        ):
            self.assertIn(field, self.sql)
        self.assertIn("pg_advisory_xact_lock", self.sql)
        self.assertIn("exact immutable correction retry receipt required", self.sql)

    def test_dispatched_is_terminal_for_claim_and_completion_is_exact(self):
        claim_start = self.sql.index("create or replace function public.matha_paper_correction_grade_job_claim")
        dispatch_start = self.sql.index("create or replace function public.matha_paper_correction_grade_job_mark_dispatched")
        claim = self.sql[claim_start:dispatch_start]
        self.assertIn("v_job.status = 'dispatched'", claim)
        self.assertIn("'pending'", claim)
        self.assertNotIn("status = 'dispatched', lease_token", claim)
        self.assertIn("completed paper correction grade payload changed", self.sql)
        self.assertIn("v_job.normalized_result is distinct from p_normalized_result", self.sql)
        self.assertIn("v_job.model_metadata is distinct from p_model_metadata", self.sql)

    def test_server_builds_and_binds_result_receipt(self):
        for value in (
            "supabase-immutable-paper-correction-grade-result-v1",
            "'retryReceiptId', v_job.retry_receipt_id",
            "'retryReceiptDigest', v_job.retry_receipt_digest",
            "'modelInputBindingSha256', v_job.model_input_binding_sha256",
            "'normalizedResultSha256', v_result_sha256",
            "'modelMetadataSha256', v_metadata_sha256",
            "public.matha_canonical_jsonb_text(p_normalized_result)",
            "public.matha_canonical_jsonb_text(v_core)",
        ):
            self.assertIn(value, self.sql)
        self.assertIn("status = 'completed'", self.sql)
        self.assertIn("result_receipt_sha256 = v_receipt_sha256", self.sql)
        self.assertNotIn("jsonb_strip_nulls", self.sql)


if __name__ == "__main__":
    unittest.main()
