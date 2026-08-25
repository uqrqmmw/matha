import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "merge_ocr", ROOT / "scripts" / "ingest" / "merge-ocr-candidates.py"
)
merge = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(merge)


def row(question_id, answer="a1", flags=None):
    return {"id": question_id, "pdfPage": 1, "questionType": "single", "role": "chapter-end-easy",
            "sourceDifficulty": "easy", "flags": flags or [], "qaLane": "clean-candidate",
            "ocrIndex": {"stem": question_id}, "answerRef": {"id": answer}}


def pack(rows):
    return {"schema": 11, "bookId": "book", "pdfSha256": "a" * 64, "questions": rows,
            "drillAnswers": [{"id": "a1", "pdfPage": 2}], "missingDrillNumbers": [],
            "unattachedPageTops": []}


class MergeOcrCandidateTests(unittest.TestCase):
    def test_union_keeps_single_detector_questions_but_blocks_them(self):
        result = merge.merge_questions(pack([row("both"), row("local")]), pack([row("both"), row("google")]))
        by_id = {item["id"]: item for item in result["questions"]}
        self.assertEqual(set(by_id), {"both", "local", "google"})
        self.assertEqual(by_id["both"]["qaLane"], "clean-candidate")
        self.assertEqual(by_id["local"]["qaLane"], "needs-repair")
        self.assertIn("single-ocr-detection", by_id["google"]["flags"])

    def test_disagreement_is_explicit_and_fail_closed(self):
        local = row("q")
        google = row("q")
        google["questionType"] = "fill"
        result = merge.merge_questions(pack([local]), pack([google]))
        question = result["questions"][0]
        self.assertIn("ocr-questionType-disagreement", question["flags"])
        self.assertEqual(question["qaLane"], "needs-repair")


if __name__ == "__main__":
    unittest.main()
