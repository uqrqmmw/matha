import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fitz
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "starter_private_release",
    ROOT / "scripts" / "ingest" / "prepare-starter-private-release.py",
)
release = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(release)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


class StarterPrivateReleaseTests(unittest.TestCase):
    def fixture(self, root: Path):
        pdf_root = root / "pdfs"
        pdf_root.mkdir()
        pdf = pdf_root / "book.pdf"
        document = fitz.open()
        document.new_page(width=600, height=800)
        document.save(pdf)
        document.close()
        cleaned = root / "cleaned.png"
        answer = root / "answer.png"
        source = root / "source.png"
        Image.new("RGB", (500, 220), "white").save(cleaned)
        Image.new("RGB", (400, 160), "white").save(answer)
        Image.new("RGB", (500, 220), "white").save(source)
        question_id = "book-a-p001-q1"
        selection = root / "selection.json"
        write_json(selection, {
            "kind": "matha-cleaned-starter-review-selection",
            "releaseAuthority": False,
            "items": [{
                "id": question_id, "bookId": "book-a", "pdfPage": 1,
                "topic": "num", "role": "chapter-end-medium",
                "sourceSha256": sha(source), "cleanedSha256": sha(cleaned),
                "answerSha256": sha(answer), "sourcePath": str(source),
                "cleanedPath": str(cleaned), "answerPath": str(answer),
            }],
        })
        dual = root / "dual.json"
        write_json(dual, {
            "kind": "matha-private-cleaned-dual-review-candidates", "version": 1,
            "releaseAuthority": False, "humanReleaseSignoffStillRequired": True,
            "uploadPerformed": False, "pixelReviewer": "王小明",
            "pixelReviewedAt": "2026-08-29T10:00:00+08:00",
            "answerReviewer": "陳老師",
            "answerReviewedAt": "2026-08-29T10:30:00+08:00",
            "items": [{
                "id": question_id, "bookId": "book-a", "pdfPage": 1,
                "stemRegion": [0, 0, 500, 220], "cleaned": str(cleaned),
                "cleanedSha256": sha(cleaned), "answerSha256": sha(answer),
                "sourcePdfSha256": sha(pdf), "answerPdfPage": 1,
                "answerSource": "answer-key",
                "structuredAnswer": {"schema": 1, "mode": "single",
                                     "optionCount": 5,
                                     "correctOptionNumbers": [2]},
            }],
        })
        trusted = {
            "generation": "mistral-ocr4-verified-v1",
            "sourceInventorySha256": "a" * 64,
            "sourceDocuments": 1, "sourcePages": 1,
            "ocrProvider": "mistral", "ocrModel": "mistral-ocr-latest",
            "verificationPolicy": "pdf-crop-and-answer-review-v1",
        }
        catalog = {"book-a": {
            "id": "book-a", "title": "測試教材", "file": "book.pdf",
            "pdfSha256": sha(pdf), "topics": ["num"],
        }}
        return dual, selection, pdf_root, trusted, catalog

    def test_prepare_builds_image_first_source_and_exact_visual_signoff_packet(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dual, selection, pdf_root, trusted, catalog = self.fixture(root)
            output = root / "prepared"
            with mock.patch.object(release, "load_catalog", return_value=(trusted, catalog)):
                packet = release.prepare([dual], selection, pdf_root, output)
            self.assertFalse(packet["releaseAuthority"])
            self.assertEqual(packet["questions"], 1)
            self.assertEqual(packet["sampleSize"], 1)
            source = json.loads((output / "unsigned-private-question-source.json").read_text("utf-8"))
            question = source["questions"][0]
            self.assertEqual(question["type"], "single")
            self.assertEqual(question["ans"], [1])
            self.assertEqual(len(question["opts"]), 5)
            self.assertTrue(question["stemAsset"]["path"].startswith("releases/starter-"))
            self.assertEqual(question["stemAsset"]["verifier"]["reviewer"], "王小明")
            html = (output / "release-review.html").read_text("utf-8")
            script = html.rsplit("<script>", 1)[1].split("</script>", 1)[0]
            js = root / "review.js"
            js.write_text(script, encoding="utf-8")
            checked = subprocess.run(
                ["node", "--check", str(js)], capture_output=True,
                text=True, encoding="utf-8",
            )
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_finalize_requires_exact_named_human_hash_bound_sample(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dual, selection, pdf_root, trusted, catalog = self.fixture(root)
            prepared = root / "prepared"
            with mock.patch.object(release, "load_catalog", return_value=(trusted, catalog)):
                packet = release.prepare([dual], selection, pdf_root, prepared)
            signoff = prepared / "signoff.json"
            sample = packet["sampleQuestionIds"]
            write_json(signoff, {
                "kind": "matha-starter-private-release-signoff", "version": 1,
                "releaseAuthority": True, "approvedBy": "林老師",
                "approvedAt": "2026-08-29T11:00:00+08:00",
                "statement": release.SIGNOFF_STATEMENT,
                "releaseId": packet["releaseId"],
                "unsignedSourceSha256": packet["unsignedSourceSha256"],
                "assetManifestSha256": packet["assetManifestSha256"],
                "selectionSha256": packet["selectionSha256"],
                "dualReviewSha256": packet["dualReviewSha256"],
                "sampleQuestionIds": sample,
                "sampleChecks": [{
                    "id": question_id, "questionPixelsVerified": True,
                    "answerBindingVerified": True, "structuredAnswerVerified": True,
                } for question_id in sample],
            })
            signed = prepared / "signed.json"
            result = release.finalize(
                prepared / "unsigned-private-question-source.json",
                prepared / "asset-manifest.json", signoff, signed,
            )
            self.assertEqual(result["approvedBy"], "林老師")
            self.assertEqual(json.loads(signed.read_text("utf-8"))["releaseApprovedBy"], "林老師")
            bad = json.loads(signoff.read_text("utf-8"))
            bad["approvedBy"] = "Codex Agent"
            write_json(signoff, bad)
            with self.assertRaises(release.StarterReleaseError):
                release.finalize(
                    prepared / "unsigned-private-question-source.json",
                    prepared / "asset-manifest.json", signoff, prepared / "bad.json",
                )

    def test_missing_structured_answer_and_repo_output_fail_closed(self):
        self.assertRaises(
            release.StarterReleaseError, release.normalize_answer, None, "q-1"
        )
        with self.assertRaises(release.StarterReleaseError):
            release.outside_repo(ROOT / "private-release")


if __name__ == "__main__":
    unittest.main()
