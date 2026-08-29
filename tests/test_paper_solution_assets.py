import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "prepare_paper_solution_assets",
    ROOT / "scripts" / "prepare-paper-solution-assets.py",
)
assets = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(assets)


class PaperSolutionAssetTests(unittest.TestCase):
    def inventory(self):
        return {
            "sourceDocuments": [{
                "id": "s", "pathHint": "%DESKTOP%/數學檔案/完整模考來源/s.pdf",
                "sha256": "0" * 64, "pages": 2,
            }],
            "papers": [{
                "id": "regional-a", "appSourceId": "paper-regional-a",
                "paperClass": "regional-mock", "title": "A", "questions": 20,
                "minutes": 100, "privateAppEligible": True, "solutionSource": "s",
                "solutionPdfPages": [1, 2],
                "solutionQuestionPageMap": [[1]] * 19 + [[1, 2]],
            }, {
                "id": "official", "paperClass": "official-exam",
                "privateAppEligible": True,
            }],
        }

    def test_build_plan_is_regional_only_and_keeps_cross_page_binding(self):
        plan = assets.build_plan(self.inventory(), Path("C:/private"))
        self.assertEqual([row["paperId"] for row in plan], ["regional-a"])
        self.assertEqual(plan[0]["solutionQuestionPageMap"][-1], [1, 2])

    def test_build_plan_fails_closed_on_incomplete_question_map(self):
        inventory = self.inventory()
        inventory["papers"][0]["solutionQuestionPageMap"] = [[1]] * 19
        with self.assertRaisesRegex(RuntimeError, "question page map is invalid"):
            assets.build_plan(inventory, Path("C:/private"))

    def test_existing_assets_are_hash_dimension_and_binding_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "paper-regional-a").mkdir()
            page = root / "paper-regional-a" / "page.png"
            page.write_bytes(
                b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" +
                struct.pack(">II", 100, 200)
            )
            rel = "paper-regional-a/page.png"
            manifest = {"kind": assets.KIND, "papers": [{
                "paperId": "regional-a",
                "assets": [{"file": rel, "sha256": assets.sha256(page),
                            "width": 100, "height": 200}],
                "questionSolutionFiles": [[rel]] * 20,
            }]}
            (root / assets.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
            self.assertEqual(assets.verify_existing(root)["kind"], assets.KIND)
            manifest["papers"][0]["questionSolutionFiles"][0] = ["missing.png"]
            (root / assets.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "binding mismatch"):
                assets.verify_existing(root)


if __name__ == "__main__":
    unittest.main()
