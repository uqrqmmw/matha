import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "prepare_official_paper_assets",
    ROOT / "scripts" / "prepare-official-paper-assets.py",
)
assets = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(assets)


class OfficialPaperAssetTests(unittest.TestCase):
    def test_build_plan_uses_only_explicit_private_app_papers(self):
        inventory = {
            "sourceDocuments": [{
                "id": "q", "pathHint": "%DESKTOP%/數學檔案/完整模考來源/q.pdf",
                "sha256": "0" * 64, "pages": 4,
            }],
            "papers": [{
                "id": "regional-a", "appSourceId": "paper-regional-a",
                "paperClass": "regional-mock", "title": "A", "questions": 20,
                "minutes": 100, "privateAppEligible": True, "questionSource": "q",
                "questionPdfPages": [1, 2, 3], "questionPageMap": [1] * 20,
            }, {
                "id": "seen", "title": "seen", "questions": 20, "minutes": 100,
                "privateAppEligible": False,
            }],
        }
        plan = assets.build_plan(inventory, Path("C:/private"))
        self.assertEqual([row["paperId"] for row in plan], ["regional-a"])
        self.assertEqual(plan[0]["questionPdfPages"], [1, 2, 3])

    def test_build_plan_fails_closed_when_a_required_source_is_missing(self):
        papers = [
            {"id": paper_id, "appSourceId": paper_id, "title": paper_id,
             "questions": 20, "minutes": 100, "privateAppEligible": True,
             "questionSource": paper_id + "-question",
             "questionPdfPages": [1], "questionPageMap": [1] * 20}
            for paper_id in ("paper-a", "paper-b")
        ]
        with self.assertRaisesRegex(RuntimeError, "question source is missing"):
            assets.build_plan({"papers": papers, "sourceDocuments": []}, Path("C:/private"))

    def test_png_dimensions_requires_png_signature_and_reads_ihdr(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "page.png"
            path.write_bytes(
                b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" +
                struct.pack(">II", 1488, 2105)
            )
            self.assertEqual(assets.png_dimensions(path), (1488, 2105))
            path.write_bytes(b"not-png")
            with self.assertRaisesRegex(RuntimeError, "not a valid PNG"):
                assets.png_dimensions(path)

    def test_existing_assets_are_hash_and_dimension_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "paper").mkdir()
            page = root / "paper" / "page.png"
            page.write_bytes(
                b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" +
                struct.pack(">II", 100, 200)
            )
            manifest = {
                "kind": "matha-official-paper-assets-v1",
                "papers": [{"assets": [{
                    "file": "paper/page.png", "sha256": assets.sha256(page),
                    "width": 100, "height": 200,
                }]}],
            }
            (root / "official-paper-assets.json").write_text(
                json.dumps(manifest), encoding="utf-8"
            )
            self.assertEqual(assets.verify_existing(root)["kind"], manifest["kind"])
            page.write_bytes(page.read_bytes() + b"changed")
            with self.assertRaisesRegex(RuntimeError, "asset mismatch"):
                assets.verify_existing(root)


if __name__ == "__main__":
    unittest.main()
