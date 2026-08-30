import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300004_freeze_accepted_paper_ink.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"


class AcceptedPaperInkFreezeSchemaTests(unittest.TestCase):
    def setUp(self):
        self.migration = MIGRATION.read_text(encoding="utf-8")
        self.schema = SCHEMA.read_text(encoding="utf-8")

    def test_guard_is_in_migration_and_canonical_schema(self):
        for sql in (self.migration, self.schema):
            self.assertIn("matha_paper_ink_accepted_guard", sql)
            self.assertRegex(
                sql,
                r"before\s+insert\s+or\s+update\s+or\s+delete\s+on\s+public\.ink_sessions",
            )

    def test_only_original_paper_checkpoint_namespace_is_frozen(self):
        for sql in (self.migration, self.schema):
            self.assertIn(
                "^paper:(paper-run-[0-9]{10,20}):v[0-9]+:[0-9]+$",
                sql,
            )
            self.assertNotIn("paper-correction:(paper-run-", sql)

    def test_guard_serializes_with_submit_and_checks_both_update_sides(self):
        for sql in (self.migration, self.schema):
            self.assertIn("matha-paper-submit:", sql)
            self.assertIn("values (v_old_run), (v_new_run)", sql.lower())
            self.assertIn("candidate.status = 'accepted'", sql)
            self.assertIn("candidate.decision_reason = 'accepted-first-for-run'", sql)
            self.assertIn("paper ink checkpoint owner is immutable", sql)

    def test_account_delete_cascade_and_client_denial_are_explicit(self):
        for sql in (self.migration, self.schema):
            self.assertRegex(
                sql,
                r"tg_op\s*=\s*'DELETE'\s+and\s+not\s+exists\s*\(\s*select\s+1\s+from\s+auth\.users",
            )
            self.assertIn("accepted paper ink is immutable for run", sql)
            self.assertRegex(
                sql,
                r"revoke\s+all\s+on\s+function\s+public\.matha_paper_ink_accepted_guard\(\)",
            )


if __name__ == "__main__":
    unittest.main()
