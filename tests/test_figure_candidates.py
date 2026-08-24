import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "generate-figure-candidates.py"
SPEC = importlib.util.spec_from_file_location("figure_candidates", SCRIPT)
fc = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = fc
SPEC.loader.exec_module(fc)


class FigureCandidateTests(unittest.TestCase):
    def test_target_number_does_not_use_pdf_page_number(self):
        self.assertEqual(fc.target_number("v-cramer-circle-p31-ex40"), 40)
        self.assertEqual(fc.target_number("v-poly-p138-f6"), 6)
        self.assertEqual(fc.target_number("v-trig-p143-adv-m7"), 7)
        self.assertIsNone(fc.target_number("v-cramer-circle-p119-ex"))

    def test_review_manifest_must_be_pending_and_fail_closed(self):
        base = {
            "kind": "private-figure-review", "schema": 1,
            "privacy": {"localOnly": True, "fullPagesStudentUsable": False},
            "pageReferences": [], "books": [],
            "assetGroups": [{
                "assetId": "fig-test", "bookId": "book-test", "pageIndex": 1,
                "studentUsable": False, "verified": False,
            }],
        }
        fc.validate_review_manifest(base)
        base["assetGroups"][0]["studentUsable"] = True
        with self.assertRaises(fc.CandidateError):
            fc.validate_review_manifest(base)

    def test_repo_output_is_rejected(self):
        with self.assertRaises(fc.CandidateError):
            fc.ensure_outside_repo(fc.REPO_ROOT / "private-crops")
        with tempfile.TemporaryDirectory() as directory:
            fc.ensure_private_temp_output(Path(directory) / "private-crops")
        with self.assertRaises(fc.CandidateError):
            fc.ensure_private_temp_output(Path.home() / "private-crops")

    def test_anchor_prefers_exercise_prefix_and_reports_ambiguity(self):
        tsv = (
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
            "5\t1\t1\t1\t1\t1\t20\t100\t40\t20\t94\tEx40\n"
            "5\t1\t2\t1\t1\t1\t300\t500\t20\t20\t95\t40\n"
        )
        tokens = fc.parse_tesseract_tsv(tsv, 1000, 1400)
        anchor, ambiguous = fc.locate_anchor(tokens, 40)
        self.assertEqual(anchor.token, "Ex40")
        self.assertFalse(ambiguous)

    def test_tesseract_common_windows_install_is_resolved(self):
        resolved = fc.resolve_tesseract("tesseract")
        if Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe").is_file():
            self.assertEqual(Path(resolved), Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"))

    def test_only_unique_strong_boxed_anchor_is_low_ambiguity(self):
        strong = fc.Anchor(0.1, 0.05, 1.5, "Ex40", True)
        weak = fc.Anchor(0.1, 0.05, 0.8, "40", False)
        self.assertFalse(fc.ambiguity_status(strong, False, 1, "enclosing-question-box"))
        self.assertTrue(fc.ambiguity_status(weak, False, 1, "enclosing-question-box"))
        self.assertTrue(fc.ambiguity_status(strong, False, 2, "enclosing-question-box"))
        self.assertTrue(fc.ambiguity_status(strong, False, 1, "anchor-limited-band"))

    def test_geometry_detector_never_proposes_full_page(self):
        image = np.full((1000, 700), 255, np.uint8)
        cv2.rectangle(image, (420, 120), (620, 360), 0, 3)
        cv2.line(image, (430, 340), (600, 150), 0, 3)
        cv2.line(image, (520, 130), (520, 350), 0, 2)
        proposals = fc.proposal_boxes(image, (0.08, 0.45, "unit-test-band"))
        self.assertTrue(proposals)
        for proposal in proposals:
            x1, y1, x2, y2 = proposal.box
            self.assertLess((x2 - x1) * (y2 - y1), image.size * 0.25)

    def test_candidate_contract_cannot_claim_verified_or_student_usable(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn('"studentUsable": True', source)
        self.assertNotIn('"verified": True', source)
        self.assertIn('"studentUsable": False', source)
        self.assertIn('"verified": False', source)


if __name__ == "__main__":
    unittest.main()
