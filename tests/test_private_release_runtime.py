import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "private_release_runtime",
    ROOT / "scripts" / "ingest" / "verify-private-release-runtime.py",
)
runtime = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(runtime)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()


class PrivateReleaseRuntimeTests(unittest.TestCase):
    URL = runtime.EXPECTED_SUPABASE_URL
    KEY = "service-role-test-key-which-must-never-leak"
    RELEASE_ID = "starter-runtime1234"
    OWNER = "uqrqmmw"
    REVIEWER = "Codex 5.6 direct-pixel audit"

    @staticmethod
    def downloader(store):
        def download(_url, _key, bucket, path):
            return store.get((bucket, path))

        return download

    def fixture(
        self,
        root: Path,
        *,
        source_mutator=None,
        approval_mutator=None,
        remote_mutator=None,
        manifest_mutator=None,
        plan_mutator=None,
        direct_review_mutator=None,
        dual_review_mutator=None,
        answer_binding_mutator=None,
    ):
        topic_counts = {
            "comb": 17,
            "data": 16,
            "exp": 14,
            "line": 14,
            "mat": 13,
            "num": 16,
            "poly": 16,
            "prob": 17,
            "seq": 15,
            "splane": 16,
            "svec": 18,
            "trig1": 15,
            "trig2": 14,
            "vec": 16,
        }
        roles = (
            ["example"] * 114
            + ["chapter-end-easy"] * 56
            + ["chapter-end-medium"] * 34
            + ["chapter-end-hard"] * 13
        )
        topics = [topic for topic, count in topic_counts.items() for _ in range(count)]
        reviewed_at = "2026-08-29T22:35:00+08:00"
        authorized_at = "2026-08-29T15:36:57+08:00"
        book_id = "matha-114-runtime-fixture"
        questions = []
        figure_payloads = {}
        asset_rows = []

        for index in range(runtime.EXPECTED_QUESTIONS):
            question_id = f"question-{index + 1:03d}"
            image = f"verified-pixels-{question_id}".encode()
            image_sha = digest(image)
            image_path = (
                f"releases/{self.RELEASE_ID}/stems/{book_id}/"
                f"{question_id}-{image_sha[:16]}.png"
            )
            figure_payloads[image_path] = image
            if index < 35:
                mode = "single"
                correct = [2]
                option_count = 4
                options = [f"原題選項 {number}" for number in range(1, 5)]
                answers = [1]
                solution = "官方答案：2"
                structured = {
                    "schema": 1,
                    "mode": mode,
                    "optionCount": option_count,
                    "correctOptionNumbers": correct,
                }
            elif index < 56:
                mode = "multi"
                correct = [1, 3]
                option_count = 4
                options = [f"原題選項 {number}" for number in range(1, 5)]
                answers = [0, 2]
                solution = "官方答案：1、3"
                structured = {
                    "schema": 1,
                    "mode": mode,
                    "optionCount": option_count,
                    "correctOptionNumbers": correct,
                }
            else:
                mode = "text"
                text_answer = str(index + 10)
                options = []
                answers = [text_answer]
                solution = f"官方答案：{text_answer}"
                structured = {
                    "schema": 1,
                    "mode": mode,
                    "officialAnswerText": text_answer,
                }
            question_type = "fill" if mode == "text" else mode
            page = index + 1
            question = {
                "id": question_id,
                "topic": topics[index],
                "type": question_type,
                "diff": index % 3 + 1,
                "q": "完整題目、公式、選項與圖形請見原 PDF 題目裁圖。",
                "opts": options,
                "ans": answers,
                "sol": solution,
                "src": f"測試教材｜PDF 第 {page} 頁",
                "bookId": book_id,
                "bookTitle": "測試教材",
                "page": page,
                "role": roles[index],
                "displayTruth": "original-pdf-crop",
                "needsStemAsset": True,
                "stemAsset": {
                    "path": image_path,
                    "sha256": image_sha,
                    "sourcePdfSha256": digest(b"fixture-source-pdf"),
                    "pageIndex": page,
                    "bbox": [0.0, 0.05, 0.8, 0.25],
                    "role": "question-stem",
                    "assetStatus": "verified",
                    "mime": "image/png",
                    "width": 1200,
                    "height": 400,
                    "containsAnswer": False,
                    "containsSolution": False,
                    "containsHandwriting": False,
                    "includesOptions": mode in {"single", "multi"},
                    "questionIds": [question_id],
                    "bookId": book_id,
                    "producer": "YesScanner handwriting-remover v2",
                    "verifier": {
                        "reviewer": self.REVIEWER,
                        "reviewVersion": 2,
                        "questionRoleVerified": True,
                        "safetyVerified": True,
                        "assetHashVerified": True,
                        "fullStemVerified": True,
                        "optionsVerified": True,
                        "verifiedAt": reviewed_at,
                    },
                },
                "answerVerification": {
                    "reviewer": self.REVIEWER,
                    "reviewedAt": reviewed_at,
                    "officialAnswerSha256": digest(f"answer-{question_id}".encode()),
                    "answerSource": tuple(sorted(runtime.EXPECTED_ANSWER_SOURCES))[index % 3],
                    "answerPdfPage": page,
                    "structuredAnswer": structured,
                },
            }
            questions.append(question)
            asset_rows.append({
                "id": question_id,
                "path": image_path,
                "sha256": image_sha,
                "bookId": book_id,
            })

        delegation = {
            "kind": "owner-delegated-agent-content-review",
            "authorizedBy": self.OWNER,
            "authorizedAt": authorized_at,
            "scope": "starter fixture full direct-pixel and official-answer review",
            "basis": "The repository owner delegated this bounded review.",
        }
        binding_root = root / "answer-binding"
        binding_items = []
        for question in questions:
            question_id = question["id"]
            answer = question["answerVerification"]
            stem = question["stemAsset"]
            binding_items.append({
                "id": question_id,
                "bookId": question["bookId"],
                "chapter": "fixture",
                "role": question["role"],
                "questionType": question["type"],
                "pdfPage": question["page"],
                "answerPdfPage": answer["answerPdfPage"],
                "answerRegion": [0, 0, 1200, 400],
                "answerSource": answer["answerSource"],
                "sourcePdfSha256": stem["sourcePdfSha256"],
                "sourceSha256": digest(f"source-{question_id}".encode()),
                "cleanedSha256": stem["sha256"],
                "answerSha256": answer["officialAnswerSha256"],
                "figureCount": 0,
                "figureSha256": [],
            })
            answer_asset = binding_root / "assets" / question_id / "answer.png"
            answer_asset.parent.mkdir(parents=True, exist_ok=True)
            answer_asset.write_bytes(f"answer-{question_id}".encode())
        answer_binding = {
            "kind": "cleaned-answer-binding-candidates",
            "version": 1,
            "releaseAuthority": False,
            "total": len(binding_items),
            "reviewableCount": len(binding_items),
            "quarantinedCount": 0,
            "candidateManifestSha256": digest(b"fixture-candidate-manifest"),
            "catalogSha256": digest(b"fixture-catalog"),
            "handwritingPixelReviewAlsoRequired": True,
            "humanAnswerReviewRequired": True,
            "quarantined": [],
            "items": binding_items,
        }
        if answer_binding_mutator:
            answer_binding_mutator(answer_binding)
        answer_binding_file = binding_root / "answer-binding-candidates.json"
        answer_binding_file.parent.mkdir(parents=True, exist_ok=True)
        answer_binding_file.write_bytes(json_bytes(answer_binding))
        exact_inputs = {
            "candidateManifestSha256": digest(b"fixture-candidate-manifest"),
            "pixelTemplateSha256": digest(b"fixture-pixel-template"),
            "answerBindingSha256": digest(answer_binding_file.read_bytes()),
            "answerTemplateSha256": digest(b"fixture-answer-template"),
        }
        review_file = root / "delegated-review.json"
        direct_review = {
            "kind": "matha-owner-delegated-starter-direct-review",
            "version": 1,
            "reviewPolicy": runtime.EXPECTED_REVIEW_POLICY,
            "releaseAuthority": False,
            "reviewedBy": self.REVIEWER,
            "reviewedAt": reviewed_at,
            "delegation": copy.deepcopy(delegation),
            "exactInputs": copy.deepcopy(exact_inputs),
            "passAttestation": {
                "appliesToEveryPassedQuestion": True,
                "pixelChecks": {
                    key: True for key in runtime.PIXEL_REVIEW_CHECKS
                },
                "answerChecks": {
                    key: True for key in runtime.ANSWER_REVIEW_CHECKS
                },
            },
            "questions": [
                {
                    "id": question["id"],
                    "pixelDecision": "pass",
                    "answerDecision": "pass",
                    "structuredAnswer": copy.deepcopy(
                        question["answerVerification"]["structuredAnswer"]
                    ),
                }
                for question in questions
            ],
        }
        if direct_review_mutator:
            direct_review_mutator(direct_review)
        review_file.write_bytes(json_bytes(direct_review))
        direct_sha = digest(review_file.read_bytes())
        dual_review_file = root / "dual-review.json"
        dual_review = {
            "kind": "matha-private-cleaned-owner-delegated-review-candidates",
            "version": 1,
            "releaseAuthority": False,
            "reviewPolicy": runtime.EXPECTED_REVIEW_POLICY,
            "humanReviewClaimed": False,
            "ownerDelegation": copy.deepcopy(delegation),
            "directReviewSha256": direct_sha,
            "reviewedBy": self.REVIEWER,
            "reviewedAt": reviewed_at,
            "pixelReviewer": self.REVIEWER,
            "pixelReviewedAt": reviewed_at,
            "answerReviewer": self.REVIEWER,
            "answerReviewedAt": reviewed_at,
            "ownerReleaseAuthorizationRecorded": True,
            "privateAssetDeploymentStillRequired": True,
            "uploadPerformed": False,
            "candidateManifestSha256": direct_review["exactInputs"][
                "candidateManifestSha256"
            ],
            "pixelReviewTemplateSha256": direct_review["exactInputs"][
                "pixelTemplateSha256"
            ],
            "answerBindingSha256": direct_review["exactInputs"][
                "answerBindingSha256"
            ],
            "answerReviewTemplateSha256": direct_review["exactInputs"][
                "answerTemplateSha256"
            ],
            "counts": {
                "totalCandidates": len(questions),
                "eligible": len(questions),
                "quarantined": 0,
            },
            "quarantine": [],
            "items": [
                {
                    "id": question["id"],
                    "bookId": question["bookId"],
                    "chapter": "fixture",
                    "role": question["role"],
                    "questionType": question["type"],
                    "pdfPage": question["page"],
                    "stemRegion": [0, 0, 1200, 400],
                    "cropDpi": 300,
                    "cleaned": str(root / "cleaned" / question["id"] / "cleaned.png"),
                    "cleanedSha256": question["stemAsset"]["sha256"],
                    "answerPath": None,
                    "answerPdfPage": question["answerVerification"]["answerPdfPage"],
                    "answerRegion": [0, 0, 1200, 400],
                    "answerSource": question["answerVerification"]["answerSource"],
                    "answerSha256": question["answerVerification"][
                        "officialAnswerSha256"
                    ],
                    "sourcePdfSha256": question["stemAsset"]["sourcePdfSha256"],
                    "figureCount": 0,
                    "figureSha256": [],
                    "structuredAnswer": copy.deepcopy(
                        question["answerVerification"]["structuredAnswer"]
                    ),
                }
                for question in questions
            ],
            "nextGate": "Hash-bind this delegated review to a private release.",
        }
        if dual_review_mutator:
            dual_review_mutator(dual_review)
        dual_review_file.write_bytes(json_bytes(dual_review))
        dual_sha = digest(dual_review_file.read_bytes())
        source = {
            "schema": 3,
            "kind": "private-question-source",
            "releaseId": self.RELEASE_ID,
            **runtime.EXPECTED_CORPUS,
            "originalPdfVerified": True,
            "answerKeyVerified": True,
            "mathematicalCorrectnessVerified": True,
            "reviewedBy": self.REVIEWER,
            "reviewPolicy": runtime.EXPECTED_REVIEW_POLICY,
            "ownerDelegation": {
                "kind": "owner-delegated-agent-content-review-set",
                "authorizedBy": self.OWNER,
                "delegationCount": 1,
            },
            "ownerDelegations": [delegation],
            "releaseApprovedBy": self.OWNER,
            "releaseReviewSampleQuestionIds": [q["id"] for q in questions[:10]],
            "reviewAudit": {
                "sourceQuestionCount": runtime.EXPECTED_QUESTIONS,
                "approvedQuestionCount": runtime.EXPECTED_QUESTIONS,
                "completedAt": reviewed_at,
                "dualReviewSha256": [dual_sha],
                "directReviewSha256": [direct_sha],
                "selectionSha256": digest(b"fixture-selection"),
            },
            "questions": questions,
        }
        if source_mutator:
            source_mutator(source)

        asset_manifest = {
            "kind": "matha-starter-private-asset-manifest",
            "version": 1,
            "releaseAuthority": False,
            "releaseId": self.RELEASE_ID,
            "questions": [
                {
                    "id": question["id"],
                    "path": question["stemAsset"]["path"],
                    "sha256": question["stemAsset"]["sha256"],
                    "bookId": question["bookId"],
                }
                for question in source["questions"]
            ],
        }
        asset_file = root / "asset-manifest.json"
        asset_file.write_bytes(json_bytes(asset_manifest))
        unsigned = copy.deepcopy(source)
        unsigned["releaseApprovedBy"] = None
        unsigned_file = root / "unsigned-private-question-source.json"
        unsigned_file.write_bytes(json_bytes(unsigned))
        approval = {
            "kind": "owner-delegated-agent-starter-private-release-signoff",
            "version": 1,
            "authorizedBy": self.OWNER,
            "authorizedAt": source["ownerDelegations"][0]["authorizedAt"],
            "authorizations": copy.deepcopy(source["ownerDelegations"]),
            "performedBy": self.REVIEWER,
            "performedAt": reviewed_at,
            "humanPixelReviewClaimed": False,
            "delegatedReviewSha256": [direct_sha],
            "unsignedSourceSha256": digest(unsigned_file.read_bytes()),
            "assetManifestSha256": digest(asset_file.read_bytes()),
            "sampleQuestionIds": copy.deepcopy(source["releaseReviewSampleQuestionIds"]),
        }
        if approval_mutator:
            approval_mutator(approval)
        source["releaseApproval"] = approval
        source_file = root / "signed-private-question-source.json"
        source_file.write_bytes(json_bytes(source))

        remote_questions = copy.deepcopy(source["questions"])
        if remote_mutator:
            remote_mutator(remote_questions)
        store = {}
        rows_by_bucket = {"matha-content": [], "matha-figures": []}
        for question, image in zip(source["questions"], figure_payloads.values()):
            path = question["stemAsset"]["path"]
            rows_by_bucket["matha-figures"].append({
                "path": path,
                "sha256": digest(image),
                "bytes": len(image),
                "questionId": question["id"],
            })
            store[("matha-figures", path)] = image

        packs = []
        cursor = 0
        for pack_index in range(runtime.EXPECTED_PACKS):
            count = 2 if pack_index < 26 else 1
            items = remote_questions[cursor:cursor + count]
            cursor += count
            name = f"pack {pack_index + 1}"
            payload = {"kind": "qpack", "version": 2, "name": name, "items": items}
            data = json_bytes(payload)
            path = (
                f"releases/{self.RELEASE_ID}/content/"
                f"{pack_index + 1:03d}-{digest(data)[:12]}.json"
            )
            rows_by_bucket["matha-content"].append({
                "path": path,
                "sha256": digest(data),
                "bytes": len(data),
            })
            store[("matha-content", path)] = data
            packs.append({
                "id": f"curated-{pack_index + 1:016x}",
                "name": name,
                "file": path,
                "count": count,
                "sha256": digest(data),
            })
        self.assertEqual(cursor, runtime.EXPECTED_QUESTIONS)

        pending = {"kind": "pending-visual-queue", "version": 1, "count": 0, "items": []}
        pending_data = json_bytes(pending)
        pending_path = f"releases/{self.RELEASE_ID}/content/pending-visuals.json"
        rows_by_bucket["matha-content"].append({
            "path": pending_path,
            "sha256": digest(pending_data),
            "bytes": len(pending_data),
        })
        store[("matha-content", pending_path)] = pending_data
        manifest = {
            "schema": 3,
            "visibility": "authenticated",
            "generatedAt": reviewed_at,
            **runtime.EXPECTED_CORPUS,
            "reviewPolicy": runtime.EXPECTED_REVIEW_POLICY,
            "mathematicalCorrectnessVerified": True,
            "releaseReady": True,
            "releaseChecks": {key: True for key in runtime.EXPECTED_RELEASE_CHECKS},
            "releaseApprovedBy": self.OWNER,
            "releaseApproval": copy.deepcopy(approval),
            "sourceFile": source_file.name,
            "sourceSha256": digest(source_file.read_bytes()),
            "report": {
                "sourceTotal": runtime.EXPECTED_QUESTIONS,
                "accepted": runtime.EXPECTED_QUESTIONS,
                "skipped": {"schema": 0, "missingStem": 0, "untrustedReview": 0},
                "visual": {"pending": 0},
            },
            "library": {
                "schema": 1,
                "verifiedBooks": 0,
                "readyBooks": 0,
                "pendingBooks": 24,
            },
            "pendingVisuals": {
                "file": pending_path,
                "count": 0,
                "sha256": digest(pending_data),
            },
            "packs": packs,
            "releaseId": self.RELEASE_ID,
        }
        if manifest_mutator:
            manifest_mutator(manifest)
        manifest_data = json_bytes(manifest)
        manifest_path = f"releases/{self.RELEASE_ID}/manifest.json"
        alias_path = runtime.EXPECTED_ALIAS
        rows_by_bucket["matha-content"].append({
            "path": manifest_path,
            "sha256": digest(manifest_data),
            "bytes": len(manifest_data),
        })
        rows_by_bucket["matha-content"].append({
            "path": alias_path,
            "sha256": digest(manifest_data),
            "bytes": len(manifest_data),
        })
        store[("matha-content", manifest_path)] = manifest_data
        store[("matha-content", alias_path)] = manifest_data

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
            "releaseApprovedBy": self.OWNER,
            "buckets": {
                bucket: {"root": str(root / bucket), "files": rows}
                for bucket, rows in rows_by_bucket.items()
            },
            "summary": {
                "questions": 217,
                "contentFiles": 194,
                "stemAssets": 217,
            },
        }
        if plan_mutator:
            plan_mutator(plan)
        plan_file = root / "upload-plan.json"
        plan_file.write_bytes(json_bytes(plan))
        versioned = []
        for bucket, rows in rows_by_bucket.items():
            for row in rows:
                if not (bucket == "matha-content" and row["path"] == alias_path):
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
            "deployedAt": "2026-08-30T00:00:00+00:00",
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
        deployment_file.write_bytes(json_bytes(deployment))
        return {
            "plan": plan_file,
            "deployment": deployment_file,
            "source": source_file,
            "asset": asset_file,
            "review": review_file,
            "dual_review": dual_review_file,
            "answer_binding": answer_binding_file,
            "store": store,
        }

    _DEFAULT_EVIDENCE = object()

    def verify(
        self, fixture, output, *, url=None,
        reviews=_DEFAULT_EVIDENCE, dual_reviews=_DEFAULT_EVIDENCE,
        answer_bindings=_DEFAULT_EVIDENCE, downloader=None,
    ):
        if reviews is self._DEFAULT_EVIDENCE:
            reviews = [fixture["review"]]
        if dual_reviews is self._DEFAULT_EVIDENCE:
            dual_reviews = [fixture["dual_review"]]
        if answer_bindings is self._DEFAULT_EVIDENCE:
            answer_bindings = [fixture["answer_binding"]]
        return runtime.verify_runtime(
            fixture["plan"],
            fixture["deployment"],
            output,
            self.URL if url is None else url,
            self.KEY,
            downloader or self.downloader(fixture["store"]),
            signed_source_file=fixture["source"],
            delegated_review_files=reviews,
            dual_review_files=dual_reviews,
            answer_binding_files=answer_bindings,
        )

    def test_success_reads_every_object_and_writes_hash_versioned_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(root)
            output = root / "runtime-verification.json"
            calls = []

            def download(url, key, bucket, path):
                self.assertEqual(url, self.URL)
                self.assertEqual(key, self.KEY)
                calls.append((bucket, path))
                return fixture["store"].get((bucket, path))

            result = self.verify(
                fixture, output, reviews=[fixture["review"]], downloader=download,
            )
            self.assertEqual(result["status"], "verified")
            self.assertEqual(result["version"], 2)
            self.assertEqual(result["content"]["questions"], 217)
            self.assertEqual(result["content"]["packs"], 191)
            self.assertEqual(result["content"]["roles"], runtime.EXPECTED_ROLES)
            self.assertEqual(
                result["content"]["answerModes"],
                {"multi": 21, "single": 35, "text": 161},
            )
            self.assertEqual(result["readback"]["versionedObjects"], 410)
            self.assertEqual(len(calls), 411)
            self.assertEqual(result["projectUrl"], self.URL)
            self.assertEqual(result["trust"]["sourceDocuments"], 25)
            self.assertEqual(result["trust"]["authorizationChain"]["delegations"], 1)
            evidence_files = result["trust"]["authorizationChain"]["evidenceFiles"]
            self.assertEqual(
                set(evidence_files),
                {"directReviews", "dualReviews", "answerBindings"},
            )
            self.assertEqual(evidence_files["directReviews"][0]["path"], str(
                fixture["review"].resolve()
            ))
            self.assertEqual(
                evidence_files["answerBindings"][0]["answerAssetCount"], 217,
            )
            self.assertEqual(
                result["appJsSha256"], digest((ROOT / "app.js").read_bytes())
            )
            pointer = json.loads(output.read_text("utf-8"))
            immutable = output.with_name(pointer["immutableRecord"])
            self.assertTrue(immutable.is_file())
            self.assertEqual(digest(immutable.read_bytes()), pointer["immutableRecordSha256"])
            self.assertNotIn(self.KEY, output.read_text("utf-8"))
            self.assertNotIn(self.KEY, immutable.read_text("utf-8"))

    def test_reverification_preserves_prior_immutable_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(root)
            output = root / "runtime-verification.json"
            first = self.verify(fixture, output)
            first_file = root / first["immutableRecord"]
            first_bytes = first_file.read_bytes()
            second = self.verify(fixture, output)
            self.assertNotEqual(first["immutableRecord"], second["immutableRecord"])
            self.assertEqual(first_file.read_bytes(), first_bytes)
            self.assertTrue((root / second["immutableRecord"]).is_file())

    def test_existing_non_pointer_evidence_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(root)
            output = root / "runtime-verification.json"
            original = b'{"kind":"legacy-attestation"}\n'
            output.write_bytes(original)
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "non-pointer"):
                self.verify(fixture, output)
            self.assertEqual(output.read_bytes(), original)
            self.assertEqual(
                list(root.glob("runtime-verification-*-*.json")), [],
                "a rejected pointer must not leave a misleading immutable record",
            )

    def test_alias_and_versioned_object_drift_fail_closed(self):
        for case in ("alias", "figure"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                fixture = self.fixture(root)
                if case == "alias":
                    key = ("matha-content", runtime.EXPECTED_ALIAS)
                else:
                    key = next(k for k in fixture["store"] if k[0] == "matha-figures")
                fixture["store"][key] = b"drifted-object"
                output = root / "runtime-verification.json"
                with self.assertRaisesRegex(runtime.RuntimeVerificationError, "remote object drift"):
                    self.verify(fixture, output)
                self.assertFalse(output.exists())

    def test_corpus_trust_family_rejects_every_field(self):
        mutations = {
            "corpusGeneration": "wrong-generation",
            "sourceInventorySha256": "1" * 64,
            "sourceDocuments": 24,
            "sourcePages": 6719,
            "ocrProvider": "wrong-provider",
            "ocrModel": "wrong-model",
            "verificationPolicy": "wrong-policy",
        }
        for field, value in mutations.items():
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                fixture = self.fixture(
                    Path(temp),
                    source_mutator=lambda source, f=field, v=value: source.__setitem__(f, v),
                )
                with self.assertRaisesRegex(runtime.RuntimeVerificationError, "corpus trust contract"):
                    self.verify(fixture, Path(temp) / "result.json")

    def test_delegated_authorization_chain_and_review_file_are_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(
                root,
                approval_mutator=lambda approval: approval.__setitem__("authorizedBy", "intruder"),
            )
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "authorization chain"):
                self.verify(fixture, root / "result.json")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(root)
            wrong_review = root / "wrong-review.json"
            wrong_review.write_text("{}\n", encoding="utf-8")
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "review files do not match"):
                self.verify(fixture, root / "result.json", reviews=[wrong_review])

    def test_all_three_external_review_evidence_layers_are_mandatory(self):
        cases = (
            ({"reviews": []}, "complete delegated direct review"),
            ({"dual_reviews": []}, "complete delegated dual review"),
            ({"answer_bindings": []}, "complete official answer binding"),
        )
        for kwargs, message in cases:
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                fixture = self.fixture(root)
                with self.assertRaisesRegex(runtime.RuntimeVerificationError, message):
                    self.verify(fixture, root / "result.json", **kwargs)

    def test_hash_bound_files_must_contain_complete_review_contracts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(
                root,
                direct_review_mutator=lambda review: review["passAttestation"][
                    "answerChecks"
                ].__setitem__("mathematicallyCorrect", False),
            )
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "attestation.*incomplete"):
                self.verify(fixture, root / "result.json")

    def test_self_reported_official_answer_sha_cannot_replace_answer_pixels(self):
        fake_sha = "f" * 64

        def mutate_source(source):
            source["questions"][0]["answerVerification"][
                "officialAnswerSha256"
            ] = fake_sha

        def mutate_binding(binding):
            binding["items"][0]["answerSha256"] = fake_sha

        def mutate_dual(dual):
            dual["items"][0]["answerSha256"] = fake_sha

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(
                root,
                source_mutator=mutate_source,
                answer_binding_mutator=mutate_binding,
                dual_review_mutator=mutate_dual,
            )
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "answer crop hash drifted"):
                self.verify(fixture, root / "result.json")

    def test_naked_source_answer_sha_must_match_hash_bound_review_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(
                root,
                source_mutator=lambda source: source["questions"][0][
                    "answerVerification"
                ].__setitem__("officialAnswerSha256", "e" * 64),
            )
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "trust evidence binding"):
                self.verify(fixture, root / "result.json")

    def test_signed_source_and_its_sibling_evidence_are_hash_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(root)
            fixture["source"].write_bytes(fixture["source"].read_bytes() + b"\n")
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "not bound"):
                self.verify(fixture, root / "result.json")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(root)
            fixture["asset"].write_bytes(fixture["asset"].read_bytes() + b"\n")
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "asset manifest hash drifted"):
                self.verify(fixture, root / "result.json")

    def test_answer_trust_family_rejects_ans_sol_source_and_structured_answer(self):
        mutations = {
            "ans": lambda q: q.__setitem__("ans", [99]),
            "sol": lambda q: q.__setitem__("sol", "官方答案：99"),
            "reviewer": lambda q: q["answerVerification"].__setitem__(
                "reviewer", "different signing source"
            ),
            "source": lambda q: q["answerVerification"].__setitem__(
                "answerSource", "ocr-guess"
            ),
            "structured": lambda q: q["answerVerification"]["structuredAnswer"].__setitem__(
                "correctOptionNumbers", [4]
            ),
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                fixture = self.fixture(
                    root,
                    source_mutator=lambda source, m=mutation: m(source["questions"][0]),
                )
                with self.assertRaisesRegex(
                    runtime.RuntimeVerificationError,
                    "ans/sol|answer reviewer|official answer source|option answer",
                ):
                    self.verify(fixture, root / "result.json")

    def test_hash_valid_remote_answer_drift_still_fails_signed_source_comparison(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(
                root,
                remote_mutator=lambda questions: questions[0].__setitem__(
                    "sol", "官方答案：4"
                ),
            )
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "signed source"):
                self.verify(fixture, root / "result.json")

    def test_plan_object_set_and_fixed_project_are_enforced(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(
                root,
                plan_mutator=lambda plan: plan["summary"].__setitem__("questions", 216),
            )
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "summary is inconsistent"):
                self.verify(fixture, root / "result.json")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)

            def remove_versioned_object(plan):
                plan["buckets"]["matha-figures"]["files"].pop()

            fixture = self.fixture(root, plan_mutator=remove_versioned_object)
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "object count"):
                self.verify(fixture, root / "result.json")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(root)
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "project used by app.js"):
                self.verify(fixture, root / "result.json", url="https://wrong.supabase.co")

    def test_manifest_must_mirror_signed_approval_and_source_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(
                root,
                manifest_mutator=lambda manifest: manifest.__setitem__(
                    "releaseApprovedBy", "intruder"
                ),
            )
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "signed corpus trust"):
                self.verify(fixture, root / "result.json")

    def test_manifest_release_checks_must_all_be_true(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)

            def fail_one_check(manifest):
                manifest["releaseChecks"]["answerKeyVerified"] = False

            fixture = self.fixture(root, manifest_mutator=fail_one_check)
            with self.assertRaisesRegex(runtime.RuntimeVerificationError, "release checks"):
                self.verify(fixture, root / "result.json")


if __name__ == "__main__":
    unittest.main()
