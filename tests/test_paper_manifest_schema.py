import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300005_bind_accepted_paper_manifest.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"
EDGE = ROOT / "supabase" / "functions" / "openai-proxy" / "index.ts"
APP = ROOT / "app.js"
START = "-- BEGIN ACCEPTED PAPER MANIFEST 202608300005"
END = "-- END ACCEPTED PAPER MANIFEST 202608300005"


def text(path):
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()


class AcceptedPaperManifestTests(unittest.TestCase):
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

    def test_manifestless_accept_overload_is_removed(self):
        self.assertRegex(
            self.sql,
            r"drop function if exists public\.matha_paper_submit_accept\(\s*"
            r"text, text, text, bigint, text, bigint, text\s*\)",
        )
        self.assertIn("p_page_manifest jsonb", self.sql)
        self.assertIn("ink_snapshot_sha256, page_manifest, submitted_at", self.sql)
        self.assertIn("p_ink_snapshot_sha256, v_manifest, p_submitted_at", self.sql)

    def test_accept_and_ink_writes_share_the_same_advisory_lock(self):
        self.assertIn("matha-paper-submit:' || v_user::text", self.sql)
        freeze = text(ROOT / "supabase" / "migrations" / "202608300004_freeze_accepted_paper_ink.sql")
        self.assertIn("matha-paper-submit:' || v_user::text", freeze)

    def test_rpc_verifies_every_cloud_checkpoint_inside_lock(self):
        lock = self.sql.index("pg_advisory_xact_lock")
        read = self.sql.index("from public.ink_sessions", lock)
        insert = self.sql.index("insert into public.paper_submit_attempts", read)
        self.assertLess(lock, read)
        self.assertLess(read, insert)
        for field in (
            "client_id = v_client_id", "qid = v_qid", "updated_at = v_updated_at",
            "v_ink.proc->>'revision'", "v_ink.strokes->>'revision'",
            "v_server_sha256 <> v_cloud_sha256",
        ):
            self.assertIn(field, self.sql)

    def test_edge_uses_immutable_manifest_not_runtime_audit_refs_for_grading(self):
        start = self.edge.index("async function preparePaperGradeAuthority")
        end = self.edge.index("function decodeStrictBase64", start)
        prepare = self.edge[start:end]
        self.assertIn("submitAttempt.pageManifest.map", prepare)
        self.assertIn("submitAttempt.pageManifest,", prepare)
        self.assertNotIn("paperRuntimeAuditInkReferences(data, runId)", prepare)

    def test_client_accepted_loader_selects_only_manifest_client_ids(self):
        start = self.app.index("async function paperAcceptedInkLoadAll")
        end = self.app.index("function paperInkPage", start)
        loader = self.app[start:end]
        self.assertIn("row.client_id === ref.clientId", loader)
        self.assertIn("matches.length !== 1", loader)
        self.assertIn("serverSha256 !== ref.cloudSha256", loader)
        self.assertNotIn("[...cloudRows, ...localRows]", loader)
        self.assertIn("await paperAcceptedInkLoadAll(run, source)", self.app)

    def test_answer_gate_loads_exact_accepted_attempt(self):
        self.assertIn("verifiedAcceptedPaperContext", self.edge)
        self.assertIn("loadAcceptedPaperSubmitAttempt", self.edge)
        start = self.edge.index("async function paperAnswerKeyAfterSubmit")
        end = self.edge.index("async function paperSolutionAfterRetry", start)
        answer_gate = self.edge[start:end]
        self.assertIn("verifiedAcceptedPaperContext(userId, context)", answer_gate)
        self.assertNotIn("loadAppState", answer_gate)
        self.assertNotIn("paperKeyGateAllows", answer_gate)
        self.assertIn("page_manifest", self.edge)

    def test_detail_and_solution_require_server_retry_receipt(self):
        self.assertIn("verifiedCorrectionRetryContext", self.edge)
        self.assertIn("loadPaperCorrectionRetryReceipt", self.edge)
        self.assertIn("correctionRetryReceiptDigest", self.edge)
        self.assertNotIn("paperDetailGateAllows(data", self.edge)
        self.assertNotIn("paperSolutionGateAllows(data", self.edge)


if __name__ == "__main__":
    unittest.main()
