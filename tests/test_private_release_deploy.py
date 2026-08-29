import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "private_release_deploy",
    ROOT / "scripts" / "ingest" / "deploy-private-release.py",
)
deploy = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(deploy)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class PrivateReleaseDeployTests(unittest.TestCase):
    def fixture(self, root: Path):
        content = root / "matha-content"
        figures = root / "matha-figures"
        versioned = content / "releases" / "starter-12345678" / "content" / "pack.json"
        alias = content / "manifest-mistral-ocr4-verified-v1.json"
        figure = figures / "releases" / "starter-12345678" / "stems" / "q.png"
        for path, data in ((versioned, b"pack"), (alias, b"new-manifest"),
                           (figure, b"pixels")):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        plan = root / "upload-plan.json"
        plan.write_text(json.dumps({
            "kind": "matha-private-storage-upload-plan", "version": 1,
            "releaseReady": True, "uploadPerformed": False,
            "releaseId": "starter-12345678",
            "manifestAlias": alias.name,
            "buckets": {
                "matha-content": {"root": str(content), "files": [
                    {"path": versioned.relative_to(content).as_posix(),
                     "sha256": digest(b"pack"), "bytes": 4},
                    {"path": alias.name, "sha256": digest(b"new-manifest"),
                     "bytes": len(b"new-manifest")},
                ]},
                "matha-figures": {"root": str(figures), "files": [
                    {"path": figure.relative_to(figures).as_posix(),
                     "sha256": digest(b"pixels"), "bytes": 6},
                ]},
            },
        }), encoding="utf-8")
        return plan

    @staticmethod
    def backend(store):
        def download(_url, _key, bucket, path):
            return store.get((bucket, path))

        def upload(_url, _key, bucket, path, data, *, upsert):
            key = (bucket, path)
            if not upsert and key in store:
                raise AssertionError("immutable object unexpectedly overwritten")
            store[key] = data
        return download, upload

    def test_alias_switch_happens_last_and_exact_record_can_rollback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.fixture(root)
            alias_key = ("matha-content", "manifest-mistral-ocr4-verified-v1.json")
            store = {alias_key: b"old-manifest"}
            download, upload = self.backend(store)
            record = root / "deployment.json"
            result = deploy.deploy(
                plan, record, "https://project.supabase.co", "s" * 40,
                digest(b"old-manifest"), download, upload,
            )
            self.assertEqual(store[alias_key], b"new-manifest")
            self.assertEqual(result["objects"], 2)
            saved = record.read_text("utf-8")
            self.assertNotIn("s" * 40, saved)
            rollback_record = root / "rollback.json"
            deploy.rollback(
                record, rollback_record, "https://project.supabase.co", "s" * 40,
                download, upload,
            )
            self.assertEqual(store[alias_key], b"old-manifest")
            self.assertTrue(rollback_record.is_file())

    def test_changed_immutable_object_or_newer_alias_refuses_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.fixture(root)
            alias_key = ("matha-content", "manifest-mistral-ocr4-verified-v1.json")
            pack_key = ("matha-content", "releases/starter-12345678/content/pack.json")
            store = {alias_key: b"old-manifest", pack_key: b"different"}
            download, upload = self.backend(store)
            with self.assertRaises(deploy.DeploymentError):
                deploy.deploy(
                    plan, root / "record.json", "https://project.supabase.co",
                    "s" * 40, None, download, upload,
                )
            self.assertEqual(store[alias_key], b"old-manifest")

    def test_plan_and_records_must_stay_hash_bound_and_private(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.outside_repo(ROOT / "deployment.json")
        self.assertIn("%E9%A1%8C", deploy.object_url(
            "https://project.supabase.co", "matha-content", "releases/題.json"
        ))


if __name__ == "__main__":
    unittest.main()
