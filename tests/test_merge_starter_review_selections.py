import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "merge_starter_review_selections",
    ROOT / "scripts" / "ingest" / "merge-starter-review-selections.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def selection(question_id: str) -> dict:
    return {
        "kind": MODULE.KIND,
        "releaseAuthority": False,
        "studentReady": False,
        "items": [{"id": question_id, "topic": "測試"}],
    }


class MergeStarterReviewSelectionsTests(unittest.TestCase):
    def test_merges_disjoint_inputs_and_binds_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first, second, output = root / "a.json", root / "b.json", root / "out.json"
            first.write_text(json.dumps(selection("q2")), encoding="utf-8")
            second.write_text(json.dumps(selection("q1")), encoding="utf-8")
            result = MODULE.merge([first, second], output)
            document = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["selected"], 2)
            self.assertEqual([row["id"] for row in document["items"]], ["q1", "q2"])
            self.assertEqual(len(document["mergedFrom"]), 2)
            self.assertFalse(document["releaseAuthority"])

    def test_rejects_duplicate_question_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first, second = root / "a.json", root / "b.json"
            first.write_text(json.dumps(selection("same")), encoding="utf-8")
            second.write_text(json.dumps(selection("same")), encoding="utf-8")
            with self.assertRaisesRegex(MODULE.MergeSelectionError, "multiple selections"):
                MODULE.merge([first, second], root / "out.json")


if __name__ == "__main__":
    unittest.main()
