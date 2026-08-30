import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300007_recover_paper_grade_completion_artifacts.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"
EDGE = ROOT / "supabase" / "functions" / "openai-proxy" / "index.ts"
START = "-- BEGIN PAPER GRADE COMPLETION ARTIFACT RECOVERY 202608300007"
END = "-- END PAPER GRADE COMPLETION ARTIFACT RECOVERY 202608300007"


def function(sql: str, name: str) -> str:
    match = re.search(
        rf"create or replace function public\.{re.escape(name)}\b(?P<body>.*?)(?=\ncreate or replace function|\nrevoke all on function|\Z)",
        sql,
        re.S | re.I,
    )
    if not match:
        raise AssertionError(f"function {name} not found")
    return match.group(0)


class PaperGradeCompletionRecoverySchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION.read_text(encoding="utf-8")
        cls.schema = SCHEMA.read_text(encoding="utf-8")
        cls.edge = EDGE.read_text(encoding="utf-8")

    def test_migration_is_mirrored_exactly_in_schema(self):
        start = self.schema.index(START)
        end = self.schema.index(END, start) + len(END)
        self.assertEqual(self.schema[start:end].strip(), self.sql.strip())

    def test_completion_artifact_is_hash_and_identity_bound(self):
        self.assertIn("completion_artifact_path text", self.sql)
        self.assertIn("completion_artifact_sha256 text", self.sql)
        self.assertIn("completion_artifact_canonical_digest text", self.sql)
        self.assertIn("completion_artifact_bytes bigint", self.sql)
        recovery = function(self.sql, "matha_paper_grade_job_recover_from_artifact")
        self.assertIn("v_expected_user_binding := 'matha_'", recovery)
        self.assertIn("v_expected_path := 'grade-completions/'", recovery)
        self.assertIn("p_completion_artifact_path is distinct from v_expected_path", recovery)
        self.assertIn("p_completion_artifact_sha256", recovery)
        self.assertIn("v_artifact_canonical_digest", recovery)
        self.assertIn("p_model_input_binding_sha256", recovery)

    def test_completed_rows_require_verified_artifact_and_legacy_rpc_is_removed(self):
        self.assertIn("status <> 'completed'", self.sql)
        self.assertIn("status = 'completed'", self.sql)
        self.assertIn("and recovered_from_artifact = true", self.sql)
        self.assertIn(
            "legacy paper grade completion requires verified artifact backfill",
            self.sql,
        )
        self.assertRegex(
            self.sql,
            r"drop function if exists public\.matha_paper_grade_job_complete\(\s*"
            r"uuid, text, text, text, bigint, text, jsonb, jsonb, jsonb\s*\);",
        )
        self.assertNotRegex(
            self.sql,
            r"create or replace function public\.matha_paper_grade_job_complete\b",
        )

    def test_recovery_is_service_role_only_and_requires_dispatched(self):
        recovery = function(self.sql, "matha_paper_grade_job_recover_from_artifact")
        self.assertIn("security definer", recovery.lower())
        self.assertIn("if v_job.status <> 'dispatched'", recovery)
        self.assertRegex(
            self.sql,
            r"revoke all on function public\.matha_paper_grade_job_recover_from_artifact\([\s\S]*?from public, anon, authenticated, service_role;",
        )
        self.assertRegex(
            self.sql,
            r"grant execute on function public\.matha_paper_grade_job_recover_from_artifact\([\s\S]*?to service_role;",
        )
        self.assertNotRegex(
            self.sql,
            r"grant execute on function public\.matha_paper_grade_job_recover_from_artifact\([\s\S]*?to authenticated;",
        )

    def test_recovery_is_idempotent_but_rejects_changed_artifact(self):
        recovery = function(self.sql, "matha_paper_grade_job_recover_from_artifact")
        completed = recovery.index("if v_job.status = 'completed'")
        changed = recovery.index("completed paper grade artifact changed")
        returned = recovery.index(
            "return public.matha_paper_grade_job_receipt(v_job, 'completed')",
            changed,
        )
        update = recovery.index("update public.paper_grade_jobs set", returned)
        self.assertLess(completed, changed)
        self.assertLess(changed, returned)
        self.assertLess(returned, update)
        self.assertIn("is distinct from p_completion_artifact_sha256", recovery)
        self.assertIn("is distinct from v_artifact_canonical_digest", recovery)

    def test_stale_dispatched_job_is_terminal_not_released(self):
        status = function(self.sql, "matha_paper_grade_job_status")
        self.assertIn("v_job.status = 'dispatched'", status)
        self.assertIn("interval '15 minutes'", status)
        self.assertIn("matha_paper_grade_job_receipt(v_job, 'lost')", status)
        self.assertNotIn("update public.paper_grade_jobs", status)
        receipt = function(self.sql, "matha_paper_grade_job_receipt")
        self.assertIn("'requires_explicit_generation', p_action = 'lost'", receipt)

    def test_edge_archives_and_reads_bytes_before_atomic_completion(self):
        archive = self.edge.index("archivePaperGradeCompletionArtifact(", self.edge.index("const completionIdentity"))
        recover = self.edge.index("recoverPaperGradeCompletionArtifact(", archive)
        self.assertLess(archive, recover)
        self.assertNotIn('serviceRpc("matha_paper_grade_job_complete"', self.edge)
        self.assertIn("readback.sha256 !== sha256", self.edge)
        self.assertIn("serializePaperGradeCompletionArtifact(readback.artifact) !== content", self.edge)
        self.assertIn("completionArtifact.verified !== true", self.edge)

    def test_completed_receipt_explicitly_carries_verified_artifact_authority(self):
        receipt = function(self.sql, "matha_paper_grade_job_receipt")
        self.assertIn("'verified', (p_job).recovered_from_artifact", receipt)
        self.assertIn(
            "'authority', 'supabase-service-role-storage-readback'",
            receipt,
        )

    def test_status_attempts_recovery_before_reporting_lost(self):
        route = self.edge[
            self.edge.index('if (responseType === "paper_grade_status")'):
            self.edge.index("let paperGradeAuthority", self.edge.index('if (responseType === "paper_grade_status")'))
        ]
        completed = route.index('record?.action === "completed"')
        recover = route.index("recoverPaperGradeCompletionArtifact")
        lost = route.index('record?.action === "lost"')
        self.assertLess(completed, recover)
        self.assertLess(recover, lost)
        self.assertIn("paperGradeCompletedPayload(rawJob)", route)
        self.assertIn("requiresExplicitGeneration: true", self.edge)


if __name__ == "__main__":
    unittest.main()
