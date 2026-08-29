import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "verify_official_paper_storage",
    ROOT / "scripts" / "verify-official-paper-storage.py",
)
storage = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(storage)


class OfficialPaperStorageTests(unittest.TestCase):
    def test_readback_requires_exact_remote_names_and_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            page = root / "official-115-matha" / "page.png"
            page.parent.mkdir()
            page.write_bytes(b"verified page")
            expected = {
                "official-115-matha/page.png": {
                    "sha256": storage.sha256(page), "bytes": page.stat().st_size,
                }
            }
            result = storage.verify_readback(
                expected, root, {"official-115-matha": ["page.png"]}
            )
            self.assertEqual(result[0]["sha256"], storage.sha256(page))
            with self.assertRaisesRegex(ValueError, "remote listing mismatch"):
                storage.verify_readback(expected, root, {"official-115-matha": []})
            page.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                storage.verify_readback(
                    expected, root, {"official-115-matha": ["page.png"]}
                )

    def test_manifest_requires_explicit_question_pages(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "manifest.json"
            path.write_text(json.dumps({
                "kind": "matha-official-paper-assets-v1",
                "paperCount": 1,
                "assetCount": 3,
                "papers": [],
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "asset count"):
                storage.expected_assets(path)


if __name__ == "__main__":
    unittest.main()
