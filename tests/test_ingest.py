"""Regression tests for the textbook ingest map/segmentation rules.

These guard the ways this pipeline could quietly produce garbage: a question
being swallowed by the previous question's solution, answers leaking into a
stem, a figure question being dropped, a difficulty being invented without
printed evidence, and a printed page number being silently wrong.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / "scripts" / "ingest" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    # @dataclass resolves annotations through sys.modules, so register first.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


bookmap = _load("build-book-map")
crops = _load("render-review-crops")
indexer = _load("index-pages")
status = _load("ingest-status")
review = _load("apply-review")

WIDTH, HEIGHT = 1038, 1500


def line(text, x0, y0, x1=None, y1=None, score=0.9, background=255):
    return {"bbox": [x0, y0, x1 if x1 is not None else x0 + 400, y1 if y1 is not None else y0 + 26],
            "text": text, "score": score, "backgroundLevel": background}


def page(pdf_page, ocr, frame_boxes=(), label_boxes=(), non_text=(), banner_ocr=()):
    return {
        "schema": 6, "bookId": "matha-114-line-inequality", "pdfPage": pdf_page,
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
            "blockIndex": block_index, "carriedType": ("unclassified", "none")}


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

    def test_a_split_ocr_row_does_not_leak_into_the_previous_question(self):
        """OCR splits one printed line into boxes whose tops differ slightly,
        and the marker is not always the highest: on p69 the tail of
        "3.（ ）點P…" sat 3 px above its own "3.（"."""
        sample = page(69, [
            line("2. （ ）已知 ABCDEFG 為正七邊形", 58, 729, 780, 754),
            line("（A）EF", 152, 977, 232, 1005),
            line(")點P（3，4）到直線L：12x-5y+10=0的距離", 132, 1171, 620, 1199),
            line("3. （", 59, 1174, 120, 1198),
        ])
        records, _ = segment(sample, in_drill=True, section="drill")
        self.assertEqual([r["id"] for r in records],
                         ["line-inequality-p058-q2", "line-inequality-p058-q3"])
        self.assertNotIn("點P", records[0]["ocrIndex"]["stem"])
        self.assertLess(records[0]["regions"]["stem"][3], 1171)

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


class RuledAnswerTags(unittest.TestCase):
    """OCR loses the word inside a 解答 box often enough that the box itself
    has to count — but only when it really is a box."""

    def test_a_ruled_tag_ocr_missed_still_cuts_the_question(self):
        sample = page(60, [
            line("Ex75. 考慮坐標平面上的直線 L", 82, 126),
            line("(1)(3)(5)", 207, 865, 289, 892),
            line("解析", 127, 895, 181, 924),
        ], label_boxes=[[127, 863, 190, 893], [127, 895, 190, 925]])
        records, _ = segment(sample)
        self.assertEqual(records[0]["regions"]["answerBoundaryY"], 863)
        self.assertEqual(records[0]["regions"]["answerBoundarySource"], "ruled-label-box")
        self.assertNotIn("(1)(3)(5)", records[0]["ocrIndex"]["stem"])
        region, refusal = crops.question_region(records[0], WIDTH, HEIGHT)
        self.assertIsNone(refusal)
        self.assertLess(region[3], 863)

    def test_a_box_near_an_ocr_tag_is_not_counted_twice(self):
        sample = page(61, [
            line("Ex76. 求斜率", 82, 126),
            line("解析", 127, 895, 181, 924),
        ], label_boxes=[[127, 893, 190, 925]])
        events = bookmap.page_events(sample, False)
        tags = [event for event in events if event["kind"] == "answer-tag"]
        self.assertEqual(len(tags), 1)

    def test_only_a_four_sided_box_counts_as_a_ruled_tag(self):
        import numpy as np
        ink = np.zeros((120, 240), np.uint8)
        ink[20:50, 30:100] = 0
        for y in (20, 49):
            ink[y, 30:100] = 255
        for x in (30, 99):
            ink[20:50, x] = 255
        ink[80, 30:100] = 255  # a bare fraction bar
        self.assertTrue(indexer.is_closed_box(ink, [30, 20, 100, 50]))
        self.assertFalse(indexer.is_closed_box(ink, [30, 66, 100, 96]))


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

    def test_axis_labels_are_pulled_back_into_the_figure(self):
        """Axis names are OCR text, so the raw ink region clips the arrows off."""
        sample = page(67, [
            line("1. （ ）如圖所示，試選出正確配置", 60, 80),
            line("y", 440, 140, 452, 160),
            line("x", 575, 260, 588, 280),
            line("O", 455, 285, 470, 305),
            line("（A）L1: x+5y-7=0", 290, 430, 700, 458),
        ], non_text=[[330, 165, 560, 400]])
        records, _ = segment(sample, in_drill=True, section="drill")
        figure = records[0]["regions"]["figures"][0]
        self.assertLessEqual(figure[1], 140, "the y label must be inside the crop")
        self.assertGreaterEqual(figure[2], 588, "the x axis arrow must be inside the crop")
        self.assertLess(figure[3], 430, "the option row must stay out of the figure")

    def test_a_figure_bleeding_past_the_boundary_is_clipped_not_dropped(self):
        """Ex4 on printed page 124 lost its diagram because the ink ran 15 px
        under the 解答 tag.  Dropping it made a figure question figureless."""
        sample = page(126, [
            line("Ex4. 已知兩直線的斜角分別為 α 與 β，如圖所示，求", 85, 501),
            line("(2)45°，135°", 425, 673, 551, 704),
            line("解答", 120, 676, 173, 702),
        ], label_boxes=[[110, 673, 180, 705]], non_text=[[647, 494, 840, 688]])
        records, _ = segment(sample)
        figures = records[0]["regions"]["figures"]
        self.assertEqual(len(figures), 1)
        self.assertLessEqual(figures[0][3], 673)
        self.assertIn("figure-clipped-at-answer-boundary", records[0]["flags"])
        self.assertNotIn("figure-referenced-but-missing", records[0]["flags"])

    def test_draw_the_graph_questions_are_not_reported_as_missing_figures(self):
        """圖示…的解 asks the student to produce the figure; the answer region
        holds it, so having no figure in the stem is correct."""
        sample = page(150, [
            line("Ex2. 圖示二元一次不等式 3x+2y<6 的解", 82, 126),
            line("解析", 127, 900, 181, 928),
        ])
        records, _ = segment(sample)
        self.assertIn("answer-is-a-drawing", records[0]["flags"])
        self.assertNotIn("figure-referenced-but-missing", records[0]["flags"])

    def test_the_words_the_graph_alone_are_not_a_figure_reference(self):
        sample = page(184, [
            line("1. 若點 P（k+1，2k-1）在聯立不等式的圖形內，則 k 之最大可能值為", 60, 80),
        ])
        records, _ = segment(sample, in_drill=True, section="drill", tier="easy",
                             tier_evidence="基礎實力養成")
        self.assertNotIn("figure-referenced-but-missing", records[0]["flags"])

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
            sample = page(69, [], banner_ocr=[line(text, 60, 70, 300, 100, background=225)])
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

    def test_a_sparse_page_after_a_drill_banner_is_not_a_drill_page(self):
        """The back cover falls inside the last drill block's tier state."""
        cover = page(206, [line("VICTOR+", 430, 1160), line("得勝者文教", 450, 1210),
                           line("02-2314-5818", 440, 1300), line("台北市中山南路二巷5號", 380, 1345)])
        self.assertEqual(bookmap.classify_page(cover, [], True), "divider")

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


class ChapterTitles(unittest.TestCase):
    def test_a_chapter_title_opens_its_page(self):
        opener = page(3, [
            line("斜率與直線方程式", 346, 139, 690, 176),
            line("斜率的概念", 76, 191, 206, 221),
        ])
        self.assertEqual(bookmap.collect_headings(opener)[0], "斜率與直線方程式")

    def test_a_centred_formula_mid_page_is_not_a_chapter_title(self):
        """Display formulas in a 解析 are large and centred too; treating them
        as titles renamed the chapter to a fragment of algebra."""
        middle = page(43, [
            line("由上式整理可得下列結果", 76, 90),
            line("創直線會通過點司要保持可表示", 330, 600, 700, 640),
        ])
        self.assertIsNone(bookmap.collect_headings(middle)[0])

    def test_a_title_with_digits_or_operators_is_rejected(self):
        sample = page(44, [line("2x+3y-4=0 的圖形", 330, 100, 700, 140)])
        self.assertIsNone(bookmap.collect_headings(sample)[0])


class TierBannerGeometry(unittest.TestCase):
    def test_grey_ink_lower_down_the_page_is_not_a_banner(self):
        """Body pages carry grey-highlighted boxes; accepting any grey ink in
        the top strip opened phantom drill blocks in mid-chapter."""
        body = page(10, [], banner_ocr=[line("Enlightenment example", 75, 234, 327, 264, background=225)])
        self.assertFalse(bookmap.has_banner_box(body))

    def test_a_grey_backed_tag_in_the_top_left_corner_counts_as_a_banner(self):
        drill = page(69, [], banner_ocr=[line("基實力成", 67, 70, 300, 103, background=225)])
        self.assertTrue(bookmap.has_banner_box(drill))

    def test_plain_text_at_the_top_left_is_not_a_banner(self):
        """A 解析 tag high on a continuation page sits in the same corner but
        on white paper; without the grey test it opened a phantom block."""
        continuation = page(70, [], banner_ocr=[line("解析", 127, 80, 181, 110, background=255)])
        self.assertFalse(bookmap.has_banner_box(continuation))

    def test_a_banner_whose_text_is_unreadable_leaves_the_tier_unknown(self):
        unreadable = page(91, [], banner_ocr=[line("|||", 60, 72, 250, 104, background=225)])
        self.assertTrue(bookmap.has_banner_box(unreadable))
        self.assertEqual(bookmap.read_tier_banner(unreadable), (None, None))

    def test_the_medium_banner_survives_losing_its_first_character(self):
        """p91 of the polynomial book OCRs as 試题演 — requiring 進 made the
        block inherit the previous block's easy tier."""
        sample = page(91, [], banner_ocr=[line("試题演", 63, 76, 256, 106, background=225)])
        self.assertEqual(bookmap.read_tier_banner(sample)[0], "medium")


class StatusRollup(unittest.TestCase):
    """The roll-up is what says whether anything escaped review."""

    def _book(self, tmp, rows):
        import json
        book = Path(tmp) / "matha-114-line-inequality"
        book.mkdir()
        (book / "section-map.json").write_text(json.dumps({
            "bookId": "matha-114-line-inequality", "pdfFileName": "x.pdf",
            "pdfSha256": "a" * 64, "pageCount": 206, "indexedPages": 206,
        }), encoding="utf-8")
        (book / "questions.pending-review.json").write_text(json.dumps({
            "questions": rows, "drillAnswers": [],
        }), encoding="utf-8")
        return book

    def test_a_record_that_left_pending_review_is_counted(self):
        import tempfile
        rows = [
            {"sourceDifficulty": "easy", "qaLane": "clean-candidate", "status": "pending-review",
             "flags": [], "regions": {"figures": []}},
            {"sourceDifficulty": None, "qaLane": "needs-repair", "status": "ready",
             "flags": ["empty-stem"], "regions": {"figures": [[1, 2, 3, 4]]}},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            summary = status.read_book(self._book(tmp, rows))
        self.assertEqual(summary["questions"], 2)
        self.assertEqual(summary["figureQuestions"], 1)
        self.assertEqual(summary["cleanCandidates"], 1)
        self.assertEqual(summary["needsRepair"], 1)
        self.assertEqual(summary["notPendingReview"], 1)
        self.assertEqual(summary["tiers"]["easy"], 1)
        self.assertEqual(summary["tiers"]["None"], 1)

    def test_a_book_without_a_map_is_skipped_not_guessed(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            empty = Path(tmp) / "matha-114-trig-graph"
            empty.mkdir()
            self.assertIsNone(status.read_book(empty))


class ReviewGate(unittest.TestCase):
    """The only door out of review-only, so every refusal matters."""

    @staticmethod
    def candidate(**overrides):
        base = {
            "id": "line-inequality-p067-q1", "bookId": "matha-114-line-inequality",
            "pdfPage": 69, "printedPage": 67, "role": "chapter-end-easy",
            "questionType": "single", "sourceDifficulty": "easy",
            "sourceDifficultyEvidence": "基礎實力養成（OCR：基實力成）",
            "regions": {"figures": []}, "flags": [],
            "ocrIndex": {"stem": "1.（）在坐標平面上，根方程式x+5y-7=0"},
        }
        base.update(overrides)
        return base

    @staticmethod
    def decision(**overrides):
        base = {"decision": "approve", "type": "single",
                "q": "在坐標平面上，根據方程式 x+5y-7=0 畫出三條直線，試選出正確配置？",
                "opts": ["(A)", "(B)", "(C)", "(D)", "(E)"], "ans": [3]}
        base.update(overrides)
        return base

    def test_an_approved_choice_question_converts(self):
        record = review.convert(self.candidate(), self.decision(), "line")
        self.assertEqual(record["topic"], "line")
        self.assertEqual(record["diff"], 1)
        self.assertIn("基礎實力養成", record["diffEvidence"])
        self.assertEqual(record["ans"], [3])
        self.assertEqual(record["page"], 69)
        self.assertNotIn("needsFigure", record)

    def test_ocr_text_cannot_be_used_as_the_question(self):
        """OCR here garbles 選擇 into 遥挥 and drops signs; pasting it into q
        would ship wrong mathematics that still reads plausibly."""
        candidate = self.candidate()
        with self.assertRaises(review.ReviewError):
            review.convert(candidate, self.decision(q=candidate["ocrIndex"]["stem"]), "line")
        with self.assertRaises(review.ReviewError):
            review.convert(candidate, self.decision(q="   "), "line")

    def test_anything_short_of_approve_is_refused(self):
        for value in ("", "repair", "reject", None, "APPROVE"):
            with self.assertRaises(review.ReviewError):
                review.convert(self.candidate(), self.decision(decision=value), "line")

    def test_an_outstanding_flag_blocks_the_question(self):
        candidate = self.candidate(flags=["figure-referenced-but-missing"])
        with self.assertRaises(review.ReviewError):
            review.convert(candidate, self.decision(), "line")
        record = review.convert(
            candidate, self.decision(acceptedFlags=["figure-referenced-but-missing"]), "line")
        self.assertEqual(record["id"], candidate["id"])

    def test_a_book_without_a_printed_tier_needs_a_stated_basis(self):
        candidate = self.candidate(sourceDifficulty=None, sourceDifficultyEvidence="none")
        with self.assertRaises(review.ReviewError):
            review.convert(candidate, self.decision(), "line")
        with self.assertRaises(review.ReviewError):
            review.convert(candidate, self.decision(diff=2), "line")
        record = review.convert(candidate, self.decision(diff=2, diffEvidence="與 112 學測第 8 題同型"), "line")
        self.assertEqual(record["diff"], 2)

    def test_answers_must_index_into_the_options(self):
        for bad in ([5], [-1], ["B"], [], [0, 1]):
            with self.assertRaises(review.ReviewError):
                review.convert(self.candidate(), self.decision(ans=bad), "line")

    def test_a_fill_question_takes_string_answers(self):
        record = review.convert(self.candidate(questionType="fill"),
                                self.decision(type="fill", opts=[], ans=["√3"]), "line")
        self.assertEqual(record["ans"], ["√3"])
        self.assertNotIn("opts", record)

    def test_a_figure_question_leaves_quarantined_without_an_asset(self):
        candidate = self.candidate(regions={"figures": [[150, 200, 500, 700]]})
        record = review.convert(candidate, self.decision(), "line")
        self.assertTrue(record["needsFigure"])
        self.assertNotIn("figureAsset", record)

    def test_an_unknown_unit_is_refused(self):
        with self.assertRaises(review.ReviewError):
            review.convert(self.candidate(), self.decision(topic="geometry"), None)
        with self.assertRaises(review.ReviewError):
            review.convert(self.candidate(), self.decision(), None)

    def test_the_catalog_reader_finds_each_book_single_unit(self):
        catalog = review.read_catalog(REPO_ROOT / "textbook-catalog.js")
        by_id = {book["id"]: book["topics"] for book in catalog["books"]}
        self.assertEqual(by_id["matha-114-line-inequality"], ["line"])
        self.assertEqual(by_id["matha-114-trig-graph"], ["trig2"])


class RepoSafety(unittest.TestCase):
    def test_output_inside_the_repository_is_refused(self):
        with self.assertRaises(bookmap.MapError):
            bookmap.ensure_outside_repo(REPO_ROOT / "private-content")
        bookmap.ensure_outside_repo(Path(REPO_ROOT.anchor) / "somewhere-else")


if __name__ == "__main__":
    unittest.main()
