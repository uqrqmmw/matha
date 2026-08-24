"""Regression tests for the textbook ingest map/segmentation rules.

These guard the ways this pipeline could quietly produce garbage: a question
being swallowed by the previous question's solution, answers leaking into a
stem, a figure question being dropped, a difficulty being invented without
printed evidence, and a printed page number being silently wrong.
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
crops = _load("render-review-crops")

WIDTH, HEIGHT = 1038, 1500


def line(text, x0, y0, x1=None, y1=None, score=0.9):
    return {"bbox": [x0, y0, x1 if x1 is not None else x0 + 400, y1 if y1 is not None else y0 + 26],
            "text": text, "score": score}


def page(pdf_page, ocr, frame_boxes=(), label_boxes=(), non_text=(), banner_ocr=()):
    return {
        "schema": 2, "bookId": "matha-114-line-inequality", "pdfPage": pdf_page,
        "dpi": 150, "width": WIDTH, "height": HEIGHT, "pdfSha256": "0" * 64,
        "imageSha256": "1" * 64, "ocr": list(ocr), "bannerOcr": list(banner_ocr),
        "layout": {"frameBoxes": [list(b) for b in frame_boxes],
                   "labelBoxes": [list(b) for b in label_boxes],
                   "nonTextRegions": [list(b) for b in non_text],
                   "inkRows": [0] * HEIGHT},
    }


def context(section="body", tier=None, tier_evidence=None, type_headers=(), printed=58,
            chapter="斜率與直線方程式", block_index=0):
    return {"slug": "line-inequality", "bookId": "matha-114-line-inequality",
            "printedPage": printed, "chapter": chapter, "section": section,
            "tier": tier, "tierEvidence": tier_evidence, "typeHeaders": list(type_headers),
            "blockIndex": block_index}


def segment(sample, in_drill=False, **kwargs):
    events = bookmap.page_events(sample, in_drill)
    return bookmap.segment_questions(sample, events, context(**kwargs))


class AnswerSeparation(unittest.TestCase):
    def test_solution_below_the_tag_never_enters_the_question(self):
        sample = page(60, [
            line("Ex75. 考慮坐標平面上的直線 L", 82, 126),
            line("(1) 當 k=4 時，直線 L 通過點 A", 148, 213),
            line("解析", 127, 895, 181, 924),
            line("(1)O：當 k=4 時，L:4x+5y-40=0", 206, 928),
            line("- 58 -", 505, 1399, 550, 1420),
        ], label_boxes=[[127, 895, 181, 924]])
        records, lead_in = segment(sample)
        self.assertFalse(lead_in)
        self.assertEqual(len(records), 1)
        stem = records[0]["ocrIndex"]["stem"]
        self.assertIn("Ex75", stem)
        self.assertNotIn("解析", stem)
        self.assertNotIn("4x+5y-40", stem)
        self.assertEqual(records[0]["regions"]["answerBoundaryY"], 895)
        self.assertLess(records[0]["regions"]["stem"][3], 895)
        self.assertNotIn("region-crosses-answer-boundary", records[0]["flags"])

    def test_a_question_below_a_solution_is_still_extracted(self):
        """The first answer tag is not a page-wide cut.

        A page routinely finishes the previous question's 解析 at the top and
        starts a new example halfway down.  Cutting the whole page at the first
        tag deleted two thirds of this book's questions.
        """
        sample = page(61, [
            line("解析：由上式可得 m=2", 127, 100),
            line("⇒ L:2x-y+1=0", 206, 140),
            line("Ex76. 求通過 A(1,2) 的直線方程式", 82, 600),
            line("解答", 127, 900, 181, 928),
            line("2x-y=0", 206, 935),
            line("Ex77. 求兩直線的交點", 82, 1100),
        ])
        records, lead_in = segment(sample)
        self.assertTrue(lead_in, "the page opens inside the previous solution")
        self.assertEqual([r["id"] for r in records],
                         ["line-inequality-p058-ex76", "line-inequality-p058-ex77"])
        self.assertEqual(records[0]["regions"]["answerBoundaryY"], 900)
        self.assertNotIn("2x-y=0", records[0]["ocrIndex"]["stem"])
        self.assertNotIn("m=2", records[0]["ocrIndex"]["stem"])
        self.assertIsNone(records[1]["regions"]["answerBoundaryY"])
        self.assertIn("solution-not-on-this-page", records[1]["flags"])

    def test_answer_text_indented_past_the_margin_still_gets_flagged(self):
        """The tag scan only sees the left margin.  An answer indented to the
        right slips past it, so the stem text is checked a second time."""
        sample = page(62, [
            line("Ex78. 求直線斜率", 82, 126),
            line("答案：m=3", 620, 200),
        ])
        records, _ = segment(sample)
        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0]["regions"]["answerBoundaryY"])
        self.assertIn("answer-text-inside-stem", records[0]["flags"])
        self.assertEqual(records[0]["qaLane"], "needs-repair")
        self.assertEqual(records[0]["status"], "pending-review")

    def test_solution_continuing_on_the_next_page_is_not_a_repair_item(self):
        pages = [
            {"pdfPage": 60, "leadInSolution": False},
            {"pdfPage": 61, "leadInSolution": True},
        ]
        questions = [{
            "pdfPage": 60, "flags": ["solution-not-on-this-page"], "qaLane": "needs-repair",
        }]
        bookmap.link_cross_page_solutions(pages, questions)
        self.assertEqual(questions[0]["flags"], ["solution-continues-next-page"])
        self.assertEqual(questions[0]["qaLane"], "clean-candidate")
        self.assertEqual(questions[0]["solutionPdfPage"], 61)


class FigureQuestions(unittest.TestCase):
    def test_figure_inside_the_question_span_is_kept(self):
        sample = page(63, [
            line("Ex6. 如圖，設 m1, m2 分別為直線的斜率", 82, 126),
            line("解析", 127, 900, 181, 928),
        ], non_text=[[150, 200, 500, 700]])
        records, _ = segment(sample)
        self.assertEqual(records[0]["regions"]["figures"], [[150, 200, 500, 700]])
        self.assertNotIn("figure-referenced-but-missing", records[0]["flags"])

    def test_figure_reference_without_candidate_is_flagged_never_dropped(self):
        sample = page(64, [
            line("Ex7. 如圖，求陰影區域的面積", 82, 126),
            line("解析", 127, 900, 181, 928),
        ])
        records, _ = segment(sample)
        self.assertEqual(len(records), 1, "a figure question must survive segmentation")
        self.assertIn("figure-referenced-but-missing", records[0]["flags"])
        self.assertEqual(records[0]["qaLane"], "needs-repair")

    def test_figure_below_the_answer_boundary_belongs_to_the_solution(self):
        sample = page(65, [
            line("Ex8. 如圖，求斜率", 82, 126),
            line("解析", 127, 400, 181, 428),
        ], non_text=[[150, 500, 500, 900]])
        records, _ = segment(sample)
        self.assertEqual(records[0]["regions"]["figures"], [])
        self.assertIn("figure-referenced-but-missing", records[0]["flags"])

    def test_figure_candidates_record_unknown_handwriting_safety(self):
        sample = page(66, [line("Ex9. 如圖", 82, 126), line("解析", 127, 900, 181, 928)],
                      non_text=[[150, 200, 500, 700]])
        records, _ = segment(sample)
        figures = bookmap.build_figure_candidates([sample], records, "matha-114-line-inequality")
        self.assertEqual(len(figures), 1)
        self.assertEqual(figures[0]["handwritingSafety"], "unknown")
        self.assertFalse(figures[0]["verified"])
        self.assertFalse(figures[0]["studentUsable"])
        self.assertTrue(figures[0]["aboveAnswerBoundary"])


class DifficultyProvenance(unittest.TestCase):
    def test_tier_is_read_from_the_printed_grey_banner(self):
        for text, expected in [("基實力成", "easy"), ("進試题演鍊", "medium"), ("解题思维挑", "hard")]:
            sample = page(69, [], banner_ocr=[line(text, 60, 70, 300, 100)])
            tier, evidence = bookmap.read_tier_banner(sample)
            self.assertEqual(tier, expected, text)
            self.assertIn(text, evidence)

    def test_no_printed_banner_means_null_not_medium(self):
        sample = page(185, [
            line("4. （ ）下列哪一個聯立不等式無解？", 60, 80),
            line("（A）x+y-4≤0", 150, 120),
        ])
        records, _ = segment(sample, in_drill=True, section="drill")
        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0]["sourceDifficulty"])
        self.assertEqual(records[0]["sourceDifficultyEvidence"], "none")
        self.assertEqual(records[0]["role"], "chapter-end-unclassified")
        self.assertIn("tier-unknown", records[0]["flags"])

    def test_printed_banner_is_carried_with_its_evidence(self):
        headers = [(40, "multi", "二、多重選擇題")]
        sample = page(186, [line("5. （ ）如圖，聯立不等式", 60, 80),
                            line("（A）a", 150, 300), line("（B）b", 300, 300)],
                      non_text=[[200, 120, 600, 280]])
        records, _ = segment(sample, in_drill=True, section="drill", tier="hard",
                             tier_evidence="解題思維挑戰（OCR：解题思维挑）", type_headers=headers)
        self.assertEqual(records[0]["role"], "chapter-end-hard")
        self.assertEqual(records[0]["sourceDifficulty"], "hard")
        self.assertIn("解題思維挑戰", records[0]["sourceDifficultyEvidence"])
        self.assertEqual(records[0]["questionType"], "multi")
        self.assertEqual(records[0]["questionTypeEvidence"], "二、多重選擇題")

    def test_question_type_headers_survive_ocr_garble(self):
        sample = page(69, [
            line("一、罩一遥挥题", 58, 156, 250, 185),
            line("三、填充题", 56, 556, 200, 580),
            line("四、计算题", 66, 900, 200, 924),
            line("五、题组", 66, 1100, 200, 1124),
        ])
        found = [(name, printed) for _, name, printed in bookmap.read_type_headers(sample)]
        self.assertEqual([name for name, _ in found], ["single", "fill", "calculation", "group"])

    def test_options_are_separated_from_the_stem(self):
        sample = page(187, [
            line("6. （ ）如圖直線方程式 L1", 60, 80),
            line("（A）x+a1y≥c1", 150, 300),
            line("（B）x+a1y≥c1", 380, 300),
        ], non_text=[[200, 120, 600, 280]])
        records, _ = segment(sample, in_drill=True, section="drill")
        self.assertEqual(len(records[0]["regions"]["options"]), 2)
        self.assertNotIn("（A）", records[0]["ocrIndex"]["stem"])
        self.assertEqual(len(records[0]["ocrIndex"]["options"]), 2)


class DrillAnswerPairing(unittest.TestCase):
    def test_answers_are_paired_by_block_sequence_not_chapter_text(self):
        questions = [{
            "blockIndex": 1, "sourceDifficulty": "easy", "questionType": "single",
            "provenance": {"drillNumber": 1}, "flags": ["solution-not-on-this-page"],
            "qaLane": "needs-repair",
        }]
        answers = [{
            "id": "line-inequality-p076-ans1", "blockIndex": 2,
            "sourceDifficulty": "easy", "questionType": "single", "drillNumber": 1,
            "pdfPage": 78, "printedPage": 76, "region": [50, 180, 900, 460],
        }]
        bookmap.pair_drill_answers(questions, answers)
        self.assertEqual(questions[0]["answerRef"]["id"], "line-inequality-p076-ans1")
        self.assertNotIn("solution-not-on-this-page", questions[0]["flags"])
        self.assertEqual(questions[0]["qaLane"], "clean-candidate")

    def test_a_drill_question_with_no_answer_is_flagged(self):
        questions = [{
            "blockIndex": 1, "sourceDifficulty": "easy", "questionType": "single",
            "provenance": {"drillNumber": 9}, "flags": [], "qaLane": "clean-candidate",
        }]
        bookmap.pair_drill_answers(questions, [])
        self.assertIn("drill-answer-not-found", questions[0]["flags"])
        self.assertEqual(questions[0]["qaLane"], "needs-repair")


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
        sample = page(78, [
            line("1.答案：（D）", 55, 180),
            line("解析：由題圖可以看出 L1 的斜率為正", 55, 215),
            line("2.答案：（A）", 55, 540),
        ])
        events = bookmap.page_events(sample, True)
        self.assertEqual(bookmap.classify_page(sample, events, True), "drill-answers")

    def test_divider_page_is_not_mistaken_for_content(self):
        sample = page(170, [
            line("There is no royal road to Geometry.", 160, 300),
            line("幾何無王者之道。", 350, 460),
            line("- 168 -", 505, 1399, 550, 1420),
        ])
        self.assertEqual(bookmap.classify_page(sample, [], False), "divider")

    def test_numbered_items_outside_a_drill_block_are_not_questions(self):
        """Solution steps are numbered too; only a drill block makes them
        questions, otherwise every 解析 line would become a fake question."""
        sample = page(33, [line("5. 綜合上述，知 ABCD 為正方形", 60, 1332)])
        self.assertEqual(bookmap.page_events(sample, False), [])
        self.assertEqual(len(bookmap.page_events(sample, True)), 1)


class CropSeparation(unittest.TestCase):
    """The crop is what a student would see, so the cut is asserted, not assumed."""

    @staticmethod
    def question(stem, options=(), figures=(), boundary=None):
        return {"regions": {"stem": stem, "options": list(options), "figures": list(figures),
                            "answerBoundaryY": boundary, "inlineAnswer": None}}

    def test_crop_stops_short_of_the_answer_boundary(self):
        question = self.question([80, 120, 900, 400], figures=[[150, 420, 500, 880]], boundary=895)
        region, refusal = crops.question_region(question, WIDTH, HEIGHT)
        self.assertIsNone(refusal)
        self.assertLess(region[3], 895)
        self.assertEqual(region[0], 0)
        self.assertEqual(region[2], WIDTH)

    def test_a_region_starting_below_the_boundary_is_refused_not_clipped(self):
        question = self.question([80, 950, 900, 1200], boundary=895)
        region, refusal = crops.question_region(question, WIDTH, HEIGHT)
        self.assertIsNone(region)
        self.assertEqual(refusal, "crop-refused-crosses-answer-boundary")

    def test_a_question_with_no_regions_is_refused(self):
        region, refusal = crops.question_region(self.question(None), WIDTH, HEIGHT)
        self.assertIsNone(region)
        self.assertEqual(refusal, "empty-region")

    def test_no_boundary_means_the_whole_span_is_croppable(self):
        question = self.question([80, 120, 900, 400])
        region, refusal = crops.question_region(question, WIDTH, HEIGHT)
        self.assertIsNone(refusal)
        self.assertGreaterEqual(region[3], 400)

    def test_crop_output_inside_the_repository_is_refused(self):
        with self.assertRaises(crops.CropError):
            crops.ensure_outside_repo(REPO_ROOT / "crops")


class RepoSafety(unittest.TestCase):
    def test_output_inside_the_repository_is_refused(self):
        with self.assertRaises(bookmap.MapError):
            bookmap.ensure_outside_repo(REPO_ROOT / "private-content")
        bookmap.ensure_outside_repo(Path(REPO_ROOT.anchor) / "somewhere-else")


if __name__ == "__main__":
    unittest.main()
