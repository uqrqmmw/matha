import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "private_release_bundle",
    ROOT / "scripts" / "ingest" / "assemble-private-release.py",
)
bundle = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(bundle)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class PrivateReleaseBundleTests(unittest.TestCase):
    def test_bundle_keeps_every_release_object_versioned_and_alias_bytes_exact(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            release_id = "starter-test1234"
            book_id = "matha-114-real-number-line"
            question_id = "starter-release-test-1"
            pixels = b"verified-png-pixels"
            asset_path = (
                f"releases/{release_id}/stems/{book_id}/{question_id}-{digest(pixels)[:16]}.png"
            )
            promotion = root / "promotion"
            promoted_asset = promotion / "promoted" / book_id / "stem-assets" / asset_path
            promoted_asset.parent.mkdir(parents=True)
            promoted_asset.write_bytes(pixels)
            source = root / "signed-source.json"
            source.write_text(json.dumps({
                "schema": 3, "kind": "private-question-source",
                "releaseId": release_id,
                "corpusGeneration": "mistral-ocr4-verified-v1",
                "sourceInventorySha256": "c0cedf6b71917211fce887f002978b1180ee661e86f16885e1625c34e5f9fc96",
                "sourceDocuments": 25, "sourcePages": 6720,
                "ocrProvider": "mistral", "ocrModel": "mistral-ocr-latest",
                "verificationPolicy": "pdf-crop-and-answer-review-v1",
                "originalPdfVerified": True, "answerKeyVerified": True,
                "mathematicalCorrectnessVerified": True,
                "reviewedBy": "王小明 / 陳老師", "releaseApprovedBy": "林老師",
                "reviewAudit": {"sourceQuestionCount": 1, "approvedQuestionCount": 1,
                                "completedAt": "2026-08-29T12:00:00+08:00"},
                "questions": [{
                    "id": question_id, "topic": "num", "type": "fill", "diff": 2,
                    "q": "完整題目請見原題裁圖。", "ans": ["1"], "sol": "官方答案：1",
                    "src": "實數與數線上的幾何｜PDF 第 12 頁",
                    "bookId": book_id, "page": 12, "role": "example",
                    "displayTruth": "original-pdf-crop", "needsStemAsset": True,
                    "stemAsset": {
                        "path": asset_path, "sha256": digest(pixels),
                        "sourcePdfSha256": "018659d0af52c6464863f5088c29fe8ce0638193faddd2c361a3695687bd5f7b",
                        "pageIndex": 12, "bbox": [0, 0.1, 1, 0.2],
                        "role": "question-stem", "assetStatus": "verified",
                        "mime": "image/png", "width": 1200, "height": 300,
                        "containsAnswer": False, "containsSolution": False,
                        "containsHandwriting": False, "includesOptions": False,
                        "questionIds": [question_id], "bookId": book_id,
                        "producer": "YesScanner handwriting-remover v2",
                        "verifier": {"reviewer": "王小明", "reviewVersion": 2,
                                     "questionRoleVerified": True, "safetyVerified": True,
                                     "assetHashVerified": True, "fullStemVerified": True,
                                     "optionsVerified": True,
                                     "verifiedAt": "2026-08-29T10:00:00+08:00"},
                    },
                }],
            }), encoding="utf-8")
            output = root / "bundle"
            result = bundle.assemble(source, promotion, output)
            self.assertEqual(result["releaseId"], release_id)
            plan = json.loads((output / "upload-plan.json").read_text("utf-8"))
            content_paths = [row["path"] for row in plan["buckets"]["matha-content"]["files"]]
            versioned_manifest = plan["versionedManifest"]
            self.assertIn(versioned_manifest, content_paths)
            self.assertRegex(
                versioned_manifest,
                rf"^releases/{release_id}/manifests/manifest-[a-f0-9]{{16}}\.json$",
            )
            self.assertIn(bundle.MANIFEST_ALIAS, content_paths)
            pending_paths = [path for path in content_paths if "/pending-visuals-" in path]
            self.assertEqual(len(pending_paths), 1)
            self.assertRegex(pending_paths[0], r"/pending-visuals-[a-f0-9]{16}\.json$")
            self.assertTrue(all(
                path == bundle.MANIFEST_ALIAS or path.startswith(f"releases/{release_id}/")
                for path in content_paths
            ))
            self.assertEqual(
                (output / "matha-content" / bundle.MANIFEST_ALIAS).read_bytes(),
                (output / "matha-content" / versioned_manifest).read_bytes(),
            )
            manifest = json.loads(
                (output / "matha-content" / bundle.MANIFEST_ALIAS).read_text("utf-8")
            )
            self.assertEqual(manifest["releaseId"], release_id)
            self.assertTrue(all(
                pack["file"].startswith(f"releases/{release_id}/content/")
                for pack in manifest["packs"]
            ))


if __name__ == "__main__":
    unittest.main()
