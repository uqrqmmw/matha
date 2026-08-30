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
    URL = "https://rrihysbxhsbxjteqmtdu.supabase.co"

    def fixture(self, root: Path):
        content = root / "matha-content"
        figures = root / "matha-figures"
        release_id = "starter-12345678"
        release_root = Path("releases") / release_id
        versioned_manifest = content / release_root / "manifest.json"
        alias = content / "manifest-mistral-ocr4-verified-v1.json"
        pending = content / release_root / "content" / "pending-visuals.json"
        source = root / "signed-private-question-source.json"
        source.write_text(json.dumps({
            "schema": 3,
            "kind": "private-question-source",
            "releaseId": release_id,
            "releaseApprovedBy": "uqrqmmw",
            "reviewPolicy": deploy.EXPECTED_REVIEW_POLICY,
            **deploy.EXPECTED_CORPUS,
            "questions": [{"id": f"q-{index:03d}"} for index in range(1, 218)],
        }), encoding="utf-8")
        content_rows = []
        figure_rows = []

        def add(root_dir, path, data, rows, **extra):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            rows.append({
                "path": path.relative_to(root_dir).as_posix(),
                "sha256": digest(data), "bytes": len(data), **extra,
            })

        add(content, versioned_manifest, b"new-manifest", content_rows)
        add(content, pending, b"{}", content_rows)
        for index in range(1, 192):
            add(
                content,
                content / release_root / "content" / f"pack-{index:03d}.json",
                f"pack-{index}".encode(), content_rows,
            )
        add(content, alias, b"new-manifest", content_rows)
        for index in range(1, 218):
            add(
                figures,
                figures / release_root / "stems" / f"q-{index:03d}.png",
                f"pixels-{index}".encode(), figure_rows,
                questionId=f"q-{index:03d}",
            )
        plan = root / "upload-plan.json"
        plan.write_text(json.dumps({
            "kind": "matha-private-storage-upload-plan", "version": 1,
            "releaseReady": True, "uploadPerformed": False,
            "releaseId": release_id,
            "manifestAlias": alias.name,
            "versionedManifest": versioned_manifest.relative_to(content).as_posix(),
            "source": str(source), "sourceSha256": digest(source.read_bytes()),
            "releaseApprovedBy": "uqrqmmw",
            "summary": {"questions": 217, "contentFiles": 194, "stemAssets": 217},
            "buckets": {
                "matha-content": {"root": str(content), "files": content_rows},
                "matha-figures": {"root": str(figures), "files": figure_rows},
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
                plan, record, self.URL, "s" * 40,
                digest(b"old-manifest"), download, upload,
            )
            self.assertEqual(store[alias_key], b"new-manifest")
            self.assertEqual(result["objects"], 410)
            saved = record.read_text("utf-8")
            self.assertNotIn("s" * 40, saved)
            self.assertEqual(json.loads(saved)["state"], "deployed")
            rollback_record = root / "rollback.json"
            deploy.rollback(
                record, rollback_record, self.URL, "s" * 40,
                download, upload,
            )
            self.assertEqual(store[alias_key], b"old-manifest")
            self.assertTrue(rollback_record.is_file())

    def test_pre_switch_record_can_recover_an_uncertain_alias_request(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.fixture(root)
            alias_key = ("matha-content", "manifest-mistral-ocr4-verified-v1.json")
            store = {alias_key: b"old-manifest"}
            download, normal_upload = self.backend(store)

            def uncertain_upload(url, key, bucket, path, data, *, upsert):
                normal_upload(url, key, bucket, path, data, upsert=upsert)
                if upsert and (bucket, path) == alias_key:
                    raise deploy.DeploymentError("response lost after alias write")

            record = root / "deployment-uncertain.json"
            with self.assertRaises(deploy.DeploymentError):
                deploy.deploy(
                    plan, record, self.URL, "s" * 40,
                    digest(b"old-manifest"), download, uncertain_upload,
                )
            prepared = json.loads(record.read_text("utf-8"))
            self.assertEqual(prepared["state"], "switch-outcome-unknown")
            self.assertEqual(store[alias_key], b"new-manifest")

            rollback_record = root / "rollback-uncertain.json"
            deploy.rollback(
                record, rollback_record, self.URL, "s" * 40,
                download, normal_upload,
            )
            self.assertEqual(store[alias_key], b"old-manifest")

    def test_changed_immutable_object_or_newer_alias_refuses_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.fixture(root)
            alias_key = ("matha-content", "manifest-mistral-ocr4-verified-v1.json")
            pack_key = ("matha-content", "releases/starter-12345678/content/pack-001.json")
            store = {alias_key: b"old-manifest", pack_key: b"different"}
            download, upload = self.backend(store)
            with self.assertRaises(deploy.DeploymentError):
                deploy.deploy(
                    plan, root / "record.json", self.URL,
                    "s" * 40, digest(b"old-manifest"), download, upload,
                )
            self.assertEqual(store[alias_key], b"old-manifest")

    def test_formal_plan_contract_rejects_bad_alias_bucket_or_count_before_network(self):
        def wrong_alias(value):
            value["manifestAlias"] = "other-manifest.json"

        def extra_bucket(value):
            value["buckets"]["other"] = {"root": ".", "files": []}

        def missing_stem(value):
            value["buckets"]["matha-figures"]["files"].pop()

        for label, mutate in (
            ("wrong alias", wrong_alias),
            ("extra bucket", extra_bucket),
            ("missing stem", missing_stem),
        ):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                plan = self.fixture(root)
                value = json.loads(plan.read_text(encoding="utf-8"))
                mutate(value)
                plan.write_text(json.dumps(value), encoding="utf-8")
                calls = []

                def no_download(*args):
                    calls.append(("download", args))
                    raise AssertionError("invalid plan reached the network")

                def no_upload(*args, **kwargs):
                    calls.append(("upload", args, kwargs))
                    raise AssertionError("invalid plan reached the network")

                with self.assertRaises(deploy.DeploymentError):
                    deploy.deploy(
                        plan, root / "record.json", self.URL, "s" * 40,
                        digest(b"old-manifest"), no_download, no_upload,
                    )
                self.assertEqual(calls, [])

    def test_formal_plan_contract_supports_a_larger_hash_bound_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.fixture(root)
            value = json.loads(plan.read_text(encoding="utf-8"))
            source = Path(value["source"])
            source_value = json.loads(source.read_text(encoding="utf-8"))

            next_id = "q-218"
            source_value["questions"].append({"id": next_id})
            source.write_text(json.dumps(source_value), encoding="utf-8")
            value["sourceSha256"] = digest(source.read_bytes())

            figure_root = Path(value["buckets"]["matha-figures"]["root"])
            figure = figure_root / "releases" / value["releaseId"] / "stems" / f"{next_id}.png"
            figure.parent.mkdir(parents=True, exist_ok=True)
            figure.write_bytes(b"new-pixels")
            value["buckets"]["matha-figures"]["files"].append({
                "path": figure.relative_to(figure_root).as_posix(),
                "sha256": digest(figure.read_bytes()),
                "bytes": figure.stat().st_size,
                "questionId": next_id,
            })
            value["summary"]["questions"] = 218
            value["summary"]["stemAssets"] = 218
            plan.write_text(json.dumps(value), encoding="utf-8")

            parsed, versioned, _alias = deploy.validate_plan(plan)
            self.assertEqual(parsed["summary"]["questions"], 218)
            self.assertEqual(len(versioned), 411)

    def test_expected_previous_hash_is_required_before_network(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            calls = []

            def no_download(*args):
                calls.append(args)
                raise AssertionError("missing CAS hash reached the network")

            with self.assertRaisesRegex(deploy.DeploymentError, "required"):
                deploy.deploy(
                    self.fixture(root), root / "record.json", self.URL, "s" * 40,
                    None, no_download, lambda *_args, **_kwargs: None,
                )
            self.assertEqual(calls, [])

    def test_rollback_response_loss_is_resumable_after_alias_was_restored(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.fixture(root)
            alias_key = ("matha-content", deploy.EXPECTED_ALIAS)
            store = {alias_key: b"old-manifest"}
            download, normal_upload = self.backend(store)
            record = root / "deployment.json"
            deploy.deploy(
                plan, record, self.URL, "s" * 40,
                digest(b"old-manifest"), download, normal_upload,
            )

            def lost_response(url, key, bucket, path, data, *, upsert):
                normal_upload(url, key, bucket, path, data, upsert=upsert)
                raise deploy.DeploymentError("rollback response lost after write")

            rollback_record = root / "rollback.json"
            with self.assertRaises(deploy.DeploymentError):
                deploy.rollback(
                    record, rollback_record, self.URL, "s" * 40,
                    download, lost_response,
                )
            self.assertEqual(store[alias_key], b"old-manifest")
            self.assertEqual(
                json.loads(rollback_record.read_text(encoding="utf-8"))["state"],
                "rollback-outcome-unknown",
            )
            result = deploy.rollback(
                record, rollback_record, self.URL, "s" * 40,
                download, normal_upload,
            )
            self.assertEqual(result["state"], "rolled-back")
            self.assertTrue(result["alreadyRestored"])
            self.assertIsNotNone(result["rolledBackAt"])

    def test_rollback_can_record_an_exact_already_restored_alias_without_rewriting(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan = self.fixture(root)
            alias_key = ("matha-content", deploy.EXPECTED_ALIAS)
            store = {alias_key: b"old-manifest"}
            download, upload = self.backend(store)
            record = root / "deployment.json"
            deploy.deploy(
                plan, record, self.URL, "s" * 40,
                digest(b"old-manifest"), download, upload,
            )
            store[alias_key] = b"old-manifest"

            def no_upload(*_args, **_kwargs):
                raise AssertionError("already-restored alias was unnecessarily rewritten")

            result = deploy.rollback(
                record, root / "rollback.json", self.URL, "s" * 40,
                download, no_upload,
            )
            self.assertEqual(result["state"], "rolled-back")
            self.assertTrue(result["alreadyRestored"])

    def test_rollback_rejects_wrong_alias_or_illegal_state_before_network(self):
        for label, mutation in (
            ("wrong alias", lambda value: value["alias"].update(path="other.json")),
            ("illegal state", lambda value: value.update(state="restored-after-failed-switch")),
        ):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                plan = self.fixture(root)
                alias_key = ("matha-content", deploy.EXPECTED_ALIAS)
                store = {alias_key: b"old-manifest"}
                download, upload = self.backend(store)
                record = root / "deployment.json"
                deploy.deploy(
                    plan, record, self.URL, "s" * 40,
                    digest(b"old-manifest"), download, upload,
                )
                value = json.loads(record.read_text(encoding="utf-8"))
                mutation(value)
                record.write_text(json.dumps(value), encoding="utf-8")
                calls = []

                def no_download(*args):
                    calls.append(args)
                    raise AssertionError("invalid rollback record reached the network")

                with self.assertRaisesRegex(deploy.DeploymentError, "rollback-capable"):
                    deploy.rollback(
                        record, root / "rollback.json", self.URL, "s" * 40,
                        no_download, upload,
                    )
                self.assertEqual(calls, [])

    def test_plan_and_records_must_stay_hash_bound_and_private(self):
        with self.assertRaises(deploy.DeploymentError):
            deploy.outside_repo(ROOT / "deployment.json")
        self.assertIn("%E9%A1%8C", deploy.object_url(
            "https://project.supabase.co", "matha-content", "releases/題.json"
        ))

    def test_second_local_release_operation_is_locked_out(self):
        with deploy.deployment_lock(self.URL, deploy.EXPECTED_ALIAS):
            with self.assertRaisesRegex(deploy.DeploymentError, "another local"):
                with deploy.deployment_lock(self.URL, deploy.EXPECTED_ALIAS):
                    self.fail("a concurrent release unexpectedly acquired the same lock")

    def test_hash_wait_tolerates_stale_alias_reads(self):
        reads = iter((b"old", b"old", b"new"))
        pauses = deploy.time.sleep
        deploy.time.sleep = lambda _seconds: None
        try:
            value = deploy.wait_for_hash(
                lambda *_args: next(reads),
                "https://project.supabase.co", "s" * 40,
                "matha-content", "manifest.json", digest(b"new"), attempts=3,
            )
        finally:
            deploy.time.sleep = pauses
        self.assertEqual(value, b"new")

    def test_vendor_gateway_statuses_are_retryable(self):
        self.assertTrue(deploy.transient_http_status(544))
        self.assertTrue(deploy.transient_http_status(529))
        self.assertTrue(deploy.transient_http_status(503))
        self.assertFalse(deploy.transient_http_status(401))
        self.assertFalse(deploy.transient_http_status(404))

    def test_deploy_refuses_a_project_the_app_does_not_use(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(deploy.DeploymentError, "app.js"):
                deploy.deploy(
                    self.fixture(root), root / "record.json",
                    "https://other-project.supabase.co", "s" * 40,
                    "a" * 64, *self.backend({}),
                )

    def test_rollback_record_from_another_project_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            record = root / "deployment.json"
            record.write_text(json.dumps({
                "kind": "matha-private-storage-deployment", "version": 1,
                "state": "deployed", "rollbackAvailable": True,
                "projectUrl": "https://other-project.supabase.co",
                "alias": {"bucket": "matha-content", "path": "manifest.json",
                          "previousSha256": "a" * 64, "newSha256": "b" * 64,
                          "previousBytesBase64": "eA=="},
            }), encoding="utf-8")
            with self.assertRaisesRegex(deploy.DeploymentError, "rollback-capable"):
                deploy.rollback(record, root / "rollback.json", self.URL, "s" * 40)


if __name__ == "__main__":
    unittest.main()
