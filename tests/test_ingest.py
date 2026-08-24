"""Regression tests for the textbook ingest map/segmentation rules.

These guard the four ways this pipeline could quietly produce garbage:
answers leaking into a question, a figure question being dropped, a difficulty
being invented without printed evidence, and a printed page number being
silently wrong.
"""

import importlib.util
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / "scripts" / "ingest" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bookmap = _load("build-book-map")

WIDTH, HEIGHT = 1038, 1500


def line(text, x0, y0, x1=None, y1=None, score=0.9):
    return {"bbox": [x0, y0, x1 if x1 is not None else x0 + 400, y1 if y1 is not None else y0 + 26],
            "text": text, "score": score}


def page(pdf_page, ocr, frame_boxes=(), label_boxes=(), non_text=()):
    return {
        "schema": 1, "bookId": "matha-114-line-inequality", "pdfPage": pdf_page,
        "dpi": 150, "width": WIDTH, "height": HEIGHT, "pdfSha256": "0" * 64,
        "imageSha256": "1" * 64, "ocr": list(ocr),
        "layout": {"frameBoxes": [list(b) for b in frame_boxes],
                   "labelBoxes": [list(b) for b in label_boxes],
                   "nonTextRegions": [list(b) for b in non_text],
                   "inkRows": [0] * HEIGHT},
    }


def segment(sample, section="body", difficulty=(None, None)):
    boundary, source = bookmap.answer_boundary_y(sample)
    return bookmap.segment_questions(
        sample, 58, section, boundary, source, "line-inequality",
        "matha-114-line-inequality", difficulty,
    )


class AnswerSeparation(unittest.TestCase):
    def test_solution_below_the_tag_never_enters_the_question(self):
        sample = page(60, [
            line("Ex75. 考慮坐標平面上的直線 L", 82, 126),
            line("(1) 當 k=4 時，直線 L 通過點 A", 148, 213),
            line("解析", 127, 895, 181, 924),
            line("(1)O：當 k=4 時，L:4x+5y-40=0", 206, 928),
            line("- 58 -", 505, 1399, 550, 1420),
        ], label_boxes=[[127, 895, 181, 924]])
        boundary, source = bookmap.answer_boundary_y(sample)
        self.assertEqual(source, "ocr-tag")
        self.assertEqual(boundary, 895)

        records = segment(sample)
        self.assertEqual(len(records), 1)
        stem = records[0]["ocrIndex"]["stem"]
        self.assertIn("Ex75", stem)
        self.assertNotIn("解析", stem)
        self.assertNotIn("4x+5y-40", stem)
        self.assertLess(records[0]["regions"]["stem"][3], boundary)
        self.assertNotIn("region-crosses-answer-boundary", records[0]["flags"])

    def test_answer_text_indented_past_the_margin_still_gets_flagged(self):
        """The boundary cut only sees left-margin tags.  An answer indented to
        the right slips past it, so the stem text is checked a second time."""
        sample = page(61, [
            line("Ex76. 求直線斜率", 82, 126),
            line("答案：m=3", 620, 200),
        ])
        boundary, _ = bookmap.answer_boundary_y(sample)
        self.assertIsNone(boundary, "an indented answer is invisible to the margin cut")
        records = segment(sample)
        self.assertEqual(len(records), 1)
        self.assertIn("answer-text-inside-stem", records[0]["flags"])
        self.assertEqual(records[0]["qaLane"], "needs-repair")
        self.assertEqual(records[0]["status"], "pending-review")

    def test_geometry_only_boundary_is_flagged_not_trusted_silently(self):
        sample = page(62, [line("Ex77. 求直線斜率", 82, 126)], label_boxes=[[127, 800, 181, 830]])
        boundary, source = bookmap.answer_boundary_y(sample)
        self.assertEqual((boundary, source), (800, "label-box-only"))
        records = segment(sample)
        self.assertIn("answer-boundary-geometry-only", records[0]["flags"])


class FigureQuestions(unittest.TestCase):
    def test_figure_inside_the_question_span_is_kept(self):
        sample = page(63, [
            line("Ex6. 如圖，設 m1, m2 分別為直線的斜率", 82, 126),
            line("解析", 127, 900, 181, 928),
        ], non_text=[[150, 200, 500, 700]])
        records = segment(sample)
        self.assertEqual(records[0]["regions"]["figures"], [[150, 200, 500, 700]])
        self.assertNotIn("figure-referenced-but-missing", records[0]["flags"])

    def test_figure_reference_without_candidate_is_flagged_never_dropped(self):
        sample = page(64, [
            line("Ex7. 如圖，求陰影區域的面積", 82, 126),
            line("解析", 127, 900, 181, 928),
        ])
        records = segment(sample)
        self.assertEqual(len(records), 1, "a figure question must survive segmentation")
        self.assertIn("figure-referenced-but-missing", records[0]["flags"])
        self.assertEqual(records[0]["qaLane"], "needs-repair")

    def test_figure_below_the_answer_boundary_is_not_attached_to_the_question(self):
        sample = page(65, [
            line("Ex8. 如圖，求斜率", 82, 126),
            line("解析", 127, 400, 181, 428),
        ], non_text=[[150, 500, 500, 900]])
        records = segment(sample)
        self.assertEqual(records[0]["regions"]["figures"], [])
        self.assertIn("figure-referenced-but-missing", records[0]["flags"])


class DifficultyProvenance(unittest.TestCase):
    def test_no_printed_banner_means_null_not_medium(self):
        sample = page(185, [
            line("4. （ ）下列哪一個聯立不等式無解？", 60, 80),
            line("（A）x+y-4≤0", 150, 120),
        ])
        records = segment(sample, section="chapter-end", difficulty=(None, None))
        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0]["sourceDifficulty"])
        self.assertEqual(records[0]["sourceDifficultyEvidence"], "none")
        self.assertEqual(records[0]["role"], "chapter-end-unclassified")

    def test_printed_banner_is_carried_with_its_evidence(self):
        banner = page(180, [line("綜合練習（困難）", 76, 100)])
        self.assertEqual(bookmap.difficulty_banner(banner)[0], "hard")
        sample = page(186, [line("5. （ ）如圖，聯立不等式", 60, 80)])
        records = segment(sample, section="chapter-end", difficulty=("hard", "綜合練習（困難）"))
        self.assertEqual(records[0]["role"], "chapter-end-hard")
        self.assertEqual(records[0]["sourceDifficulty"], "hard")
        self.assertEqual(records[0]["sourceDifficultyEvidence"], "綜合練習（困難）")

    def test_options_are_separated_from_the_stem(self):
        sample = page(187, [
            line("6. （ ）如圖直線方程式 L1", 60, 80),
            line("（A）x+a1y≥c1", 150, 120),
            line("（B）x+a1y≥c1", 380, 120),
        ], non_text=[[200, 300, 600, 700]])
        records = segment(sample, section="chapter-end")
        self.assertEqual(len(records[0]["regions"]["options"]), 2)
        self.assertNotIn("（A）", records[0]["ocrIndex"]["stem"])
        self.assertEqual(len(records[0]["ocrIndex"]["options"]), 2)


class PrintedPageResolution(unittest.TestCase):
    def test_offset_is_read_from_the_footer_and_conflicts_are_flagged(self):
        pages = [
            page(3, [line("- 1 -", 505, 1399, 550, 1420)]),
            page(4, [line("- 2 -", 505, 1399, 550, 1420)]),
            page(5, []),
            page(6, [line("- 99 -", 505, 1399, 550, 1420)]),
        ]
        resolved = bookmap.resolve_printed_pages(pages)
        self.assertEqual(resolved[3], (1, "ocr"))
        self.assertEqual(resolved[5], (3, "inferred"))
        self.assertEqual(resolved[6], (4, "inferred-after-conflict"))

    def test_page_number_must_be_centred_to_count(self):
        sample = page(7, [line("- 12 -", 60, 1399, 110, 1420)])
        self.assertIsNone(bookmap.read_printed_page(sample))


class PageClassification(unittest.TestCase):
    def test_answer_key_page_beats_other_signals(self):
        sample = page(200, [
            line("2.答案：（1）略；（2）略", 60, 66),
            line("解析：（1）", 60, 100),
        ])
        boundary, _ = bookmap.answer_boundary_y(sample)
        self.assertEqual(bookmap.classify_page(sample, boundary)[0], "answer-key")

    def test_divider_page_is_not_mistaken_for_content(self):
        sample = page(170, [
            line("There is no royal road to Geometry.", 160, 300),
            line("幾何無王者之道。", 350, 460),
            line("- 168 -", 505, 1399, 550, 1420),
        ])
        self.assertEqual(bookmap.classify_page(sample, None)[0], "divider")

    def test_example_page_reports_its_marker(self):
        sample = page(60, [line("Ex75. 考慮坐標平面上的直線 L", 82, 126)])
        section, markers = bookmap.classify_page(sample, None)
        self.assertEqual(section, "body")
        self.assertIn("Ex75", markers)


class RepoSafety(unittest.TestCase):
    def test_output_inside_the_repository_is_refused(self):
        with self.assertRaises(bookmap.MapError):
            bookmap.ensure_outside_repo(REPO_ROOT / "private-content")
        bookmap.ensure_outside_repo(Path(REPO_ROOT.anchor) / "somewhere-else")


if __name__ == "__main__":
    unittest.main()
