import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/202608300009_bind_paper_source_registry.sql"
SCHEMA = ROOT / "supabase/schema.sql"

def text(path): return path.read_text(encoding="utf-8").replace("\r\n","\n").strip()

class PaperSourceRegistrySchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql=text(MIGRATION); schema=text(SCHEMA)
        start_marker="-- BEGIN SERVER-OWNED PAPER SOURCE CONTRACT 202608300009"
        end_marker="-- END SERVER-OWNED PAPER SOURCE CONTRACT 202608300009"
        start=schema.index(start_marker)
        end=schema.index(end_marker,start)+len(end_marker)
        cls.schema_block=schema[start:end]

    def test_migration_is_mirrored_exactly(self): self.assertEqual(self.schema_block,self.sql)
    def test_registry_is_private_and_exact(self):
        self.assertIn("revoke all on table public.paper_source_registry",self.sql)
        self.assertIn("('paper-mock-1',6,2,'0830b',true)",self.sql)
        self.assertIn("('paper-mock-2',6,2,'0830b',false)",self.sql)
        self.assertIn("('paper-mock-3',4,2,'0830b',true)",self.sql)
    def test_new_rpc_has_no_client_aggregate(self):
        signature=self.sql[self.sql.index("create or replace function public.matha_paper_submit_accept("):]
        signature=signature[:signature.index(") returns jsonb")]
        self.assertNotIn("p_ink_snapshot_sha256",signature)
        self.assertIn("p_run_created_at bigint",signature)
        self.assertIn("p_paper_layout_version integer",signature)
    def test_db_computes_full_app_aggregate_and_fail_fast(self):
        for token in ("'submittedAt',p_submitted_at","'revisions'","'persistedRevision'",
                      "'cloudSha256'","legacy accepted paper attempts require explicit contract migration"):
            self.assertIn(token,self.sql)
        self.assertIn("p_submitted_at > floor(extract(epoch from clock_timestamp())*1000)",self.sql)
        self.assertIn("p_run_created_app_version is distinct from v_source.required_app_version",self.sql)
        self.assertIn("matha_paper_submit_lookup_run",self.sql)

if __name__ == "__main__": unittest.main()
