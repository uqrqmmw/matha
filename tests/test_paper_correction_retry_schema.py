import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300006_create_paper_correction_retry_receipts.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"
EDGE = ROOT / "supabase" / "functions" / "openai-proxy" / "index.ts"
LIB = ROOT / "supabase" / "functions" / "openai-proxy" / "lib.ts"
APP = ROOT / "app.js"
START = "-- BEGIN PAPER CORRECTION RETRY RECEIPT 202608300006"
END = "-- END PAPER CORRECTION RETRY RECEIPT 202608300006"


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()


class PaperCorrectionRetryReceiptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = text(MIGRATION)
        schema = text(SCHEMA)
        start = schema.index(START)
        end = schema.index(END, start) + len(END)
        cls.schema_block = schema[start:end]
        cls.edge = text(EDGE)
        cls.lib = text(LIB)
        cls.app = text(APP)

    def test_migration_is_mirrored_exactly(self):
        self.assertEqual(self.schema_block, self.sql)

    def test_receipt_is_private_immutable_and_cascade_safe(self):
        self.assertIn("references auth.users (id) on delete cascade", self.sql)
        self.assertIn("force row level security", self.sql)
        self.assertIn("revoke all on table public.paper_correction_retry_receipts", self.sql)
        self.assertIn("before update on public.paper_correction_retry_receipts", self.sql)
        self.assertNotIn("before update or delete on public.paper_correction_retry_receipts", self.sql)

    def test_rpc_requires_next_taipei_day_and_new_checkpoint(self):
        self.assertGreaterEqual(self.sql.count("at time zone 'Asia/Taipei'"), 4)
        self.assertIn("v_ink.server_updated_at <= v_attempt.accepted_at", self.sql)
        self.assertRegex(
            self.sql,
            r"(?s)v_ink\.server_updated_at at time zone 'Asia/Taipei'.*?"
            r"v_attempt\.accepted_at at time zone 'Asia/Taipei'",
        )
        self.assertIn("v_ink.server_updated_at > clock_timestamp()", self.sql)
        self.assertIn("new.server_updated_at := clock_timestamp()", self.sql)
        self.assertIn("before insert or update on public.ink_sessions", self.sql)
        self.assertIn("jsonb_array_length(stroke->'pts') > 1", self.sql)
        self.assertIn("coalesce(stroke->>'dead', 'false') = 'false'", self.sql)

    def test_checkpoint_is_verified_and_cannot_unlock_two_questions(self):
        self.assertIn("from public.ink_sessions", self.sql)
        for value in (
            "client_id = v_client_id", "qid = v_qid",
            "v_ink.updated_at is distinct from v_updated_at",
            "v_ink.server_updated_at is distinct from v_server_updated_at",
            "v_ink.proc->>'revision'", "v_ink.strokes->>'revision'",
            "correction_live_stroke_digests", "correction_new_stroke_digests",
        ):
            self.assertIn(value, self.sql)
        self.assertNotIn("v_server_sha256 <> v_cloud_sha256", self.sql)
        self.assertIn("'^(0|[1-9][0-9]{0,8})$'", self.sql)
        index = self.sql[
            self.sql.index("create unique index if not exists paper_correction_retry_checkpoint_once"):
            self.sql.index("create index if not exists paper_correction_retry_user_run")
        ]
        self.assertNotIn("question_no", index)
        self.assertIn("correction_client_id", index)
        self.assertIn("correction_revision", index)
        self.assertIn("correction_cloud_sha256", index)
        self.assertIn("paper correction checkpoint already proves another question", self.sql)
        self.assertIn("'matha-paper-correction:' || v_user::text || ':' || p_run_id", self.sql)
        self.assertIn("correction_live_stroke_ids", self.sql)
        self.assertIn("correction_new_stroke_ids", self.sql)
        self.assertIn("jsonb_typeof(stroke->'qno') = 'number'", self.sql)
        self.assertIn("(stroke->>'qno')::integer = p_question_no", self.sql)
        self.assertIn("questionTagSchema", self.sql)
        self.assertIn("paper correction requires a question-tagged live handwritten stroke", self.sql)
        self.assertIn("used.id = candidate.stroke->>'id'", self.sql)
        self.assertIn("correction_new_strokes", self.sql)
        self.assertIn("correction_live_strokes", self.sql)
        self.assertIn("'correctionLiveStrokes', v_live_strokes", self.sql)
        self.assertIn("'correctionNewStrokes', v_new_strokes", self.sql)
        for field in ("'qno', p_question_no", "'pts', live.pts", "'c', live.color",
                      "'w', live.width", "'t0', live.t0", "'t1', live.t1"):
            self.assertIn(field, self.sql)
        self.assertIn("'geometryDigest', live.digest", self.sql)
        self.assertIn("paper correction retry requires a new question-tagged stroke geometry", self.sql)
        self.assertIn("used.digest = candidate.stroke->>'geometryDigest'", self.sql)
        self.assertIn("jsonb_array_elements(prior.correction_live_strokes)", self.sql)
        self.assertIn("where current.stroke = historical.stroke", self.sql)
        self.assertIn("paper correction historical geometry changed or was deleted", self.sql)

    def test_receipt_snapshots_bounded_full_geometry(self):
        for value in (
            "jsonb_array_length(stroke->'pts') <= 10000",
            "(point->>0)::numeric between 0 and 1",
            "(point->>1)::numeric between 0 and 1",
            "(point->>2)::numeric between 0 and 1",
            "stroke->>'c' in ('black', 'blue', 'green')",
            "(stroke->>'w')::numeric between 0.35 and 2",
            "(stroke->>'t1')::numeric >= (stroke->>'t0')::numeric",
            "v_total_points > 50000",
            "pg_column_size(v_new_strokes) > 1000000",
        ):
            self.assertIn(value, self.sql)
        self.assertIn('await canonicalSha256({', self.lib)
        self.assertIn('pts: stroke.pts', self.lib)
        self.assertIn('liveMetrics.points > 50_000', self.lib)
        self.assertIn('newMetrics.points > 50_000', self.lib)
        self.assertIn('liveMetrics.bytes > 1_000_000', self.lib)
        self.assertIn('newMetrics.bytes > 1_000_000', self.lib)

    def test_edge_reloads_receipt_and_checks_server_question_page_map(self):
        self.assertIn("loadPaperCorrectionRetryReceipt", self.edge)
        self.assertIn("verifiedCorrectionRetryContext", self.edge)
        self.assertIn("paperCorrectionRetryReceipt(raw)", self.edge)
        self.assertIn("correctionRetryReceiptDigest", self.edge)
        self.assertIn("paperCorrectionQuestionPage", self.lib)
        self.assertIn("pageNo !== expectedPage", self.lib)

    def test_app_gets_receipt_before_detail_solution_or_correction_model(self):
        self.assertIn("supa.rpc('matha_paper_correction_retry_accept'", self.app)
        self.assertIn("await paperCorrectionRetryReceiptAcquire(review, no, state);", self.app)
        self.assertIn("paperReviewLiveStrokeIds(page, no)", self.app)
        self.assertIn("paperInkStrokeQuestionNo(stroke) === qno", self.app)
        self.assertIn("questionTagSchema:1", self.app)
        self.assertIn("responseType:'paper_correction_grade'", self.app)
        self.assertNotIn("paperAiCorrectionCall(review.source, no, image)", self.app)
        self.assertIn("paperCorrectionGradePayloadVerified", self.app)
        self.assertIn("correctionLiveStrokes:liveStrokes.map", self.app)
        self.assertIn("correctionNewStrokes:newStrokes.map", self.app)
        self.assertGreaterEqual(
            self.app.count("correctionRetryReceiptId:"),
            2,
        )
        self.assertGreaterEqual(
            self.app.count("correctionRetryReceiptDigest:"),
            2,
        )


if __name__ == "__main__":
    unittest.main()
