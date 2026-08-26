import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "promote_reviewed_stems", ROOT / "scripts" / "ingest" / "promote-reviewed-stems.py")
promotion = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(promotion)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class StemPromotionTests(unittest.TestCase):
    def fixture(self):
        root = Path(tempfile.mkdtemp(prefix="matha-stem-promotion-"))
        book_id = "test-original-crop-book"
        pdf = root / "source.pdf"
        document = fitz.open()
        page = document.new_page(width=100, height=200)
        page.insert_text((8, 24), "1. x + 1 = 2")
        page.insert_text((8, 48), "(1) 0   (2) 1   (3) 2")
        document.save(pdf)
        document.close()
        pdf_hash = sha(pdf)

        catalog = root / "catalog.json"
        catalog.write_text(json.dumps({"books": [{"id": book_id, "pdfSha256": pdf_hash}]}), encoding="utf-8")
        book_dir = root / "work" / book_id
        (book_dir / "pages").mkdir(parents=True)
        (book_dir / "crops" / "q1").mkdir(parents=True)
        page_index = {"kind": "textbook-page-index", "bookId": book_id, "pdfSha256": pdf_hash,
                      "pdfPage": 1, "dpi": 144, "width": 200, "height": 400}
        (book_dir / "pages" / "p0001.json").write_text(json.dumps(page_index), encoding="utf-8")
        region = [0, 0, 200, 140]
        source = fitz.open(pdf)
        pixmap = source[0].get_pixmap(dpi=300, clip=promotion.pdf_rect(region, 144), alpha=False)
        crop = book_dir / "crops" / "q1" / "stem.png"
        pixmap.save(crop)
        source.close()

        source_file = root / "reviewed-qpack.json"
        source_payload = {
            "kind": "private-question-source", "schema": 1, "bookId": book_id,
            "pdfSha256": pdf_hash, "reviewedBy": "question-reviewer",
            "questions": [{"id": "q1", "topic": "num", "type": "single", "diff": 1,
                           "q": "index only", "opts": ["0", "1", "2"], "ans": [1],
                           "bookId": book_id, "page": 1, "src": f"{book_id} p1",
                           "displayTruth": "original-pdf-crop", "needsStemAsset": True}],
        }
        source_file.write_text(json.dumps(source_payload), encoding="utf-8")
        crop_manifest = book_dir / "crops-manifest.json"
        crop_manifest.write_text(json.dumps({
            "schema": 11, "kind": "textbook-crop-manifest", "bookId": book_id,
            "pdfSha256": pdf_hash, "cropDpi": 300,
            "crops": {"q1": {"stemRegion": region, "figures": 0, "answer": True}},
        }), encoding="utf-8")
        review_file = root / "independent-review.json"
        review_payload = {
            "kind": "matha-private-stem-independent-review", "version": 1,
            "reviewer": "independent-auditor", "reviewedAt": "2026-08-26T12:00:00+08:00",
            "sourceSha256": sha(source_file), "cropManifestSha256": sha(crop_manifest),
            "summary": {"passed": 1, "failed": 0},
            "questions": [{
                "id": "q1", "decision": "pass", "cropSha256": sha(crop),
                "integrity": {"sourcePdfHash": True, "cropHash": True, "cropPixelsMatchPdf": True,
                              "bookPageQuestionBinding": True},
                "visual": {"fullStemVerified": True, "allOptionsVerified": True,
                           "containsAnswer": False, "containsSolution": False,
                           "containsHandwriting": False, "containsAdjacentQuestion": False},
            }],
        }
        review_file.write_text(json.dumps(review_payload), encoding="utf-8")
        return {"root": root, "source": source_file, "book_dir": book_dir, "pdf": pdf,
                "manifest": crop_manifest, "review": review_file, "catalog": catalog,
                "output": root / "output", "review_payload": review_payload, "crop": crop}

    def test_only_exact_original_crop_with_independent_review_is_promoted(self):
        fx = self.fixture()
        result = promotion.promote(fx["source"], fx["book_dir"], fx["pdf"], fx["manifest"],
                                   fx["review"], fx["output"], fx["catalog"])
        self.assertEqual(result["questions"], 1)
        output = json.loads(Path(result["sourceOutput"]).read_text(encoding="utf-8"))
        question = output["questions"][0]
        self.assertNotIn("needsStemAsset", question)
        asset = question["stemAsset"]
        self.assertEqual(asset["role"], "question-stem")
        self.assertEqual(asset["sourcePdfSha256"], sha(fx["pdf"]))
        self.assertTrue(asset["includesOptions"])
        self.assertTrue(asset["verifier"]["fullStemVerified"])
        self.assertEqual(asset["producer"], "question-reviewer")
        self.assertEqual(asset["verifier"]["reviewer"], "independent-auditor")
        self.assertEqual(sha(Path(result["assetRoot"]) / asset["path"]), asset["sha256"])

    def test_incomplete_visual_review_is_rejected(self):
        fx = self.fixture()
        fx["review_payload"]["questions"][0]["visual"]["fullStemVerified"] = False
        fx["review"].write_text(json.dumps(fx["review_payload"]), encoding="utf-8")
        with self.assertRaises(promotion.PromotionError):
            promotion.promote(fx["source"], fx["book_dir"], fx["pdf"], fx["manifest"],
                              fx["review"], fx["output"], fx["catalog"])

    def test_tampered_crop_pixels_are_rejected_even_if_review_claims_pass(self):
        fx = self.fixture()
        crop = fitz.Pixmap(str(fx["crop"]))
        crop.set_pixel(0, 0, (0, 0, 0))
        crop.save(fx["crop"])
        fx["review_payload"]["questions"][0]["cropSha256"] = sha(fx["crop"])
        fx["review"].write_text(json.dumps(fx["review_payload"]), encoding="utf-8")
        with self.assertRaises(promotion.PromotionError):
            promotion.promote(fx["source"], fx["book_dir"], fx["pdf"], fx["manifest"],
                              fx["review"], fx["output"], fx["catalog"])


if __name__ == "__main__":
    unittest.main()
