import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "202608300002_create_paper_submit_attempts.sql"
SCHEMA = ROOT / "supabase" / "schema.sql"
START = "-- BEGIN PAPER SUBMIT ATTEMPT PROTOCOL 202608300002"
END = "-- END PAPER SUBMIT ATTEMPT PROTOCOL 202608300002"


def sql_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()


class PaperSubmitAttemptSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = sql_text(MIGRATION)
        schema = sql_text(SCHEMA)
        start = schema.index(START)
        end = schema.index(END, start) + len(END)
        cls.schema_block = schema[start:end]

    def test_migration_is_mirrored_exactly_in_schema(self):
        self.assertEqual(self.schema_block, self.sql)

    def test_rpc_signatures_match_browser_contract(self):
        accept = re.search(
            r"create or replace function public\.matha_paper_submit_accept\((.*?)\)\s*"
            r"returns jsonb",
            self.sql,
            re.S,
        ).group(1)
        cancel = re.search(
            r"create or replace function public\.matha_paper_submit_cancel\((.*?)\)\s*"
            r"returns jsonb",
            self.sql,
            re.S,
        ).group(1)
        lookup = re.search(
            r"create or replace function public\.matha_paper_submit_lookup\((.*?)\)\s*"
            r"returns jsonb",
            self.sql,
            re.S,
        ).group(1)
        payload = [
            ("p_attempt_id", "text"), ("p_run_id", "text"),
            ("p_source_id", "text"), ("p_remaining_ms", "bigint"),
            ("p_ink_snapshot_sha256", "text"), ("p_submitted_at", "bigint"),
            ("p_run_created_app_version", "text"),
        ]
        for name, kind in payload:
            self.assertRegex(accept, rf"\b{name}\s+{kind}\b")
            self.assertRegex(cancel, rf"\b{name}\s+{kind}\b")
        self.assertRegex(lookup, r"\bp_attempt_id\s+text\b")
        self.assertRegex(lookup, r"\bp_run_id\s+text\b")
        self.assertNotIn("p_source_id", lookup)
        self.assertNotIn("p_user_id", self.sql)

    def test_table_and_unique_index_enforce_immutable_single_winner(self):
        for column in (
            "source_id", "remaining_ms", "ink_snapshot_sha256",
            "submitted_at", "run_created_app_version",
        ):
            self.assertRegex(self.sql, rf"\b{column}\s+\w+\s+not null")
        self.assertRegex(
            self.sql,
            r"create unique index if not exists paper_submit_attempts_one_accepted_run\s+"
            r"on public\.paper_submit_attempts \(user_id, run_id\)\s+"
            r"where status = 'accepted'",
        )
        self.assertRegex(
            self.sql,
            r"create trigger paper_submit_attempts_immutable\s+"
            r"before update or delete on public\.paper_submit_attempts",
        )
        self.assertNotRegex(self.sql, r"update\s+public\.paper_submit_attempts")

    def test_accept_and_cancel_share_atomic_user_lock_and_full_payload(self):
        functions = {
            name: re.search(
                rf"create or replace function public\.{name}\(.*?\n\$\$;(?:\n|$)",
                self.sql,
                re.S,
            ).group(0)
            for name in ("matha_paper_submit_accept", "matha_paper_submit_cancel")
        }
        lock = "hashtextextended('matha-paper-submit:' || v_user::text, 0)"
        for body in functions.values():
            self.assertIn("pg_advisory_xact_lock", body)
            self.assertIn(lock, body)
            self.assertIn("v_existing.source_id is distinct from p_source_id", body)
            self.assertIn(
                "v_existing.ink_snapshot_sha256 is distinct from p_ink_snapshot_sha256",
                body,
            )
            self.assertIn(
                "v_existing.run_created_app_version is distinct from p_run_created_app_version",
                body,
            )
        cancel = functions["matha_paper_submit_cancel"]
        self.assertIn("'client-canceled-before-accept'", cancel)
        self.assertIn("'superseded-by-accepted-attempt'", cancel)
        self.assertIn("v_winner.attempt_id", cancel)
        self.assertRegex(
            cancel,
            r"where user_id = v_user and run_id = p_run_id and status = 'accepted';\s+"
            r"\s*if found then",
        )
        self.assertRegex(
            cancel,
            r"p_source_id, 'canceled', p_remaining_ms,\s+"
            r"p_ink_snapshot_sha256, p_submitted_at",
        )
        accept = functions["matha_paper_submit_accept"]
        self.assertIn("'superseded-by-accepted-attempt'", accept)
        self.assertIn("'accepted-first-for-run'", accept)
        self.assertIn("winner_attempt_id", accept)
        self.assertIn("v_winner.attempt_id", accept)

    def test_rls_ownership_and_grants_are_fail_closed(self):
        self.assertIn(
            "alter table public.paper_submit_attempts enable row level security;",
            self.sql,
        )
        self.assertIn("auth.uid() = user_id", self.sql)
        self.assertIn("public.is_matha_user(auth.uid())", self.sql)
        self.assertIn(
            "revoke all on table public.paper_submit_attempts from public, anon, authenticated, service_role;",
            self.sql,
        )
        self.assertIn(
            "grant select on table public.paper_submit_attempts to authenticated;",
            self.sql,
        )
        self.assertIn(
            "grant select on table public.paper_submit_attempts to service_role;",
            self.sql,
        )
        self.assertNotRegex(
            self.sql,
            r"grant\s+(?:insert|update|delete|all).*paper_submit_attempts.*authenticated",
        )
        self.assertEqual(len(re.findall(r"to authenticated;", self.sql)), 4)
        self.assertNotRegex(self.sql, r"grant execute .*?service_role")
        self.assertEqual(
            len(re.findall(r"from public, anon, authenticated, service_role;", self.sql)),
            6,
        )

    def test_all_rpc_results_expose_the_exact_audit_fields(self):
        for field in (
            "attempt_id", "run_id", "source_id", "status", "remaining_ms",
            "ink_snapshot_sha256", "submitted_at", "accepted_at", "canceled_at",
            "run_created_app_version", "decision_reason", "winner_attempt_id",
        ):
            self.assertEqual(
                self.sql.count(f"'{field}', v_result.{field}"),
                0,
                "RPCs must use the one authoritative receipt formatter",
            )
            self.assertIn(f"'{field}', (p_result).{field}", self.sql)
        self.assertIn("'winner', case", self.sql)
        self.assertEqual(
            self.sql.count("return public.matha_paper_submit_receipt(v_result, v_winner);"),
            3,
        )


if __name__ == "__main__":
    unittest.main()
