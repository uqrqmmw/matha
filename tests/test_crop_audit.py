import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


REPO_ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "audit_review_crops", REPO_ROOT / "scripts" / "ingest" / "audit-review-crops.py"
)
audit_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = audit_module
spec.loader.exec_module(audit_module)


class CropAuditTests(unittest.TestCase):
    def make_book(self, root: Path, ids=("q1",)) -> Path:
        book = root / "book"
        crops = book / "crops.hybrid"
        crops.mkdir(parents=True)
        questions = [{"id": question_id} for question_id in ids]
        (book / "questions.pending-review.hybrid.json").write_text(
            json.dumps({"pdfSha256": "a" * 64, "questions": questions}), encoding="utf-8"
        )
        manifest = {"pdfSha256": "a" * 64, "crops": {}}
        for order, question_id in enumerate(ids):
            folder = crops / question_id
            folder.mkdir()
            Image.new("RGB", (100 + order, 60), (240 - order, 240, 240)).save(folder / "stem.png")
            Image.new("RGB", (80 + order, 50), (255, 250 - order, 250)).save(folder / "answer.png")
            manifest["crops"][question_id] = {
                "stemRegion": [0, 0, 100, 60], "figures": 0, "answer": True
            }
        (book / "crops-manifest.hybrid.json").write_text(json.dumps(manifest), encoding="utf-8")
        return book

    def test_complete_crop_set_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = audit_module.audit(self.make_book(Path(tmp)), "hybrid")
        self.assertTrue(result["passed"])
        self.assertEqual(result["stemFiles"], 1)
        self.assertEqual(result["answerFiles"], 1)
        self.assertFalse(result["mathematicalCorrectnessVerified"])

    def test_stale_crop_directory_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = self.make_book(Path(tmp))
            (book / "crops.hybrid" / "stale").mkdir()
            result = audit_module.audit(book, "hybrid")
        self.assertFalse(result["passed"])
        self.assertIn("stale", str(result["errors"]))

    def test_duplicate_stem_pixels_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = self.make_book(Path(tmp), ("q1", "q2"))
            (book / "crops.hybrid" / "q2" / "stem.png").write_bytes(
                (book / "crops.hybrid" / "q1" / "stem.png").read_bytes()
            )
            result = audit_module.audit(book, "hybrid")
        self.assertFalse(result["passed"])
        self.assertEqual(result["duplicateStemGroups"], 1)

    def test_duplicate_answer_pixels_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = self.make_book(Path(tmp), ("q1", "q2"))
            (book / "crops.hybrid" / "q2" / "answer.png").write_bytes(
                (book / "crops.hybrid" / "q1" / "answer.png").read_bytes()
            )
            result = audit_module.audit(book, "hybrid")
        self.assertFalse(result["passed"])
        self.assertEqual(result["duplicateAnswerGroups"], 1)


if __name__ == "__main__":
    unittest.main()
