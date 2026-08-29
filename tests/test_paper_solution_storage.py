import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "verify_paper_solution_storage",
    ROOT / "scripts" / "verify-paper-solution-storage.py",
)
storage = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(storage)


class PaperSolutionStorageTests(unittest.TestCase):
    def test_expected_assets_requires_twenty_bound_questions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "manifest.json"
            path.write_text(json.dumps({
                "kind": "matha-private-paper-solution-assets-v1",
                "paperCount": 1, "assetCount": 1,
                "papers": [{"appSourceId": "paper-regional-a",
                            "assets": [{"file": "paper-regional-a/a.png"}],
                            "questionSolutionFiles": [["paper-regional-a/a.png"]] * 19}],
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "20 explicit bindings"):
                storage.expected_assets(path)

    def test_readback_must_match_remote_names_hashes_and_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / "paper-regional-a"
            folder.mkdir()
            page = folder / "a.png"
            page.write_bytes(b"verified")
            relative = "paper-regional-a/a.png"
            expected = {relative: {"sha256": storage.sha256(page), "bytes": 8}}
            remote = {"paper-regional-a": ["a.png"]}
            self.assertEqual(storage.verify_readback(expected, root, remote)[0]["file"], relative)
            page.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                storage.verify_readback(expected, root, remote)


if __name__ == "__main__":
    unittest.main()
