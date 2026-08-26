import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "index_mistral_pages", ROOT / "scripts" / "ingest" / "index-mistral-pages.py")
mistral = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(mistral)
AUDIT_SPEC = importlib.util.spec_from_file_location(
    "audit_mistral_index", ROOT / "scripts" / "ingest" / "audit-mistral-index.py")
audit_index = importlib.util.module_from_spec(AUDIT_SPEC)
assert AUDIT_SPEC.loader
AUDIT_SPEC.loader.exec_module(audit_index)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class MistralIndexTests(unittest.TestCase):
    def fixture(self):
        root = Path(tempfile.mkdtemp(prefix="matha-mistral-index-"))
        pdf = root / "source.pdf"
        document = fitz.open()
        page = document.new_page(width=300, height=420)
        page.draw_rect(fitz.Rect(15, 15, 130, 38), color=(.6, .6, .6), fill=(.8, .8, .8))
        page.insert_text((20, 31), "BASIC PRACTICE")
        page.insert_text((20, 90), "1. x + 1 = 2")
        page.insert_text((20, 120), "(A) 0 (B) 1 (C) 2")
        page.draw_rect(fitz.Rect(180, 75, 260, 145), color=(0, 0, 0))
        page.insert_text((140, 400), "- 1 -")
        document.save(pdf)
        document.close()
        digest = sha(pdf)
        catalog = root / "catalog.json"
        catalog.write_text(json.dumps({"books": [{"id": "test-book", "pdfSha256": digest}]}),
                           encoding="utf-8")
        ocr_root = root / "ocr"
        page_dir = ocr_root / "outputs" / "pages" / digest[:16]
        page_dir.mkdir(parents=True)
        payload = {
            "sourceFile": pdf.name, "sourceSha256": digest,
            "sourcePageIndex": 0, "sourcePageNumber": 1,
            "model": "mistral-ocr-latest",
            "page": {
                "dimensions": {"dpi": 102, "width": 300, "height": 420},
                "confidence_scores": {"average_page_confidence_score": .98},
                "blocks": [
                    {"top_left_x": 15, "top_left_y": 15, "bottom_right_x": 130,
                     "bottom_right_y": 38, "content": "# 基礎實力養成", "type": "title",
                     "confidence_scores": {"average_content_confidence_score": .99}},
                    {"top_left_x": 20, "top_left_y": 75, "bottom_right_x": 150,
                     "bottom_right_y": 95, "content": "1. x + 1 = 2", "type": "text",
                     "confidence_scores": {"average_content_confidence_score": .97}},
                    {"top_left_x": 20, "top_left_y": 100, "bottom_right_x": 150,
                     "bottom_right_y": 125, "content": "(A) 0 (B) 1 (C) 2", "type": "text",
                     "confidence_scores": {"average_content_confidence_score": .96}},
                    {"top_left_x": 180, "top_left_y": 75, "bottom_right_x": 260,
                     "bottom_right_y": 145, "content": "![img](img.jpeg)", "type": "image",
                     "confidence_scores": {"block_type_confidence_score": .99}},
                    {"top_left_x": 140, "top_left_y": 390, "bottom_right_x": 170,
                     "bottom_right_y": 405, "content": "- 1 -", "type": "footer",
                     "confidence_scores": {"average_content_confidence_score": .99}},
                ],
            },
        }
        response = page_dir / "0001.json"
        response.write_text(json.dumps(payload), encoding="utf-8")
        return root, pdf, catalog, ocr_root, response

    def test_index_uses_mistral_blocks_but_excludes_image_placeholder_text(self):
        root, pdf, catalog, ocr_root, response = self.fixture()
        result = mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)
        self.assertEqual(result["pagesWritten"], 1)
        record = json.loads((root / "work" / "test-book" / "pages" / "p0001.json")
                            .read_text(encoding="utf-8"))
        self.assertEqual(record["ocrProvider"], "mistral")
        self.assertEqual(record["ocrSourceSha256"], sha(response))
        self.assertIn("基礎實力養成", [line["text"] for line in record["ocr"]])
        self.assertFalse(any("![img]" in line["text"] for line in record["ocr"]))
        self.assertEqual(len(record["layout"]["mistralImageRegions"]), 1)
        self.assertTrue(record["displayTruth"] == "original-pdf-crop" and record["ocrIsIndexOnly"])

        resumed = mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)
        self.assertEqual(resumed["pagesWritten"], 0)
        self.assertEqual(resumed["pagesSkipped"], 1)

        audit = audit_index.audit(root / "work", ocr_root, catalog, 1, 1)
        self.assertTrue(audit["passed"])
        self.assertEqual(audit["totals"]["pages"], 1)

    def test_catalog_or_mistral_source_hash_mismatch_is_rejected(self):
        root, pdf, catalog, ocr_root, response = self.fixture()
        payload = json.loads(response.read_text(encoding="utf-8"))
        payload["sourceSha256"] = "0" * 64
        response.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaises(mistral.MistralIndexError):
            mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)


if __name__ == "__main__":
    unittest.main()
