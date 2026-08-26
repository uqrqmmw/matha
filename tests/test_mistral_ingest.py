import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import fitz
import numpy as np

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
REPAIR_SPEC = importlib.util.spec_from_file_location(
    "repair_dropout_openai", ROOT / "scripts" / "ingest" / "repair-dropout-openai.py")
openai_repair = importlib.util.module_from_spec(REPAIR_SPEC)
assert REPAIR_SPEC.loader
REPAIR_SPEC.loader.exec_module(openai_repair)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class MistralIndexTests(unittest.TestCase):
    def test_openai_repair_render_must_be_the_requested_pdf_page(self):
        root = Path(tempfile.mkdtemp(prefix="matha-openai-render-"))
        pdf = root / "source.pdf"
        document = fitz.open()
        for text in ("PAGE ONE", "PAGE TWO"):
            page = document.new_page(width=420, height=600)
            page.insert_text((60, 180), text, fontsize=28)
        document.save(pdf)
        document.close()

        source = fitz.open(pdf)
        correct = root / "correct.jpg"
        wrong = root / "wrong.jpg"
        correct.write_bytes(source[0].get_pixmap(dpi=240, alpha=False).tobytes("jpg"))
        wrong.write_bytes(source[1].get_pixmap(dpi=240, alpha=False).tobytes("jpg"))
        source.close()

        verified = openai_repair.verify_render_source(pdf, 1, correct)
        self.assertEqual(verified["method"],
                         "fresh-pdf-page-render-240dpi-rgb-error-v1")
        with self.assertRaises(openai_repair.RepairError):
            openai_repair.verify_render_source(pdf, 1, wrong)
        with self.assertRaises(openai_repair.RepairError):
            openai_repair.verify_render_source(pdf, 0, correct)

    def test_consecutive_embedded_numbered_items_are_split(self):
        text = "1. first\ncontinued\n\n2. second\n\n3. third"
        self.assertEqual(mistral.embedded_numbered_segments(text), [
            "1. first\ncontinued", "2. second", "3. third",
        ])
        self.assertEqual(mistral.embedded_numbered_segments(
            "1. value 1.7\n\n3. not consecutive"),
            ["1. value 1.7\n\n3. not consecutive"])

    def test_split_regions_snap_to_blank_rows(self):
        gray = np.full((300, 200), 255, dtype=np.uint8)
        gray[20:75, 10:190] = 0
        gray[110:165, 10:190] = 0
        gray[205:260, 10:190] = 0
        regions = mistral.split_block_regions(
            "1. first\n\n2. second\n\n3. third", [10, 20, 190, 260], gray)
        self.assertEqual([text for text, _ in regions],
                         ["1. first", "2. second", "3. third"])
        self.assertTrue(75 <= regions[0][1][3] <= 110)
        self.assertEqual(regions[0][1][3], regions[1][1][1])
        self.assertTrue(165 <= regions[1][1][3] <= 205)

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
        (ocr_root / "qa").mkdir(parents=True)
        (ocr_root / "qa" / "manual-dispositions.json").write_text("[]", encoding="utf-8")
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

    def add_openai_repair(self, pdf, ocr_root, response, page_number=1):
        digest = sha(pdf)
        basename = f"{digest[:16]}-p{page_number:04d}"
        repair_root = ocr_root / "repairs" / "dropouts"
        render = repair_root / "renders" / f"{basename}.jpg"
        raw_file = repair_root / "raw" / f"{basename}-openai.json"
        candidate_file = repair_root / "candidates" / f"{basename}.json"
        render.parent.mkdir(parents=True)
        raw_file.parent.mkdir(parents=True)
        candidate_file.parent.mkdir(parents=True)
        render.write_bytes(b"reviewed-render")
        structured = {
            "pageMarkdown": "1. repaired x + 1 = 2",
            "blocks": [{"bbox": [50, 180, 700, 260],
                        "text": "1. repaired x + 1 = 2", "blockType": "text"}],
            "qualityWarnings": [],
        }
        raw = {
            "id": "resp_test", "model": "gpt-5.5", "status": "completed",
            "output": [{"type": "message", "content": [{
                "type": "output_text", "text": json.dumps(structured),
            }]}],
        }
        raw_file.write_text(json.dumps(raw), encoding="utf-8")
        candidate = {
            "sourceFile": pdf.name, "sourceSha256": digest,
            "sourcePageIndex": page_number - 1, "sourcePageNumber": page_number,
            "repairReason": "whole-document-ocr-dropout",
            "repairProvider": "openai", "repairModel": "gpt-5.5",
            "repairResolvedModel": "gpt-5.5",
            "repairMethod": "single-page-jpeg-240dpi-structured-vision",
            "renderSha256": sha(render), "rawResponseSha256": sha(raw_file),
            "responseId": "resp_test", "qualityWarnings": [],
            "page": {
                "dimensions": {"dpi": 0, "width": 1000, "height": 1000},
                "markdown": structured["pageMarkdown"], "images": [],
                "blocks": [{
                    "top_left_x": 50, "top_left_y": 180,
                    "bottom_right_x": 700, "bottom_right_y": 260,
                    "content": structured["blocks"][0]["text"], "type": "text",
                }],
            },
        }
        candidate_file.write_text(json.dumps(candidate), encoding="utf-8")
        dispositions = [{
            "sourceSha256": digest, "sourcePageNumber": page_number,
            "disposition": "ocr-dropout",
        }]
        (ocr_root / "qa" / "manual-dispositions.json").write_text(
            json.dumps(dispositions), encoding="utf-8")
        return candidate_file, raw_file

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

    def test_reviewed_openai_repair_is_preferred_and_auditable(self):
        root, pdf, catalog, ocr_root, response = self.fixture()
        candidate, _ = self.add_openai_repair(pdf, ocr_root, response)
        result = mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)
        self.assertEqual(result["verifiedDropoutRepairsApplied"], 1)
        record_file = root / "work" / "test-book" / "pages" / "p0001.json"
        record = json.loads(record_file.read_text(encoding="utf-8"))
        self.assertEqual([line["text"] for line in record["ocr"]],
                         ["1. repaired x + 1 = 2"])
        self.assertEqual(record["ocrSourceSha256"], sha(response))
        self.assertEqual(record["ocrRepairSourceSha256"], sha(candidate))
        self.assertEqual(record["ocrRepairProvider"], "openai")
        self.assertEqual(record["ocrRepairEngine"], "gpt-5.5")
        self.assertEqual(record["ocrRepairResolvedEngine"], "gpt-5.5")
        self.assertEqual(record["displayTruth"], "original-pdf-crop")

        resumed = mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)
        self.assertEqual(resumed["pagesWritten"], 0)
        self.assertEqual(resumed["pagesSkipped"], 1)
        report = audit_index.audit(root / "work", ocr_root, catalog, 1, 1)
        self.assertEqual(report["totals"]["verifiedDropoutRepairs"], 1)
        self.assertEqual(report["repairProviders"], {"openai": 1})

    def test_repair_with_wrong_page_binding_is_rejected(self):
        root, pdf, catalog, ocr_root, response = self.fixture()
        candidate, _ = self.add_openai_repair(pdf, ocr_root, response)
        payload = json.loads(candidate.read_text(encoding="utf-8"))
        payload["sourcePageNumber"] = 2
        candidate.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaises(mistral.MistralIndexError):
            mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)

    def test_repair_candidate_change_invalidates_resume(self):
        root, pdf, catalog, ocr_root, response = self.fixture()
        candidate, raw_file = self.add_openai_repair(pdf, ocr_root, response)
        mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)
        raw = json.loads(raw_file.read_text(encoding="utf-8"))
        structured = json.loads(raw["output"][0]["content"][0]["text"])
        structured["qualityWarnings"] = ["manual-review-required"]
        raw["output"][0]["content"][0]["text"] = json.dumps(structured)
        raw_file.write_text(json.dumps(raw), encoding="utf-8")
        payload = json.loads(candidate.read_text(encoding="utf-8"))
        payload["qualityWarnings"] = structured["qualityWarnings"]
        payload["rawResponseSha256"] = sha(raw_file)
        candidate.write_text(json.dumps(payload), encoding="utf-8")
        rerun = mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)
        self.assertEqual(rerun["pagesWritten"], 1)
        self.assertEqual(rerun["pagesSkipped"], 0)

    def test_missing_repair_provenance_field_invalidates_resume(self):
        root, pdf, catalog, ocr_root, response = self.fixture()
        self.add_openai_repair(pdf, ocr_root, response)
        mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)
        record_file = root / "work" / "test-book" / "pages" / "p0001.json"
        record = json.loads(record_file.read_text(encoding="utf-8"))
        del record["ocrRepairResolvedEngine"]
        record_file.write_text(json.dumps(record), encoding="utf-8")
        rerun = mistral.index_book(pdf, "test-book", ocr_root, root / "work", catalog)
        self.assertEqual(rerun["pagesWritten"], 1)
        self.assertEqual(rerun["pagesSkipped"], 0)


if __name__ == "__main__":
    unittest.main()
