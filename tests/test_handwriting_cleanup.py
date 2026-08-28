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


if __name__ == "__main__":
    unittest.main()
