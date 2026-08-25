import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "attach_google_document_ai", ROOT / "scripts" / "ingest" / "attach-google-document-ai.py"
)
google = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(google)


class GoogleDocumentAiAttachTests(unittest.TestCase):
    def response(self):
        return {
            "_mathaSource": {"sha256": "a" * 64, "processor": "projects/p/processors/x"},
            "document": {
                "text": "題目 x^2\n",
                "pages": [{
                    "dimension": {"width": 100, "height": 200},
                    "lines": [{"layout": {
                        "textAnchor": {"textSegments": [{"endIndex": "7"}]},
                        "confidence": .98,
                        "boundingPoly": {"vertices": [{"x": 10, "y": 20}, {"x": 90, "y": 40}]},
                    }}],
                    "visualElements": [{"type": "math_formula", "layout": {
                        "textAnchor": {"textSegments": [{"startIndex": "3", "endIndex": "6"}]},
                        "confidence": .95,
                        "boundingPoly": {"normalizedVertices": [
                            {"x": .3, "y": .1}, {"x": .6, "y": .2},
                        ]},
                    }}],
                    "imageQualityScores": {"qualityScore": .91},
                }],
            },
        }

    def test_converts_exact_source_with_geometry_and_math(self):
        page = {"imageSha256": "a" * 64, "width": 100, "height": 200}
        result = google.convert_response(self.response(), page)
        self.assertEqual(result["lines"][0]["bbox"], [10, 20, 90, 40])
        self.assertEqual(result["lines"][0]["text"], "題目 x^2")
        self.assertEqual(result["mathElements"][0]["bbox"], [30, 20, 60, 40])
        self.assertEqual(result["qualityScore"], .91)

    def test_rejects_a_result_from_any_other_page_image(self):
        page = {"imageSha256": "b" * 64, "width": 100, "height": 200}
        with self.assertRaisesRegex(google.AttachError, "SHA-256"):
            google.convert_response(self.response(), page)

    def test_rejects_dimension_drift(self):
        page = {"imageSha256": "a" * 64, "width": 101, "height": 200}
        with self.assertRaisesRegex(google.AttachError, "dimensions"):
            google.convert_response(self.response(), page)


if __name__ == "__main__":
    unittest.main()
