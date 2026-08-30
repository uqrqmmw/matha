import importlib.util
import json
import tempfile
import unittest
from io import BytesIO
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
    def test_live_readback_downloads_manifest_bytes_without_serializing_key(self):
        class Response(BytesIO):
            def __enter__(self): return self
            def __exit__(self, *_): self.close()

        seen = []
        def opener(request, timeout):
            seen.append((request.full_url, request.headers, timeout))
            return Response(b"verified page")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "fresh"
            expected = {"official-115-matha/page 1.png": {}}
            storage.download_assets(
                expected, root, project_ref="exampleprojectref123",
                bucket="matha-papers", npx="npx",
                key_loader=lambda *_: "private-read-key", opener=opener,
            )
            self.assertEqual(
                (root / "official-115-matha" / "page 1.png").read_bytes(),
                b"verified page",
            )
            self.assertIn("page%201.png", seen[0][0])
            self.assertEqual(seen[0][2], 180)
            self.assertFalse(any("private-read-key" in str(path) for path in root.rglob("*")))

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

    def test_live_readback_refuses_nonempty_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "old-cache").write_text("stale", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "must be empty"):
                storage.download_assets(
                    {"official-115-matha/page.png": {}}, root,
                    project_ref="exampleprojectref123", bucket="matha-papers", npx="npx",
                    key_loader=lambda *_: "private-read-key",
                    opener=lambda *_args, **_kwargs: None,
                )

    def test_live_readback_retries_transient_failure_without_accepting_partial(self):
        class Response(BytesIO):
            def __enter__(self): return self
            def __exit__(self, *_): self.close()

        calls = 0
        def opener(_request, timeout):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise TimeoutError("transient")
            self.assertEqual(timeout, 180)
            return Response(b"complete")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "fresh"
            storage.download_assets(
                {"official-115-matha/page.png": {}}, root,
                project_ref="exampleprojectref123", bucket="matha-papers", npx="npx",
                key_loader=lambda *_: "private-read-key", opener=opener,
                retry_delays=(0,),
            )
            self.assertEqual(calls, 2)
            self.assertEqual((root / "official-115-matha" / "page.png").read_bytes(), b"complete")
            self.assertFalse(list(root.rglob("*.part")))


if __name__ == "__main__":
    unittest.main()
