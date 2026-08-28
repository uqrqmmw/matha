import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import fitz
import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]


def load(name: str, file_name: str):
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "scripts" / "ingest" / file_name
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


detect = load("detect_handwriting_candidates", "detect-handwriting-candidates.py")
render_pages = load("render_handwriting_pages", "render-handwriting-pages.py")
recrop_pages = load("recrop_cleaned_handwriting_pages", "recrop-cleaned-handwriting-pages.py")
prepare_clean_review = load(
    "prepare_cleaned_handwriting_review", "prepare-cleaned-handwriting-review.py"
)
prepare_answer_review = load(
    "prepare_cleaned_answer_review", "prepare-cleaned-answer-review.py"
)
intersect_clean_reviews = load(
    "intersect_cleaned_human_reviews", "intersect-cleaned-human-reviews.py"
)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class HandwritingDetectionTests(unittest.TestCase):
    def test_thin_scanned_rule_does_not_count_as_handwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rule.png"
            image = Image.new("L", (800, 220), 255)
            draw = ImageDraw.Draw(image)
            draw.line((20, 200, 780, 200), fill=135, width=2)
            image.save(path)
            features = detect.pencil_features(path)
        self.assertGreater(features["maxGreyComponent"], 250)
        self.assertEqual(features["maxStrokeGreyComponent"], 0)

    def test_two_dimensional_grey_pencil_mark_is_retained(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pencil.png"
            image = Image.new("L", (800, 220), 255)
            draw = ImageDraw.Draw(image)
            draw.ellipse((360, 60, 455, 155), outline=145, width=5)
            draw.line((375, 135, 440, 75), fill=155, width=5)
            image.save(path)
            features = detect.pencil_features(path)
        self.assertGreaterEqual(features["maxStrokeGreyComponent"], 250)

    def test_filled_answer_and_trailing_answer_patterns(self):
        question = {
            "ocrIndex": {"stem": r"答案 【156】？ 26", "options": []},
            "regions": {"contentBox": [0, 0, 200, 200]},
        }
        page = {"ocr": []}
        features = detect.ocr_features(question, page)
        self.assertTrue(features["filledAnswerBracket"])
        self.assertTrue(features["trailingAnswer"])


class HandwritingPageRenderTests(unittest.TestCase):
    def make_source(self, root: Path):
        source_root = root / "source"
        source_root.mkdir()
        pdf = source_root / "book.pdf"
        document = fitz.open()
        for text in ("PAGE ONE", "PAGE TWO"):
            page = document.new_page(width=300, height=420)
            page.insert_text((40, 100), text, fontsize=28)
        document.save(pdf)
        document.close()
        digest = sha(pdf)
        catalog = root / "catalog.js"
        catalog.write_text(
            "{id:'book',file:'book.pdf',pdfSha256:'" + digest + "'}\n",
            encoding="utf-8",
        )
        queue = root / "queue.json"
        queue.write_text(
            json.dumps({"pages": [{
                "id": "book-pdf-0002", "bookId": "book", "pdfPage": 2,
                "questionIds": ["q2"],
            }]}),
            encoding="utf-8",
        )
        return source_root, catalog, queue

    def test_render_is_bound_to_requested_page_and_overwrites_stale_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_root, catalog, queue = self.make_source(root)
            output = root / "out"
            stale = output / "book" / "crops" / "book-pdf-0002" / "stem.png"
            stale.parent.mkdir(parents=True)
            Image.new("RGB", (50, 50), "red").save(stale)
            result = render_pages.render(queue, catalog, source_root, output, 150, None, None)
            manifest = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
            rendered = Path(manifest["items"][0]["render"])
            image = Image.open(rendered).convert("RGB")
            rendered_digest = sha(rendered)
            self.assertNotEqual(image.size, (50, 50))
            self.assertEqual(manifest["items"][0]["pdfPage"], 2)
            self.assertEqual(manifest["items"][0]["renderSha256"], rendered_digest)

    def test_source_pdf_hash_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_root, catalog, queue = self.make_source(root)
            catalog.write_text(
                "{id:'book',file:'book.pdf',pdfSha256:'" + "0" * 64 + "'}\n",
                encoding="utf-8",
            )
            with self.assertRaises(render_pages.RenderError):
                render_pages.render(queue, catalog, source_root, root / "out", 150, None, None)


class HandwritingRecropTests(unittest.TestCase):
    def fixture(self, root: Path):
        work = root / "work"
        source = work / "book" / "crops" / "q1" / "stem.png"
        source.parent.mkdir(parents=True)
        Image.new("RGB", (200, 100), "white").save(source)
        (work / "book" / "crops-manifest.json").write_text(
            json.dumps({"cropDpi": 300, "crops": {"q1": {"stemRegion": [10, 20, 110, 70]}}}),
            encoding="utf-8",
        )
        render = root / "render.png"
        page = np.full((600, 800, 3), 255, dtype=np.uint8)
        page[40:140, 20:220] = (230, 230, 230)
        Image.fromarray(page).save(render)
        cleaned = root / "cleaned.png"
        Image.fromarray(page).save(cleaned)
        queue = root / "queue.json"
        queue.write_text(json.dumps({"items": [{
            "id": "book-pdf-0001", "bookId": "book", "pdfPage": 1,
            "questionIds": ["q1"], "render": str(render), "renderSha256": sha(render),
        }]}), encoding="utf-8")
        manifest = root / "cleaned.json"
        manifest.write_text(json.dumps({"items": [{
            "id": "book-pdf-0001", "sourceSha256": sha(render),
            "cleaned": str(cleaned), "cleanedSha256": sha(cleaned),
        }]}), encoding="utf-8")
        return work, queue, manifest, render

    def test_recrop_preserves_geometry_and_marks_output_review_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            result = recrop_pages.recrop(work, queue, manifest, root / "out")
            record = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
            with Image.open(record["items"][0]["cleaned"]) as crop:
                crop_size = crop.size
            self.assertEqual(crop_size, (200, 100))
            self.assertEqual(record["items"][0]["sourceSha256"], sha(
                work / "book" / "crops" / "q1" / "stem.png"
            ))
            self.assertEqual(record["items"][0]["cleanedSha256"], sha(
                Path(record["items"][0]["cleaned"])
            ))
            self.assertEqual(record["cleanupManifestSha256"], sha(manifest))
            self.assertEqual(record["pageQueueSha256"], sha(queue))
            self.assertFalse(record["releaseAuthority"])
            self.assertTrue(record["humanPixelReviewRequired"])

    def test_missing_cleaned_page_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            manifest.write_text('{"items": []}', encoding="utf-8")
            with self.assertRaises(recrop_pages.RecropError):
                recrop_pages.recrop(work, queue, manifest, root / "out")

    def test_incomplete_pages_can_only_be_explicitly_quarantined(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            manifest.write_text(json.dumps({
                "items": [],
                "failures": [{
                    "id": "book-pdf-0001",
                    "error": "provider changed page geometry",
                }],
            }), encoding="utf-8")
            result = recrop_pages.recrop(
                work,
                queue,
                manifest,
                root / "out",
                quarantine_incomplete=True,
            )
            record = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
            self.assertEqual(record["cleanedPageCount"], 0)
            self.assertEqual(record["quarantinedPageCount"], 1)
            self.assertEqual(record["quarantinedQuestionCount"], 1)
            self.assertEqual(record["questions"], 0)
            self.assertEqual(record["quarantinedPages"], [{
                "id": "book-pdf-0001",
                "reason": "provider changed page geometry",
                "unresolvedQuestionIds": ["q1"],
            }])
            self.assertFalse(record["releaseAuthority"])

    def test_failed_full_page_can_be_rescued_by_hash_bound_question_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            manifest.write_text('{"items": []}', encoding="utf-8")
            source = work / "book" / "crops" / "q1" / "stem.png"
            fallback_image = root / "fallback-q1.png"
            Image.new("RGB", (200, 100), "white").save(fallback_image)
            fallback = root / "fallback.json"
            fallback.write_text(json.dumps({"items": [{
                "id": "q1",
                "sourceSha256": sha(source),
                "cleaned": str(fallback_image),
                "cleanedSha256": sha(fallback_image),
            }]}), encoding="utf-8")
            result = recrop_pages.recrop(
                work,
                queue,
                manifest,
                root / "out",
                fallback_cleanup_manifest=fallback,
            )
            record = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
            self.assertEqual(record["rescuedPageCount"], 1)
            self.assertEqual(record["fullyRescuedPageCount"], 1)
            self.assertEqual(record["fallbackQuestionCount"], 1)
            self.assertEqual(record["quarantinedPageCount"], 0)
            self.assertEqual(record["items"][0]["cleanupMode"], "question-fallback")
            self.assertEqual(record["items"][0]["cleanedSha256"], sha(
                Path(record["items"][0]["cleaned"])
            ))

    def test_partial_question_fallback_preserves_success_and_quarantines_only_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            source2 = work / "book" / "crops" / "q2" / "stem.png"
            source2.parent.mkdir(parents=True)
            Image.new("RGB", (200, 100), "white").save(source2)
            crop_manifest = work / "book" / "crops-manifest.json"
            crop_data = json.loads(crop_manifest.read_text(encoding="utf-8"))
            crop_data["crops"]["q2"] = {"stemRegion": [10, 80, 110, 130]}
            crop_manifest.write_text(json.dumps(crop_data), encoding="utf-8")
            queue_data = json.loads(queue.read_text(encoding="utf-8"))
            queue_data["items"][0]["questionIds"] = ["q1", "q2"]
            queue.write_text(json.dumps(queue_data), encoding="utf-8")
            manifest.write_text(json.dumps({"items": [], "failures": [{
                "id": "book-pdf-0001", "error": "full page geometry changed",
            }]}), encoding="utf-8")
            fallback_image = root / "fallback-q1.png"
            Image.new("RGB", (200, 100), "white").save(fallback_image)
            fallback = root / "fallback.json"
            fallback.write_text(json.dumps({
                "items": [{
                    "id": "q1", "sourceSha256": sha(work / "book" / "crops" / "q1" / "stem.png"),
                    "cleaned": str(fallback_image), "cleanedSha256": sha(fallback_image),
                }],
                "failures": [{"id": "q2", "error": "question geometry changed"}],
            }), encoding="utf-8")
            result = recrop_pages.recrop(
                work, queue, manifest, root / "out",
                quarantine_incomplete=True,
                fallback_cleanup_manifest=fallback,
            )
            record = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
            self.assertEqual(record["fallbackQuestionCount"], 1)
            self.assertEqual(record["quarantinedPageCount"], 1)
            self.assertEqual(record["quarantinedQuestionCount"], 1)
            self.assertEqual(record["quarantinedQuestions"], [{
                "id": "q2", "pageId": "book-pdf-0001",
                "reason": "question geometry changed",
            }])

    def test_fallback_cleanup_with_wrong_source_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            manifest.write_text('{"items": []}', encoding="utf-8")
            fallback_image = root / "fallback-q1.png"
            Image.new("RGB", (200, 100), "white").save(fallback_image)
            fallback = root / "fallback.json"
            fallback.write_text(json.dumps({"items": [{
                "id": "q1",
                "sourceSha256": "0" * 64,
                "cleaned": str(fallback_image),
                "cleanedSha256": sha(fallback_image),
            }]}), encoding="utf-8")
            with self.assertRaises(recrop_pages.RecropError):
                recrop_pages.recrop(
                    work,
                    queue,
                    manifest,
                    root / "out",
                    fallback_cleanup_manifest=fallback,
                )

    def test_wrong_cleanup_source_hash_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            data = json.loads(manifest.read_text(encoding="utf-8"))
            data["items"][0]["sourceSha256"] = "0" * 64
            manifest.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(recrop_pages.RecropError):
                recrop_pages.recrop(work, queue, manifest, root / "out")


class CleanedHandwritingReviewPacketTests(unittest.TestCase):
    def fixture(self, root: Path):
        source = root / "source.png"
        cleaned = root / "cleaned.png"
        original = Image.new("RGB", (240, 120), "white")
        draw = ImageDraw.Draw(original)
        draw.text((15, 15), "PRINTED", fill="black")
        draw.line((20, 90, 210, 90), fill="black", width=4)
        original.save(source)
        candidate = original.copy()
        ImageDraw.Draw(candidate).rectangle((150, 75, 220, 110), fill="white")
        candidate.save(cleaned)
        overlay = root / "page-overlay.png"
        mask = root / "page-mask.png"
        marked = original.copy()
        ImageDraw.Draw(marked).rectangle((150, 75, 220, 110), fill=(190, 58, 52))
        marked.save(overlay)
        mask_image = Image.new("L", original.size, 0)
        ImageDraw.Draw(mask_image).rectangle((150, 75, 220, 110), fill=255)
        mask_image.save(mask)
        page_cleanup = root / "page-cleanup.json"
        page_cleanup.write_text(json.dumps({
            "service": "yescanner-handwriting-remover-v1",
            "releaseAuthority": False,
            "items": [{
                "id": "book-pdf-0001", "sourceSha256": sha(source),
                "cleanedSha256": sha(cleaned),
                "diff": str(overlay), "diffSha256": sha(overlay),
                "mask": str(mask), "maskSha256": sha(mask),
                "cleaned": str(cleaned),
            }],
        }), encoding="utf-8")
        fallback_cleanup = root / "fallback-cleanup.json"
        fallback_cleanup.write_text(json.dumps({
            "service": "yescanner-handwriting-remover-v1",
            "releaseAuthority": False,
            "items": [],
        }), encoding="utf-8")
        manifest = root / "cleaned-question-candidates.json"
        manifest.write_text(json.dumps({
            "kind": "cleaned-page-question-candidates",
            "releaseAuthority": False,
            "humanPixelReviewRequired": True,
            "cleanupManifestSha256": sha(page_cleanup),
            "fallbackCleanupManifestSha256": sha(fallback_cleanup),
            "items": [{
                "id": "book-p001-q1", "bookId": "book", "pdfPage": 1,
                "pageId": "book-pdf-0001", "cleanupMode": "full-page-recrop",
                "pageRenderSha256": sha(source), "pageCleanedSha256": sha(cleaned),
                "stemRegion": [0, 0, 240, 120],
                "source": str(source), "sourceSha256": sha(source),
                "cleaned": str(cleaned), "cleanedSha256": sha(cleaned),
            }],
        }), encoding="utf-8")
        return manifest, page_cleanup, fallback_cleanup, source, cleaned

    def test_builds_hash_bound_paged_review_without_release_authority(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest, page_cleanup, fallback_cleanup, _, _ = self.fixture(root)
            result = prepare_clean_review.prepare(
                manifest, page_cleanup, fallback_cleanup, root / "review", page_size=1
            )
            template = json.loads(Path(result["template"]).read_text(encoding="utf-8"))
            review_html = Path(result["review"]).read_text(encoding="utf-8")
            page_html = (root / "review" / "review-pages" / "page-0001.html").read_text(
                encoding="utf-8"
            )
            self.assertEqual(result["questions"], 1)
            self.assertFalse(result["releaseAuthority"])
            self.assertEqual(template["candidateManifestSha256"], sha(manifest))
            self.assertFalse(template["releaseAuthority"])
            self.assertTrue((root / "review" / "removed-overlays" / "book-p001-q1.png").is_file())
            self.assertEqual(
                sha(root / "review" / "assets" / "book-p001-q1" / "source.png"),
                sha(root / "source.png"),
            )
            self.assertIn("../assets/book-p001-q1/source.png", page_html)
            self.assertNotIn("file://", page_html)
            self.assertIn("mathSymbolsAndFormulasIntact", page_html)
            self.assertIn("figuresAndGreyLinesIntact", page_html)
            self.assertIn("cleaned-handwriting-human-review.json", review_html)
            self.assertIn("http://127.0.0.1:8765/review.html", review_html)
            self.assertTrue((root / "review" / "serve-review.py").is_file())

    def test_tampered_candidate_artifact_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest, page_cleanup, fallback_cleanup, _, cleaned = self.fixture(root)
            Image.new("RGB", (240, 120), "red").save(cleaned)
            with self.assertRaises(prepare_clean_review.ReviewPacketError):
                prepare_clean_review.prepare(
                    manifest, page_cleanup, fallback_cleanup, root / "review"
                )


class CleanedAnswerReviewPacketTests(unittest.TestCase):
    def fixture(self, root: Path):
        source_root = root / "source-pdfs"
        source_root.mkdir()
        pdf = source_root / "book.pdf"
        document = fitz.open()
        page = document.new_page(width=300, height=400)
        page.insert_text((12, 35), "QUESTION 1", fontsize=12)
        page.insert_text((12, 75), "ANSWER 42", fontsize=12)
        document.save(pdf)
        document.close()
        pdf_hash = sha(pdf)
        stem_region = [0, 0, 150, 100]
        answer_region = [0, 100, 150, 200]
        work = root / "work"
        crop_dir = work / "book" / "crops" / "book-p001-q1"
        crop_dir.mkdir(parents=True)
        document = fitz.open(str(pdf))
        try:
            stem_pixmap = document[0].get_pixmap(
                dpi=300, clip=prepare_answer_review.pdf_rect(stem_region), alpha=False
            )
            answer_pixmap = document[0].get_pixmap(
                dpi=300, clip=prepare_answer_review.pdf_rect(answer_region), alpha=False
            )
            stem_pixmap.save(str(crop_dir / "stem.png"))
            answer_pixmap.save(str(crop_dir / "answer.png"))
        finally:
            document.close()
        cleaned = root / "cleaned.png"
        cleaned.write_bytes((crop_dir / "stem.png").read_bytes())
        question_doc = {
            "schema": 11, "kind": "textbook-question-candidates",
            "bookId": "book", "pdfSha256": pdf_hash,
            "questions": [{
                "id": "book-p001-q1", "bookId": "book", "pdfPage": 1,
                "chapter": "test", "role": "drill", "questionType": "calculation",
                "displayTruth": "original-pdf-crop", "regions": {"inlineAnswer": None},
                "answerRef": {"pdfPage": 1, "region": answer_region},
            }],
        }
        (work / "book" / "questions.pending-review.json").write_text(
            json.dumps(question_doc), encoding="utf-8"
        )
        crop_doc = {
            "schema": 11, "kind": "textbook-crop-manifest", "bookId": "book",
            "pdfSha256": pdf_hash, "cropDpi": 300,
            "crops": {"book-p001-q1": {
                "stemRegion": stem_region, "answer": True,
                "answerRegion": answer_region, "figures": 0,
            }},
        }
        (work / "book" / "crops-manifest.json").write_text(
            json.dumps(crop_doc), encoding="utf-8"
        )
        candidate = root / "candidates.json"
        candidate.write_text(json.dumps({
            "kind": "cleaned-page-question-candidates", "releaseAuthority": False,
            "items": [{
                "id": "book-p001-q1", "bookId": "book", "pdfPage": 1,
                "stemRegion": stem_region,
                "source": str(crop_dir / "stem.png"),
                "sourceSha256": sha(crop_dir / "stem.png"),
                "cleaned": str(cleaned), "cleanedSha256": sha(cleaned),
            }],
        }), encoding="utf-8")
        catalog = root / "catalog.json"
        catalog.write_text(json.dumps({
            "books": [{"id": "book", "file": "book.pdf", "pdfSha256": pdf_hash}]
        }), encoding="utf-8")
        return candidate, work, source_root, catalog, crop_dir

    def test_binds_question_and_answer_to_exact_pdf_pixels(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate, work, source_root, catalog, _ = self.fixture(root)
            result = prepare_answer_review.prepare(
                candidate, work, source_root, catalog, root / "review", page_size=1
            )
            binding = json.loads(
                (root / "review" / "answer-binding-candidates.json").read_text(encoding="utf-8")
            )
            page_html = (root / "review" / "review-pages" / "page-0001.html").read_text(
                encoding="utf-8"
            )
            self.assertEqual(result["reviewable"], 1)
            self.assertEqual(result["quarantined"], 0)
            self.assertFalse(result["releaseAuthority"])
            self.assertEqual(binding["items"][0]["answerSource"], "answer-key")
            self.assertTrue((root / "review" / "assets" / "book-p001-q1" / "answer.png").is_file())
            self.assertIn("../assets/book-p001-q1/question.png", page_html)
            self.assertIn("mathematicallyCorrect", page_html)
            self.assertNotIn("file://", page_html)

    def test_missing_answer_is_quarantined_not_invented_from_ocr(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate, work, source_root, catalog, crop_dir = self.fixture(root)
            (crop_dir / "answer.png").unlink()
            crop_file = work / "book" / "crops-manifest.json"
            crop_doc = json.loads(crop_file.read_text(encoding="utf-8"))
            crop_doc["crops"]["book-p001-q1"]["answer"] = False
            crop_file.write_text(json.dumps(crop_doc), encoding="utf-8")
            result = prepare_answer_review.prepare(
                candidate, work, source_root, catalog, root / "review"
            )
            binding = json.loads(
                (root / "review" / "answer-binding-candidates.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["reviewable"], 0)
            self.assertEqual(result["quarantined"], 1)
            self.assertEqual(binding["quarantined"][0]["reason"], "official-answer-crop-missing")

    def test_answer_pixels_changed_after_crop_are_quarantined(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate, work, source_root, catalog, crop_dir = self.fixture(root)
            answer = crop_dir / "answer.png"
            image = Image.open(answer).convert("RGB")
            ImageDraw.Draw(image).rectangle((0, 0, 20, 20), fill="red")
            image.save(answer)
            result = prepare_answer_review.prepare(
                candidate, work, source_root, catalog, root / "review"
            )
            binding = json.loads(
                (root / "review" / "answer-binding-candidates.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["reviewable"], 0)
            self.assertIn("answer-pixels-do-not-match-source-pdf", binding["quarantined"][0]["reason"])

    def test_review_output_must_be_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest, page_cleanup, fallback_cleanup, _, _ = self.fixture(root)
            output = root / "review"
            output.mkdir()
            (output / "stale.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(prepare_clean_review.ReviewPacketError):
                prepare_clean_review.prepare(
                    manifest, page_cleanup, fallback_cleanup, output
                )

    def test_candidate_id_cannot_escape_review_artifact_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest, page_cleanup, fallback_cleanup, _, _ = self.fixture(root)
            data = json.loads(manifest.read_text(encoding="utf-8"))
            data["items"][0]["id"] = "../escaped"
            manifest.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(prepare_clean_review.ReviewPacketError):
                prepare_clean_review.prepare(
                    manifest, page_cleanup, fallback_cleanup, root / "review"
                )


class CleanedDualHumanReviewTests(unittest.TestCase):
    def fixture(self, root: Path):
        ids = ["book-p001-q1", "book-p001-q2"]
        assets = root / "assets"
        overlays = root / "pixel-packet" / "removed-overlays"
        assets.mkdir()
        overlays.mkdir(parents=True)
        candidate_items = []
        pixel_questions = []
        answer_items = []
        answer_questions = []
        for index, qid in enumerate(ids, 1):
            source = assets / f"source-{index}.png"
            cleaned = assets / f"cleaned-{index}.png"
            answer = assets / f"answer-{index}.png"
            overlay = overlays / f"{qid}.png"
            for path, color in (
                (source, (index * 20, 20, 20)),
                (cleaned, (255, 255, 255)),
                (answer, (20, index * 20, 20)),
                (overlay, (200, 40, 40)),
            ):
                Image.new("RGB", (20, 20), color).save(path)
            candidate_items.append({
                "id": qid, "bookId": "book", "pdfPage": 1,
                "stemRegion": [0, 0, 20, 20], "source": str(source),
                "sourceSha256": sha(source), "cleaned": str(cleaned),
                "cleanedSha256": sha(cleaned),
            })
            pixel_questions.append({
                "id": qid, "sourceSha256": sha(source),
                "cleanedSha256": sha(cleaned),
                "removedOverlaySha256": sha(overlay), "decision": "pass",
                "visual": {key: True for key in intersect_clean_reviews.PIXEL_CHECKS},
                "notes": "",
            })
            answer_items.append({
                "id": qid, "bookId": "book", "chapter": "test",
                "role": "drill", "questionType": "calculation", "pdfPage": 1,
                "answerPdfPage": 2, "answerRegion": [0, 0, 20, 20],
                "answerSource": "answer-key", "sourcePdfSha256": sha(source),
                "sourceSha256": sha(source), "cleanedSha256": sha(cleaned),
                "answerSha256": sha(answer), "figureCount": 0, "figureSha256": [],
            })
            packet_assets = root / "assets" / qid
            packet_assets.mkdir(parents=True)
            (packet_assets / "question.png").write_bytes(cleaned.read_bytes())
            (packet_assets / "answer.png").write_bytes(answer.read_bytes())
            pixel_assets = root / "pixel-packet" / "assets" / qid
            pixel_assets.mkdir(parents=True)
            (pixel_assets / "source.png").write_bytes(source.read_bytes())
            (pixel_assets / "cleaned.png").write_bytes(cleaned.read_bytes())
            answer_questions.append({
                "id": qid, "cleanedSha256": sha(cleaned),
                "answerSha256": sha(answer), "sourcePdfSha256": sha(source),
                "decision": "pass",
                "visual": {key: True for key in intersect_clean_reviews.ANSWER_CHECKS},
                "notes": "",
            })
        candidate = root / "candidates.json"
        candidate.write_text(json.dumps({
            "kind": "cleaned-page-question-candidates", "releaseAuthority": False,
            "humanPixelReviewRequired": True,
            "cleanupManifestSha256": "a" * 64,
            "fallbackCleanupManifestSha256": "b" * 64,
            "items": candidate_items,
        }), encoding="utf-8")
        candidate_hash = sha(candidate)
        pixel_template = root / "pixel-packet" / "cleaned-handwriting-human-review.template.json"
        pixel_template.write_text(json.dumps({
            "kind": "matha-private-cleaned-handwriting-human-review", "version": 1,
            "releaseAuthority": False, "candidateManifestSha256": candidate_hash,
            "questions": pixel_questions,
        }), encoding="utf-8")
        pixel_review = root / "pixel-review.json"
        pixel_document = {
            "kind": "matha-private-cleaned-handwriting-human-review", "version": 1,
            "releaseAuthority": False, "humanReviewerRequired": True,
            "candidateManifestSha256": candidate_hash,
            "pageCleanupManifestSha256": "a" * 64,
            "fallbackCleanupManifestSha256": "b" * 64,
            "reviewer": "王小明", "reviewedAt": "2026-08-28T18:00:00+08:00",
            "summary": {"passed": 1, "rejected": 1, "unreviewed": 0},
            "questions": pixel_questions,
        }
        pixel_document["questions"][1]["decision"] = "reject"
        pixel_review.write_text(json.dumps(pixel_document), encoding="utf-8")
        binding = root / "binding.json"
        binding.write_text(json.dumps({
            "kind": "cleaned-answer-binding-candidates", "version": 1,
            "releaseAuthority": False, "humanAnswerReviewRequired": True,
            "handwritingPixelReviewAlsoRequired": True,
            "candidateManifestSha256": candidate_hash,
            "total": 2, "reviewableCount": 2, "quarantinedCount": 0,
            "quarantined": [], "items": answer_items,
        }), encoding="utf-8")
        answer_review = root / "answer-review.json"
        answer_review.write_text(json.dumps({
            "kind": "matha-private-cleaned-answer-human-review", "version": 1,
            "releaseAuthority": False, "humanReviewerRequired": True,
            "candidateManifestSha256": candidate_hash,
            "answerBindingSha256": sha(binding), "reviewer": "陳老師",
            "reviewedAt": "2026-08-28T19:00:00+08:00",
            "summary": {"passed": 2, "rejected": 0, "unreviewed": 0},
            "questions": answer_questions,
        }), encoding="utf-8")
        return candidate, pixel_template, pixel_review, binding, answer_review

    def run_fixture(self, root: Path):
        inputs = self.fixture(root)
        output = root / "dual-review.json"
        result = intersect_clean_reviews.intersect(*inputs, output)
        return result, output, inputs

    def test_only_double_passed_questions_are_staged_without_release_authority(self):
        with tempfile.TemporaryDirectory() as tmp:
            result, output, _ = self.run_fixture(Path(tmp))
            self.assertTrue(output.is_file())
            self.assertFalse(result["releaseAuthority"])
            self.assertTrue(result["humanReleaseSignoffStillRequired"])
            self.assertFalse(result["uploadPerformed"])
            self.assertEqual(result["counts"]["eligibleAfterBothReviews"], 1)
            self.assertEqual([row["id"] for row in result["items"]], ["book-p001-q1"])
            self.assertEqual(result["quarantine"][0]["reasons"], ["pixel-review-rejected"])

    def test_ai_reviewer_and_incomplete_review_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs = self.fixture(root)
            review = json.loads(inputs[2].read_text(encoding="utf-8"))
            review["reviewer"] = "Claude AI"
            inputs[2].write_text(json.dumps(review), encoding="utf-8")
            with self.assertRaises(intersect_clean_reviews.DualReviewError):
                intersect_clean_reviews.intersect(*inputs, root / "out.json")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs = self.fixture(root)
            review = json.loads(inputs[4].read_text(encoding="utf-8"))
            review["questions"][0]["decision"] = ""
            inputs[4].write_text(json.dumps(review), encoding="utf-8")
            with self.assertRaises(intersect_clean_reviews.DualReviewError):
                intersect_clean_reviews.intersect(*inputs, root / "out.json")

    def test_hash_drift_and_unchecked_pass_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs = self.fixture(root)
            Image.new("RGB", (20, 20), "black").save(
                root / "pixel-packet" / "removed-overlays" / "book-p001-q1.png"
            )
            with self.assertRaises(intersect_clean_reviews.DualReviewError):
                intersect_clean_reviews.intersect(*inputs, root / "out.json")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs = self.fixture(root)
            review = json.loads(inputs[4].read_text(encoding="utf-8"))
            review["questions"][0]["visual"]["mathematicallyCorrect"] = False
            inputs[4].write_text(json.dumps(review), encoding="utf-8")
            with self.assertRaises(intersect_clean_reviews.DualReviewError):
                intersect_clean_reviews.intersect(*inputs, root / "out.json")

    def test_answer_quarantine_cannot_enter_the_intersection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs = self.fixture(root)
            binding = json.loads(inputs[3].read_text(encoding="utf-8"))
            removed = binding["items"].pop()
            binding["reviewableCount"] = 1
            binding["quarantinedCount"] = 1
            binding["quarantined"] = [{
                "id": removed["id"], "bookId": removed["bookId"],
                "reason": "official-answer-crop-missing",
            }]
            inputs[3].write_text(json.dumps(binding), encoding="utf-8")
            review = json.loads(inputs[4].read_text(encoding="utf-8"))
            review["answerBindingSha256"] = sha(inputs[3])
            review["questions"] = review["questions"][:1]
            review["summary"] = {"passed": 1, "rejected": 0, "unreviewed": 0}
            inputs[4].write_text(json.dumps(review), encoding="utf-8")
            result = intersect_clean_reviews.intersect(*inputs, root / "out.json")
            self.assertEqual([row["id"] for row in result["items"]], ["book-p001-q1"])
            quarantined = {row["id"]: row["reasons"] for row in result["quarantine"]}
            self.assertIn("official-answer-crop-missing", quarantined["book-p001-q2"])


if __name__ == "__main__":
    unittest.main()
