import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "audit_public_repo", ROOT / "scripts" / "audit_public_repo.py",
)
audit = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(audit)


class PublicRepoAuditTests(unittest.TestCase):
    def test_current_tracked_tree_contains_no_private_assets_or_secrets(self):
        result = audit.audit_tracked_tree(ROOT)
        self.assertGreater(result["trackedFiles"], 100)
        self.assertEqual(result["privateAssetViolations"], 0)
        self.assertEqual(result["secretViolations"], 0)

    def test_private_question_asset_and_secret_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            asset = root / "assets" / "q1" / "answer.png"
            asset.parent.mkdir(parents=True)
            asset.write_bytes(b"private answer pixels")
            secret = root / "notes.txt"
            secret.write_text(
                "OPENAI_API_KEY='" + "sk-" + "proj-abcdefghijklmnopqrstuvwxyz'", "utf-8",
            )
            with self.assertRaisesRegex(audit.PublicRepoAuditError, "private|OpenAI"):
                audit.audit_paths(root, ["assets/q1/answer.png", "notes.txt"])

    def test_private_schema_is_rejected_even_under_innocent_filename(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "innocent.json"
            path.write_text('{"kind":"private-question-source","questions":[]}', "utf-8")
            with self.assertRaisesRegex(audit.PublicRepoAuditError, "private JSON"):
                audit.audit_paths(root, ["innocent.json"])


if __name__ == "__main__":
    unittest.main()
