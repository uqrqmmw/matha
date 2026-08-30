import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300008_create_paper_grade_latest_status.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"
EDGE = ROOT / "supabase" / "functions" / "openai-proxy" / "index.ts"
APP = ROOT / "app.js"
START = "-- BEGIN PAPER GRADE LATEST STATUS 202608300008"
END = "-- END PAPER GRADE LATEST STATUS 202608300008"


def text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()


class PaperGradeLatestStatusTests(unittest.TestCase):
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

    def test_latest_lookup_is_read_only_service_role_and_fail_closed(self):
        self.assertIn("order by generation desc", self.sql)
        self.assertIn("limit 1", self.sql)
        self.assertIn("accepted paper submit winner required", self.sql)
        self.assertNotIn("insert into public.paper_grade_jobs", self.sql)
        self.assertNotIn("update public.paper_grade_jobs", self.sql)
        self.assertIn("to service_role", self.sql)
        self.assertNotIn("to authenticated", self.sql)
        self.assertIn("interval '15 minutes'", self.sql)

    def test_edge_and_app_use_latest_status_only_for_conflict_reconciliation(self):
        self.assertIn('"paper_grade_latest_status"', self.edge)
        self.assertIn('matha_paper_grade_latest_status', self.edge)
        self.assertIn("responseType:'paper_grade_latest_status'", self.app)
        self.assertIn("paperAiGradeConflictReconcile", self.app)
        self.assertIn("paperGradeGenerationConflictRequests", self.app)


if __name__ == "__main__":
    unittest.main()
