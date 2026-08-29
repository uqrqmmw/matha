import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "audit_local_full_paper_sources",
    ROOT / "scripts" / "audit-local-full-paper-sources.py",
)
audit = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(audit)


class LocalFullPaperAuditTests(unittest.TestCase):
    def test_content_requires_math_exam_and_structure_for_probable_paper(self):
        result = audit.classify(
            Path("opaque.pdf"), 8,
            "115學年度學科能力測驗 數學 A 考試時間 100 分鐘 單選題 多選題 選填題 混合題",
        )
        self.assertEqual(result["category"], "probable-full-paper")

    def test_image_only_plausible_pdf_is_not_silently_discarded(self):
        result = audit.classify(Path("opaque.pdf"), 8, "")
        self.assertEqual(result["category"], "image-only-manual-review")

    def test_unrelated_receipt_is_not_promoted(self):
        result = audit.classify(Path("報帳/receipt.pdf"), 8, "")
        self.assertEqual(result["category"], "not-candidate")

    def test_long_textbook_is_not_a_complete_paper_from_name_alone(self):
        result = audit.classify(Path("數學滿級分課本.pdf"), 300, "")
        self.assertEqual(result["category"], "not-candidate")


if __name__ == "__main__":
    unittest.main()
