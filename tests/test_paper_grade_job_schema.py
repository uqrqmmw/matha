import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300003_create_paper_grade_jobs.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"
EDGE = ROOT / "supabase" / "functions" / "openai-proxy" / "index.ts"
START = "-- BEGIN PAPER GRADE JOB PROTOCOL 202608300003"
END = "-- END PAPER GRADE JOB PROTOCOL 202608300003"


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()


def function(sql: str, name: str) -> str:
    match = re.search(
        rf"create or replace function public\.{name}\(.*?\n\$\$;(?:\n|$)",
        sql,
        re.S,
    )
    if not match:
        raise AssertionError(f"missing function {name}")
    return match.group(0)


class PaperGradeJobSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = text(MIGRATION)
        schema = text(SCHEMA)
        start = schema.index(START)
        end = schema.index(END, start) + len(END)
        cls.schema_block = schema[start:end]
        cls.edge = text(EDGE)

    def test_migration_is_mirrored_exactly_in_schema(self):
        self.assertEqual(self.schema_block, self.sql)

    def test_identity_and_generation_are_database_unique(self):
        self.assertRegex(
            self.sql,
            r"primary key \(\s*user_id, run_id, accepted_attempt_id, "
            r"model_input_binding_sha256, generation\s*\)",
        )
        self.assertRegex(
            self.sql,
            r"paper_grade_jobs_generation_binding\s+on public\.paper_grade_jobs "
            r"\(user_id, run_id, accepted_attempt_id, generation\)",
        )
        self.assertRegex(
            self.sql,
            r"(?s)paper_grade_jobs_issuance_request.*?issuance_request_id\)\s+"
            r"where issuance_request_id is not null",
        )
        self.assertIn("generation = 0 and issuance_request_id is null", self.sql)

    def test_claim_serializes_devices_and_only_recovers_pre_dispatch_lease(self):
        claim = function(self.sql, "matha_paper_grade_job_claim")
        self.assertIn("pg_advisory_xact_lock", claim)
        self.assertIn("and generation = p_generation;", claim)
        select = claim[claim.index("select * into v_job"):claim.index("if not found and p_generation = 0")]
        self.assertNotIn("model_input_binding_sha256 =", select)
        self.assertIn("if v_job.model_input_binding_sha256 <> p_model_input_binding_sha256", claim)
        self.assertIn("case when v_job.status = 'completed' then 'completed' else 'pending' end", claim)
        self.assertIn("if v_job.status = 'dispatched'", claim)
        self.assertIn("v_job.lease_expires_at > now()", claim)

    def test_device_b_different_binding_recovers_device_a_completed_result(self):
        claim = function(self.sql, "matha_paper_grade_job_claim")
        drift = claim[
            claim.index("if v_job.model_input_binding_sha256"):
            claim.index("if v_job.status = 'completed'")
        ]
        self.assertIn("case when v_job.status = 'completed' then 'completed' else 'pending' end", drift)
        self.assertLess(claim.index("if v_job.status = 'completed'"), claim.rindex("update public.paper_grade_jobs set"))

    def test_device_b_different_binding_sees_device_a_dispatched_as_pending(self):
        claim = function(self.sql, "matha_paper_grade_job_claim")
        drift = claim[
            claim.index("if v_job.model_input_binding_sha256"):
            claim.index("if v_job.status = 'completed'")
        ]
        self.assertIn("case when v_job.status = 'completed' then 'completed' else 'pending' end", drift)
        self.assertLess(claim.index("if v_job.status = 'dispatched'"), claim.rindex("update public.paper_grade_jobs set"))

    def test_reserved_or_expired_pre_dispatch_lease_can_rebind(self):
        claim = function(self.sql, "matha_paper_grade_job_claim")
        drift = claim[
            claim.index("if v_job.model_input_binding_sha256"):
            claim.index("if v_job.status = 'completed'")
        ]
        self.assertIn("v_job.status = 'reserved'", drift)
        self.assertIn("and v_job.lease_token is null", drift)
        self.assertIn("v_job.status = 'leased'", drift)
        self.assertIn("and v_job.lease_expires_at <= now()", drift)
        self.assertIn("model_input_binding_sha256 = p_model_input_binding_sha256", drift)
        leased = drift[drift.index("elsif v_job.dispatched_at is null"):drift.rindex("else")]
        self.assertIn("lease_token = p_lease_token", leased)
        self.assertIn("lease_expires_at = now() + make_interval", leased)
        self.assertIn("status = 'leased'", leased)
        self.assertNotIn("status = 'reserved'", leased)
        self.assertIn("paper_grade_job_receipt(v_job, 'invoke')", leased)
        self.assertIn("else", drift)
        guard = function(self.sql, "matha_paper_grade_job_guard")
        self.assertIn("old.status = 'reserved' and new.status = 'reserved'", guard)
        self.assertIn("old.status = 'leased' and new.status = 'leased'", guard)
        self.assertIn("old.lease_expires_at <= now()", guard)
        self.assertIn("paper grade model input binding is immutable after reservation", guard)
        dispatched = function(self.sql, "matha_paper_grade_job_mark_dispatched")
        self.assertIn("model_input_binding_sha256 = p_model_input_binding_sha256", dispatched)
        self.assertIn("v_job.lease_token <> p_lease_token", dispatched)
        self.assertIn("v_job.lease_expires_at > now()", claim)

    def test_explicit_generation_retry_is_idempotent_even_if_composite_drifts(self):
        issue = function(self.sql, "matha_paper_grade_issue_generation")
        self.assertIn("issuance_request_id = p_issuance_request_id", issue)
        existing = issue[issue.index("if found then"):issue.index("-- Compare-and-set issuance")]
        self.assertIn("return public.matha_paper_grade_job_receipt(v_existing, 'issued')", issue)
        self.assertNotIn("model_input_binding_sha256 <>", existing)

    def test_different_issuance_ids_from_same_previous_generation_share_one_job(self):
        issue = function(self.sql, "matha_paper_grade_issue_generation")
        self.assertIn("p_previous_generation bigint", issue)
        self.assertIn("v_generation := p_previous_generation + 1", issue)
        target = issue[issue.index("v_generation :="):issue.index("if exists (")]
        self.assertIn("and generation = v_generation", target)
        self.assertIn("paper_grade_job_receipt(v_existing, 'issued')", target)
        self.assertLess(issue.index("pg_advisory_xact_lock"), issue.index("v_generation :="))
        self.assertNotIn("coalesce(max(generation)", issue)

    def test_completion_stores_one_immutable_exact_envelope_and_digests(self):
        complete = function(self.sql, "matha_paper_grade_job_complete")
        for field in (
            "normalized_model_json", "normalized_model_json_sha256",
            "model_metadata", "model_metadata_sha256",
            "receipt_envelope", "receipt_envelope_sha256",
        ):
            self.assertIn(field, complete)
        self.assertEqual(complete.count("digest(convert_to("), 3)
        self.assertIn("completed paper grade payload changed", complete)
        self.assertIn("v_job.status <> 'dispatched'", complete)
        guard = function(self.sql, "matha_paper_grade_job_guard")
        self.assertIn("old.status = 'completed'", guard)
        self.assertIn("completed paper grade job is immutable", guard)

    def test_status_recovery_never_creates_or_leases_a_job(self):
        status = function(self.sql, "matha_paper_grade_job_status")
        self.assertIn("'action', 'missing'", status)
        self.assertIn("case when v_job.status = 'completed' then 'completed' else 'pending' end", status)
        self.assertNotIn("insert into public.paper_grade_jobs", status)
        self.assertNotIn("update public.paper_grade_jobs", status)
        status_route = self.edge[
            self.edge.index('if (responseType === "paper_grade_status")'):
            self.edge.index("let paperGradeAuthority", self.edge.index('if (responseType === "paper_grade_status")'))
        ]
        self.assertIn('serviceRpc("matha_paper_grade_job_status"', status_route)
        self.assertNotIn("OPENAI_API_KEY", status_route)
        self.assertNotIn("matha_paper_grade_job_claim", status_route)

    def test_edge_rechecks_server_snapshot_before_any_grade_claim(self):
        prepare = self.edge[
            self.edge.index("async function preparePaperGradeAuthority"):
            self.edge.index("function decodeStrictBase64")
        ]
        self.assertIn("submission.inkSnapshotSha256 !== submitAttempt.inkSnapshotSha256", prepare)
        self.assertLess(
            self.edge.index("preparePaperGradeAuthority("),
            self.edge.index('const apiKey = Deno.env.get("OPENAI_API_KEY")'),
        )

    def test_model_result_is_private_and_only_edge_service_role_can_transition(self):
        self.assertIn("alter table public.paper_grade_jobs force row level security;", self.sql)
        self.assertIn(
            "revoke all on table public.paper_grade_jobs from public, anon, authenticated, service_role;",
            self.sql,
        )
        self.assertIn("grant select on table public.paper_grade_jobs to service_role;", self.sql)
        self.assertNotRegex(self.sql, r"grant (?:select|insert|update|delete|all).*paper_grade_jobs to authenticated")
        self.assertEqual(len(re.findall(r"grant execute on function public\.matha_paper_grade_.*?\n  to service_role;", self.sql, re.S)), 5)
        self.assertNotRegex(self.sql, r"(?s)grant execute on function public\.matha_paper_grade_.*?to authenticated")

    def test_account_delete_cascade_is_not_blocked_but_normal_delete_stays_denied(self):
        self.assertIn("references auth.users (id) on delete cascade", self.sql)
        self.assertIn("references public.paper_submit_attempts (user_id, attempt_id) on delete cascade", self.sql)
        self.assertRegex(
            self.sql,
            r"create trigger paper_submit_attempts_immutable\s+before update on public\.paper_submit_attempts",
        )
        self.assertNotRegex(
            self.sql,
            r"create trigger paper_submit_attempts_immutable\s+before update or delete",
        )
        self.assertNotRegex(self.sql, r"grant delete on table public\.(?:paper_submit_attempts|paper_grade_jobs)")


if __name__ == "__main__":
    unittest.main()
