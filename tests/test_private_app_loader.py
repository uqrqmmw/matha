import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "private_app_loader",
    ROOT / "scripts" / "ingest" / "verify-private-app-loader.py",
)
loader = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(loader)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class FakeBackend:
    def __init__(self, store, *, approved=True, deny_download=False):
        self.store = store
        self.approved = approved
        self.deny_download = deny_download
        self.signed_calls = []
        self.direct_calls = []
        self.session_calls = 0

    def session(self, _url, _publishable, access_token, _service_key):
        self.session_calls += 1
        if not self.approved:
            raise loader.AppLoaderVerificationError(
                "authenticated user is not enabled for matha"
            )
        if not access_token:
            raise loader.AppLoaderVerificationError("test requires a user session")
        return (
            "temporary-user-jwt-that-must-never-be-serialized",
            "provided-user-access-token",
            digest(b"00000000-0000-4000-8000-000000000001"),
        )

    def create_signed_url(self, _url, _publishable, _token, bucket, path):
        self.signed_calls.append((bucket, path))
        return f"signed://{bucket}/{path}"

    def fetch_signed(self, url):
        marker = url.removeprefix("signed://")
        bucket, path = marker.split("/", 1)
        try:
            return self.store[(bucket, path)]
        except KeyError as error:
            raise loader.AppLoaderVerificationError("signed object missing") from error

    def download_authenticated(self, _url, _publishable, _token, bucket, path):
        self.direct_calls.append((bucket, path))
        if self.deny_download:
            raise loader.AppLoaderVerificationError(
                "authenticated Storage download rejected: HTTP 403"
            )
        try:
            return self.store[(bucket, path)]
        except KeyError as error:
            raise loader.AppLoaderVerificationError("RLS object missing") from error


class PrivateAppLoaderTests(unittest.TestCase):
    URL = "https://rrihysbxhsbxjteqmtdu.supabase.co"
    RELEASE_ID = "starter-appfixture"
    ACCESS_TOKEN = "provided-user-access-token-that-must-not-leak"

    def fixture(self, root: Path):
        trusted, books = loader._catalog_identity()
        book_id, source_pdf_sha = next(iter(books.items()))
        topic_counts = {
            "comb": 17, "data": 16, "exp": 14, "line": 14,
            "mat": 13, "num": 16, "poly": 16, "prob": 17,
            "seq": 15, "splane": 16, "svec": 18, "trig1": 15,
            "trig2": 14, "vec": 16,
        }
        topics = [topic for topic, count in topic_counts.items() for _ in range(count)]
        roles = (
            ["example"] * 114
            + ["chapter-end-easy"] * 56
            + ["chapter-end-medium"] * 34
            + ["chapter-end-hard"] * 13
        )
        self.assertEqual(len(topics), 217)
        rows = {"matha-content": [], "matha-figures": []}
        store = {}
        questions = []
        for index, (topic, role) in enumerate(zip(topics, roles), start=1):
            question_id = f"question-{index:03d}"
            image = f"original-stem-{question_id}".encode()
            image_sha = digest(image)
            image_path = (
                f"releases/{self.RELEASE_ID}/stems/{book_id}/"
                f"{question_id}-{image_sha[:16]}.png"
            )
            asset = {
                "assetStatus": "verified",
                "role": "question-stem",
                "path": image_path,
                "sha256": image_sha,
                "sourcePdfSha256": source_pdf_sha,
                "bbox": [0.1, 0.1, 0.8, 0.5],
                "mime": "image/png",
                "width": 1200,
                "height": 600,
                "bookId": book_id,
                "pageIndex": 1,
                "questionIds": [question_id],
                "producer": "pixel-producer",
                "containsAnswer": False,
                "containsSolution": False,
                "containsHandwriting": False,
                "includesOptions": True,
                "verifier": {
                    "reviewVersion": 1,
                    "reviewer": "independent-reviewer",
                    "questionRoleVerified": True,
                    "safetyVerified": True,
                    "assetHashVerified": True,
                    "fullStemVerified": True,
                    "optionsVerified": True,
                    "verifiedAt": "2026-08-29T00:00:00+00:00",
                },
            }
            questions.append({
                "id": question_id,
                "topic": topic,
                "role": role,
                "type": "single",
                "diff": 1,
                "q": f"題目 {index}",
                "opts": ["甲", "乙"],
                "ans": [0],
                "bookId": book_id,
                "page": 1,
                "needsStemAsset": True,
                "stemAsset": asset,
                "skills": ["fixture"],
            })
            rows["matha-figures"].append({
                "path": image_path,
                "sha256": image_sha,
                "bytes": len(image),
                "questionId": question_id,
            })
            store[("matha-figures", image_path)] = image

        packs = []
        cursor = 0
        for index in range(1, 192):
            count = 2 if index <= 26 else 1
            payload = {
                "kind": "qpack",
                "version": 2,
                "name": f"pack {index}",
                "items": questions[cursor:cursor + count],
            }
            cursor += count
            data = (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode()
            path = (
                f"releases/{self.RELEASE_ID}/content/"
                f"{index:03d}-{digest(data)[:12]}.json"
            )
            rows["matha-content"].append({
                "path": path, "sha256": digest(data), "bytes": len(data),
            })
            store[("matha-content", path)] = data
            packs.append({
                "id": f"curated-pack-{index:03d}",
                "name": payload["name"],
                "file": path,
                "count": count,
                "sha256": digest(data),
            })
        self.assertEqual(cursor, 217)

        pending_data = b'{"kind":"pending-visual-queue","items":[]}\n'
        pending_path = f"releases/{self.RELEASE_ID}/content/pending-visuals.json"
        rows["matha-content"].append({
            "path": pending_path,
            "sha256": digest(pending_data),
            "bytes": len(pending_data),
        })
        store[("matha-content", pending_path)] = pending_data
        manifest = {
            "schema": 3,
            "visibility": "authenticated",
            "releaseId": self.RELEASE_ID,
            "releaseReady": True,
            "generatedAt": "2026-08-29T00:00:00+00:00",
            "corpusGeneration": trusted["corpusGeneration"],
            "sourceInventorySha256": trusted["sourceInventorySha256"],
            "sourceDocuments": trusted["sourceDocuments"],
            "sourcePages": trusted["sourcePages"],
            "ocrProvider": trusted["ocrProvider"],
            "ocrModel": trusted["ocrModel"],
            "verificationPolicy": trusted["verificationPolicy"],
            "reviewPolicy": "owner-delegated-agent-direct-pixel-v1",
            "mathematicalCorrectnessVerified": True,
            "releaseChecks": {
                key: True for key in loader.STORAGE_RUNTIME.EXPECTED_RELEASE_CHECKS
            },
            "releaseApprovedBy": "Example Owner",
            "releaseApproval": {
                "kind": "owner-delegated-agent-starter-private-release-signoff",
                "version": 2,
                "delegatedReviewSha256": ["a" * 64, "b" * 64],
                "authorizedBy": "Example Owner",
                "performedBy": "Codex agent",
                "humanPixelReviewClaimed": False,
                "sampleQuestionIds": ["question-001"],
            },
            "pendingVisuals": {
                "file": pending_path,
                "count": 0,
                "sha256": digest(pending_data),
            },
            "packs": packs,
        }
        manifest_data = (json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n").encode()
        manifest_path = f"releases/{self.RELEASE_ID}/manifest.json"
        alias_path = loader.EXPECTED_ALIAS
        rows["matha-content"].append({
            "path": manifest_path,
            "sha256": digest(manifest_data),
            "bytes": len(manifest_data),
        })
        alias_row = {
            "path": alias_path,
            "sha256": digest(manifest_data),
            "bytes": len(manifest_data),
        }
        rows["matha-content"].append(alias_row)
        store[("matha-content", manifest_path)] = manifest_data
        store[("matha-content", alias_path)] = manifest_data

        source_file = root / "signed-private-question-source.json"
        source_payload = {
            "schema": 3,
            "kind": "private-question-source",
            "releaseId": self.RELEASE_ID,
            "questions": [{"id": question["id"]} for question in questions],
        }
        source_file.write_text(json.dumps(source_payload), encoding="utf-8")
        plan = {
            "kind": "matha-private-storage-upload-plan",
            "version": 1,
            "releaseReady": True,
            "uploadPerformed": False,
            "releaseId": self.RELEASE_ID,
            "manifestAlias": alias_path,
            "versionedManifest": manifest_path,
            "source": str(source_file.resolve()),
            "sourceSha256": digest(source_file.read_bytes()),
            "releaseApprovedBy": "Example Owner",
            "buckets": {
                bucket: {"root": str(root / bucket), "files": files}
                for bucket, files in rows.items()
            },
            "summary": {"questions": 217, "contentFiles": 194, "stemAssets": 217},
        }
        plan_file = root / "upload-plan.json"
        plan_file.write_text(json.dumps(plan), encoding="utf-8")
        versioned = []
        for bucket, entries in rows.items():
            for row in entries:
                if bucket == "matha-content" and row["path"] == alias_path:
                    continue
                versioned.append({
                    "bucket": bucket,
                    "path": row["path"],
                    "sha256": row["sha256"],
                    "bytes": row["bytes"],
                })
        deployment = {
            "kind": "matha-private-storage-deployment",
            "version": 1,
            "state": "deployed",
            "releaseId": self.RELEASE_ID,
            "deployedAt": "2026-08-29T00:00:00+00:00",
            "projectUrl": self.URL,
            "uploadPlanSha256": digest(plan_file.read_bytes()),
            "alias": {
                "bucket": "matha-content",
                "path": alias_path,
                "previousSha256": "0" * 64,
                "newSha256": digest(manifest_data),
            },
            "uploaded": versioned,
            "rollbackAvailable": True,
        }
        deployment_file = root / "deployment.json"
        deployment_file.write_text(json.dumps(deployment), encoding="utf-8")

        app = loader._app_identity()
        object_rows = sorted(versioned, key=lambda row: (row["bucket"], row["path"]))
        object_set_sha = digest(json.dumps(
            object_rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode())
        binding = {
            "releaseId": self.RELEASE_ID,
            "uploadPlanSha256": digest(plan_file.read_bytes()),
            "deploymentRecordSha256": digest(deployment_file.read_bytes()),
            "signedSourceSha256": digest(source_file.read_bytes()),
            "aliasSha256": digest(manifest_data),
            "versionedObjectSetSha256": object_set_sha,
            "appVersion": app["appVersion"],
            "appJsSha256": app["appJsSha256"],
            "textbookCatalogSha256": app["textbookCatalogSha256"],
        }
        direct_review = root / "direct-review.json"
        dual_review = root / "dual-review.json"
        answer_binding = root / "answer-binding.json"
        answer_assets = root / "answer-assets"
        answer_assets.mkdir()
        direct_review.write_text('{"kind":"fixture-direct-review"}\n', encoding="utf-8")
        dual_review.write_text('{"kind":"fixture-dual-review"}\n', encoding="utf-8")
        answer_binding.write_text('{"kind":"fixture-answer-binding"}\n', encoding="utf-8")
        direct_sha = digest(direct_review.read_bytes())
        dual_sha = digest(dual_review.read_bytes())
        answer_sha = digest(answer_binding.read_bytes())
        authorization_chain = {
            "owner": "Example Owner",
            "reviewer": "Codex agent",
            "delegations": 1,
            "directReviewSha256": [direct_sha],
            "dualReviewSha256": [dual_sha],
            "selectionSha256": "e" * 64,
            "unsignedSourceSha256": "f" * 64,
            "assetManifestSha256": "1" * 64,
            "providedDirectReviewFiles": 1,
            "evidenceFiles": {
                "directReviews": [{
                    "name": direct_review.name,
                    "path": str(direct_review.resolve()),
                    "sha256": direct_sha,
                }],
                "dualReviews": [{
                    "name": dual_review.name,
                    "path": str(dual_review.resolve()),
                    "sha256": dual_sha,
                }],
                "answerBindings": [{
                    "name": answer_binding.name,
                    "path": str(answer_binding.resolve()),
                    "sha256": answer_sha,
                    "answerAssetRoot": str(answer_assets.resolve()),
                    "answerAssetCount": 217,
                    "answerAssetSetSha256": "4" * 64,
                }],
            },
        }
        runtime = {
            "kind": "matha-private-release-runtime-verification",
            "version": 2,
            "status": "verified",
            "verifiedAt": "2026-08-29T00:00:00+00:00",
            "projectUrl": self.URL,
            **binding,
            "releaseAppBindingSha256": digest(json.dumps(
                binding, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            ).encode()),
            "readback": {
                "aliasObjects": 1,
                "versionedObjects": 410,
                "contentObjects": 193,
                "stemAssets": 217,
                "hashMismatches": 0,
                "missingObjects": 0,
            },
            "content": {
                "questions": 217,
                "packs": 191,
                "topics": dict(sorted(topic_counts.items())),
                "roles": dict(loader.EXPECTED_ROLES),
                "answerModes": {"single": 217},
                "answersVerifiedAgainstSignedSource": 217,
                "pendingVisuals": 0,
            },
            "trust": {
                **loader.STORAGE_RUNTIME.EXPECTED_CORPUS,
                "reviewPolicy": loader.STORAGE_RUNTIME.EXPECTED_REVIEW_POLICY,
                "releaseApprovedBy": "Example Owner",
                "signedSourceQuestionSetSha256": loader.canonical_sha(
                    source_payload["questions"]
                ),
                "answerEvidenceSetSha256": "3" * 64,
                "authorizationChainSha256": digest(json.dumps(
                    authorization_chain, ensure_ascii=False,
                    separators=(",", ":"), sort_keys=True,
                ).encode()),
                "authorizationChain": authorization_chain,
            },
        }
        runtime_file = root / "runtime.json"
        immutable_bytes = loader.STORAGE_RUNTIME.pretty_json_bytes(runtime)
        immutable_sha = digest(immutable_bytes)
        immutable_file = root / f"runtime-evidence-{immutable_sha[:16]}.json"
        immutable_file.write_bytes(immutable_bytes)
        pointer = {
            **runtime,
            "recordRole": "current-pointer",
            "immutableRecord": immutable_file.name,
            "immutableRecordSha256": immutable_sha,
        }
        runtime_file.write_text(json.dumps(pointer), encoding="utf-8")
        return plan_file, deployment_file, runtime_file, store

    def verify(self, root, backend, plan, deployment, runtime):
        return loader.verify_app_loader(
            plan, deployment, runtime, root / "app-loader.json",
            base_url=self.URL,
            access_token=self.ACCESS_TOKEN,
            backend=backend,
        )

    def test_success_uses_user_rls_for_every_pack_and_covers_topics_and_roles(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, deployment, runtime, store = self.fixture(root)
            backend = FakeBackend(store)
            result = self.verify(root, backend, plan, deployment, runtime)
            self.assertEqual(result["status"], "verified")
            self.assertEqual(result["loader"]["packs"], 191)
            self.assertEqual(result["loader"]["questions"], 217)
            self.assertEqual(result["loader"]["quarantinedQuestions"], 0)
            self.assertEqual(set(result["stemAssetSample"]["coveredTopics"]), loader.EXPECTED_TOPICS)
            self.assertEqual(set(result["stemAssetSample"]["coveredRoles"]), set(loader.EXPECTED_ROLES))
            pack_calls = [call for call in backend.direct_calls if call[0] == "matha-content"]
            figure_calls = [call for call in backend.direct_calls if call[0] == "matha-figures"]
            self.assertEqual(len(pack_calls), 191)
            self.assertEqual(len(figure_calls), 217)
            self.assertEqual(result["stemAssetReadback"]["count"], 217)
            self.assertEqual(result["stemAssetReadback"]["authenticatedRlsDownloads"], 217)
            self.assertEqual(len(result["stemAssetReadback"]["objects"]), 217)
            self.assertEqual(
                len(backend.signed_calls),
                1 + result["stemAssetSample"]["signedUrlCrossChecks"],
            )
            self.assertEqual(
                result["signedSourceQuestionSet"]["questionIds"],
                result["loader"]["questionIds"],
            )
            self.assertEqual(
                result["evidenceDigest"]["sha256"],
                loader.app_loader_evidence_sha(result),
            )
            loader.validate_app_loader_evidence(result)
            saved = (root / "app-loader.json").read_text(encoding="utf-8")
            self.assertNotIn(self.ACCESS_TOKEN, saved)
            self.assertNotIn("temporary-user-jwt", saved)

    def test_missing_one_non_sample_stem_rls_object_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, deployment, runtime, store = self.fixture(root)
            figure_keys = sorted(key for key in store if key[0] == "matha-figures")
            missing = figure_keys[-1]
            del store[missing]
            backend = FakeBackend(store)
            with self.assertRaisesRegex(loader.AppLoaderVerificationError, "RLS object missing"):
                self.verify(root, backend, plan, deployment, runtime)
            self.assertIn(missing, backend.direct_calls)
            self.assertFalse((root / "app-loader.json").exists())

    def test_evidence_rejects_nonexistent_sample_question_even_with_new_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, deployment, runtime, store = self.fixture(root)
            result = self.verify(root, FakeBackend(store), plan, deployment, runtime)
            tampered = copy.deepcopy(result)
            nonexistent = "aaa-question-does-not-exist"
            tampered["stemAssetSample"]["questionIds"][0] = nonexistent
            tampered["stemAssetSample"]["objects"][0]["questionId"] = nonexistent
            tampered["stemAssetSample"]["questionIdsSha256"] = loader.canonical_sha(
                tampered["stemAssetSample"]["questionIds"]
            )
            tampered["stemAssetSample"]["objectSetSha256"] = loader.canonical_sha(
                tampered["stemAssetSample"]["objects"]
            )
            tampered["evidenceDigest"]["sha256"] = loader.app_loader_evidence_sha(tampered)
            with self.assertRaisesRegex(
                loader.AppLoaderVerificationError, "not bound to full RLS readback"
            ):
                loader.validate_app_loader_evidence(tampered)

    def test_evidence_digest_rejects_auth_loader_and_sample_tampering(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, deployment, runtime, store = self.fixture(root)
            result = self.verify(root, FakeBackend(store), plan, deployment, runtime)
            mutations = (
                ("authentication", lambda value: value["authentication"].update(
                    {"mode": "admin-generated-one-time-magiclink"}
                )),
                ("loader", lambda value: value["loader"].update({"packHashMismatches": 1})),
                ("sample", lambda value: value["stemAssetSample"].update(
                    {"signedUrlCrossChecks": value["stemAssetSample"]["count"] - 1}
                )),
            )
            for label, mutate in mutations:
                with self.subTest(section=label):
                    tampered = copy.deepcopy(result)
                    mutate(tampered)
                    with self.assertRaisesRegex(
                        loader.AppLoaderVerificationError, "evidence digest drift"
                    ):
                        loader.validate_app_loader_evidence(tampered)

    def test_unapproved_user_and_rls_denial_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, deployment, runtime, store = self.fixture(root)
            with self.assertRaisesRegex(loader.AppLoaderVerificationError, "not enabled"):
                self.verify(root, FakeBackend(store, approved=False), plan, deployment, runtime)
            self.assertFalse((root / "app-loader.json").exists())
            with self.assertRaisesRegex(loader.AppLoaderVerificationError, "HTTP 403"):
                self.verify(root, FakeBackend(store, deny_download=True), plan, deployment, runtime)
            self.assertFalse((root / "app-loader.json").exists())

    def test_pack_drift_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, deployment, runtime, store = self.fixture(root)
            key = next(key for key in store if key[0] == "matha-content" and "/content/" in key[1]
                       and not key[1].endswith("pending-visuals.json"))
            store[key] = b"changed-pack-bytes"
            with self.assertRaisesRegex(loader.AppLoaderVerificationError, "question pack drift"):
                self.verify(root, FakeBackend(store), plan, deployment, runtime)

    def test_app_drift_in_storage_runtime_record_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, deployment, runtime_file, store = self.fixture(root)
            pointer = json.loads(runtime_file.read_text(encoding="utf-8"))
            immutable_file = root / pointer["immutableRecord"]
            runtime = json.loads(immutable_file.read_text(encoding="utf-8"))
            runtime["appJsSha256"] = "f" * 64
            immutable_bytes = loader.STORAGE_RUNTIME.pretty_json_bytes(runtime)
            immutable_file.write_bytes(immutable_bytes)
            pointer = {
                **runtime,
                "recordRole": "current-pointer",
                "immutableRecord": immutable_file.name,
                "immutableRecordSha256": digest(immutable_bytes),
            }
            runtime_file.write_text(json.dumps(pointer), encoding="utf-8")
            with self.assertRaisesRegex(loader.AppLoaderVerificationError, "appJsSha256"):
                self.verify(root, FakeBackend(store), plan, deployment, runtime_file)

    def test_current_pointer_must_match_immutable_runtime_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, deployment, runtime_file, store = self.fixture(root)
            pointer = json.loads(runtime_file.read_text(encoding="utf-8"))
            immutable_file = root / pointer["immutableRecord"]
            with self.assertRaisesRegex(
                loader.AppLoaderVerificationError, "requires the current pointer"
            ):
                self.verify(root, FakeBackend(store), plan, deployment, immutable_file)
            pointer["trust"]["sourcePages"] += 1
            runtime_file.write_text(json.dumps(pointer), encoding="utf-8")
            with self.assertRaisesRegex(
                loader.AppLoaderVerificationError, "differs from immutable evidence"
            ):
                self.verify(root, FakeBackend(store), plan, deployment, runtime_file)


if __name__ == "__main__":
    unittest.main()
