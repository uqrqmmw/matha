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
            self.assertFalse(record["releaseAuthority"])
            self.assertTrue(record["humanPixelReviewRequired"])

    def test_missing_cleaned_page_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            manifest.write_text('{"items": []}', encoding="utf-8")
            with self.assertRaises(recrop_pages.RecropError):
                recrop_pages.recrop(work, queue, manifest, root / "out")

    def test_wrong_cleanup_source_hash_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            work, queue, manifest, _ = self.fixture(root)
            data = json.loads(manifest.read_text(encoding="utf-8"))
            data["items"][0]["sourceSha256"] = "0" * 64
            manifest.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(recrop_pages.RecropError):
                recrop_pages.recrop(work, queue, manifest, root / "out")


if __name__ == "__main__":
    unittest.main()
