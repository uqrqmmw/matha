import argparse
import base64
import hashlib
import importlib.util
import json
import re
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "audit_blueprint_readiness", ROOT / "scripts" / "audit-blueprint-readiness.py"
)
audit = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(audit)

RUNTIME_TEST_SPEC = importlib.util.spec_from_file_location(
    "private_release_runtime_fixtures",
    ROOT / "tests" / "test_private_release_runtime.py",
)
runtime_fixtures = importlib.util.module_from_spec(RUNTIME_TEST_SPEC)
assert RUNTIME_TEST_SPEC.loader
RUNTIME_TEST_SPEC.loader.exec_module(runtime_fixtures)

APP_LOADER_TEST_SPEC = importlib.util.spec_from_file_location(
    "private_app_loader_fixtures",
    ROOT / "tests" / "test_private_app_loader.py",
)
app_loader_fixtures = importlib.util.module_from_spec(APP_LOADER_TEST_SPEC)
assert APP_LOADER_TEST_SPEC.loader
APP_LOADER_TEST_SPEC.loader.exec_module(app_loader_fixtures)

GITHUB_TEST_SPEC = importlib.util.spec_from_file_location(
    "github_delivery_fixtures",
    ROOT / "tests" / "test_github_delivery.py",
)
github_fixtures = importlib.util.module_from_spec(GITHUB_TEST_SPEC)
assert GITHUB_TEST_SPEC.loader
GITHUB_TEST_SPEC.loader.exec_module(github_fixtures)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def signed_source_value(release_id: str = "starter-fixture") -> dict:
    hashes = ["a" * 64, "b" * 64]
    questions = []
    for index in range(217):
        qid = f"q-{index:03d}"
        if index < 35:
            answer = [1]
            structured = {"schema": 1, "mode": "single", "optionCount": 4,
                          "correctOptionNumbers": [2]}
        elif index < 56:
            answer = [0, 2]
            structured = {"schema": 1, "mode": "multi", "optionCount": 4,
                          "correctOptionNumbers": [1, 3]}
        else:
            answer = ["1"]
            structured = {"schema": 1, "mode": "text", "officialAnswerText": "1"}
        questions.append({
            "id": qid, "ans": answer, "sol": "官方答案：1",
            "displayTruth": "original-pdf-crop", "needsStemAsset": True,
            "stemAsset": {
                "sha256": hashlib.sha256(f"stem-{index}".encode()).hexdigest(),
                "assetStatus": "verified", "containsAnswer": False,
                "containsSolution": False, "containsHandwriting": False,
            },
            "answerVerification": {
                "officialAnswerSha256": hashlib.sha256(f"answer-{index}".encode()).hexdigest(),
                "structuredAnswer": structured,
            },
        })
    delegations = [{
        "kind": "owner-delegated-agent-content-review",
        "authorizedBy": "repo-owner",
        "authorizedAt": "2026-08-29T10:00:00+08:00",
        "scope": "217 題逐像素題面與官方答案核對",
        "basis": "repository owner delegated this bounded review",
    }]
    return {
        "schema": 3, "kind": "private-question-source", "releaseId": release_id,
        "corpusGeneration": "mistral-ocr4-verified-v1",
        "sourceInventorySha256": audit.EXPECTED_CORPUS["sourceInventorySha256"],
        "sourceDocuments": 25, "sourcePages": 6720,
        "ocrProvider": "mistral", "ocrModel": "mistral-ocr-latest",
        "verificationPolicy": "pdf-crop-and-answer-review-v1",
        "originalPdfVerified": True, "answerKeyVerified": True,
        "mathematicalCorrectnessVerified": True,
        "reviewPolicy": "owner-delegated-agent-direct-pixel-v1",
        "releaseApprovedBy": "repo-owner",
        "reviewedBy": "Codex direct-pixel audit",
        "ownerDelegations": delegations,
        "reviewAudit": {
            "directReviewSha256": hashes, "dualReviewSha256": hashes,
            "selectionSha256": "e" * 64,
        },
        "releaseApproval": {
            "kind": "owner-delegated-agent-starter-private-release-signoff",
            "version": 2, "authorizedBy": "repo-owner",
            "performedBy": "Codex direct-pixel audit",
            "humanPixelReviewClaimed": False,
            "delegatedReviewSha256": hashes,
            "unsignedSourceSha256": "f" * 64,
            "assetManifestSha256": "9" * 64,
            "sampleQuestionIds": [row["id"] for row in questions[:10]],
        },
        "questions": questions,
    }


def trusted_runtime_verification_fixture(
    root: Path,
    *,
    prepared_at: str = "2026-08-30T00:02:00+00:00",
    deployed_at: str = "2026-08-30T00:03:00+00:00",
) -> tuple[Path, Path, Path]:
    """Build evidence through the authoritative runtime verifier, not by hand."""
    harness = runtime_fixtures.PrivateReleaseRuntimeTests(methodName="runTest")
    fixture = harness.fixture(root)
    deployment = json.loads(fixture["deployment"].read_text(encoding="utf-8"))
    previous = b"previous-manifest"
    deployment["preparedAt"] = prepared_at
    deployment["deployedAt"] = deployed_at
    deployment["alias"]["previousSha256"] = hashlib.sha256(previous).hexdigest()
    deployment["alias"]["previousBytesBase64"] = base64.b64encode(previous).decode()
    write_json(fixture["deployment"], deployment)
    output = root / "private-release-runtime-verification.json"
    harness.verify(
        fixture, output, reviews=[fixture["review"]],
        downloader=harness.downloader(fixture["store"]),
    )
    return output, fixture["plan"], fixture["deployment"]


class BlueprintReadinessTests(unittest.TestCase):
    def private_integration_fixture(self, root: Path) -> dict:
        app_version = audit.current_app_version()
        app_source = (ROOT / "app.js").read_text(encoding="utf-8")
        assets_root = root / "assets"
        papers = []
        storage_assets = []
        for paper_id in ["official-110-trial-matha", *(f"official-{year}-matha" for year in range(111, 116))]:
            rows = []
            names = re.findall(
                rf"{paper_id}/(page-\d{{2}}-[a-f0-9]{{12}}\.png)", app_source
            )
            self.assertEqual(len(names), 8)
            for page, name in enumerate(names, start=1):
                relative = f"{paper_id}/{name}"
                path = assets_root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"{paper_id}-{page}".encode())
                row = {"file": relative, "sha256": digest(path), "bytes": path.stat().st_size}
                rows.append(row)
                storage_assets.append(dict(row))
            papers.append({
                "paperId": paper_id, "assets": rows,
                "questionPageMap": [2, 3, 4, 5, 6, 7] + [7] * 14,
            })
        asset_manifest = assets_root / "official-paper-assets.json"
        write_json(asset_manifest, {
            "kind": "matha-official-paper-assets-v1", "releaseAuthority": False,
            "paperCount": 6, "assetCount": 48, "papers": papers,
        })
        visual = assets_root / "visual.json"
        write_json(visual, {
            "schema": 1, "releaseAuthority": False, "papersReviewed": 6, "pagesReviewed": 48,
            "checks": {
                "pageOrder": "pass", "cropCompleteness": "pass",
                "chineseReadability": "pass", "formulaReadability": "pass",
                "diagramPreservation": "pass", "grayscalePreservation": "pass",
                "handwritingPresent": False, "answerLeakageInQuestionPages": False,
            },
        })
        storage = assets_root / "storage.json"
        write_json(storage, {
            "kind": "matha-official-paper-storage-verification-v1",
            "releaseAuthority": False, "readOnlyVerification": True,
            "projectRef": "rrihysbxhsbxjteqmtdu", "bucket": "matha-papers",
            "sourceManifestSha256": digest(asset_manifest), "paperCount": 6,
            "assetCount": 48, "remoteHashMismatches": 0, "assets": storage_assets,
        })
        solution_root = root / "solutions"
        solution_names = sorted(set(re.findall(
            r"paper-official-110-trial/(page-\d{2}-[a-f0-9]{12}\.png)",
            (ROOT / "supabase/functions/openai-proxy/lib.ts").read_text(encoding="utf-8"),
        )))
        self.assertEqual(len(solution_names), 8)
        solution_assets = []
        for name in solution_names:
            relative = f"paper-official-110-trial/{name}"
            path = solution_root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
            solution_assets.append({
                "file": relative, "sha256": digest(path), "bytes": path.stat().st_size,
            })
        solution_manifest = solution_root / "official-solution-assets.json"
        write_json(solution_manifest, {
            "kind": "matha-official-solution-assets-v1", "releaseAuthority": False,
            "projectRef": "rrihysbxhsbxjteqmtdu", "bucket": "matha-solutions",
            "appSourceId": "paper-official-110-trial", "sourcePages": 8,
            "questionPageMap": [1] * 20, "question20ContinuationPage": 8,
            "remoteListingExact": True, "readbackHashMismatches": 0,
            "assets": solution_assets,
        })
        return {
            "status": "deployed-and-hash-verified", "appVersion": app_version,
            "supabaseProjectRef": "rrihysbxhsbxjteqmtdu", "bucket": "matha-papers",
            "officialPapers": 6, "officialPages": 48, "remoteHashMismatches": 0,
            "assetManifestPathHint": str(asset_manifest),
            "assetManifestSha256": digest(asset_manifest),
            "visualReviewPathHint": str(visual), "visualReviewSha256": digest(visual),
            "storageVerificationPathHint": str(storage),
            "storageVerificationSha256": digest(storage),
            "solutionManifestPathHint": str(solution_manifest),
            "solutionManifestSha256": digest(solution_manifest),
            "answerKeyPapersBehindPostSubmitGate": 7, "edgeFunctionVersion": 34,
            "officialDetailedSolutionPapers": 1, "officialSolutionPages": 8,
            "solutionStorageHashMismatches": 0,
            "freshnessStillRequiresUserConfirmation": True,
        }

    def test_local_discovery_requires_exact_report_and_visual_review_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / "report.json"
            review = root / "review.json"
            write_json(report, {
                "kind": "matha-local-full-paper-discovery-v1",
                "releaseAuthority": False,
                "scannedPdfCount": 2,
                "candidates": [{"sha256": "a"}, {"sha256": "b"}],
            })
            write_json(review, {
                "kind": "matha-local-full-paper-discovery-visual-review-v1",
                "releaseAuthority": False,
                "discoveryReport": {"sha256": digest(report), "mathOrExamPathReadErrors": 0},
                "imageOnlyReview": {
                    "allFirstPagesReviewed": True, "uniqueHashes": 1,
                    "mathPaperHashesFound": [],
                },
                "namedCandidateReview": {"newCompleteMathAPaperHashesFound": []},
            })
            row = {
                "reportPathHint": str(report), "reportSha256": digest(report),
                "visualReviewPathHint": str(review), "visualReviewSha256": digest(review),
                "scannedPdfCount": 2, "candidateRows": 2, "candidateUniqueHashes": 2,
                "imageOnlyUniqueHashesVisuallyReviewed": 1,
                "mathOrExamPathReadErrors": 0, "newCompleteMathAPapersFound": 0,
            }
            self.assertEqual(len(audit.validate_local_discovery(row, root)), 3)
            report.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(audit.ReadinessError, "雜湊漂移"):
                audit.validate_local_discovery(row, root)

    def test_full_paper_gate_recomputes_ready_count_and_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "paper.pdf"
            source.write_bytes(b"paper")
            inventory = root / "inventory.json"
            ready = [{
                "id": f"paper-{index}", "questions": 20, "minutes": 100,
                "appSourceId": f"paper-source-{index}",
                "freshness": "confirmed-unseen", "calibrationStatus": "ready-fresh",
            } for index in range(6)]
            write_json(inventory, {
                "schema": 1,
                "privateAppIntegration": self.private_integration_fixture(root),
                "sourceDocuments": [{"id": "source", "fileName": source.name, "sha256": digest(source)}],
                "papers": ready,
            })
            engineering, calibration = audit.audit_full_papers(inventory, root)
            self.assertEqual(engineering["status"], "pass")
            self.assertEqual(engineering["phase"], "engineering")
            self.assertEqual(calibration["status"], "pass")
            self.assertEqual(calibration["phase"], "post-delivery")
            ready[-1]["freshness"] = "unconfirmed"
            ready[-1]["calibrationStatus"] = "reserve-pending-freshness"
            write_json(inventory, {
                "schema": 1,
                "privateAppIntegration": self.private_integration_fixture(root),
                "sourceDocuments": [{"id": "source", "fileName": source.name, "sha256": digest(source)}],
                "papers": ready,
            })
            engineering, calibration = audit.audit_full_papers(inventory, root)
            self.assertEqual(engineering["status"], "pass")
            self.assertEqual(calibration["status"], "blocked")
            self.assertIn("1 回", calibration["blockers"][0])

    def test_device_gate_requires_current_version_hardware_attestation_and_real_actions(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audit.json"
            checks = [{"id": key, "status": "pass"} for key in
                      ("duration", "page", "save", "canvas", "resume", "pdf")]
            write_json(path, {
                "kind": "matha-paper-runtime-audit-v1", "appVersion": audit.current_app_version(),
                "run": {"id": "run-1", "sourceId": "paper-mock-3", "status": "awaiting-correction"},
                "summary": {"passed": True, "checks": checks, "pageP95Ms": 200, "localSaveP95Ms": 100},
                "deviceAttestation": {"confirmed": True, "model": audit.DEVICE_MODEL, "source": "user-confirmation", "browserReportedModel": "SM-X920"},
                "audit": {
                    "schema": 1, "appVersion": audit.current_app_version(),
                    "activeElapsedMs": 6_000_000, "strokesCommitted": 30, "sessions": 2,
                    "pageSwitches": [{"method": "swipe", "ms": 200}],
                    "pendingAtSubmit": 0, "localSaveFailures": 0,
                    "device": {"userAgent": "Mozilla/5.0 (Linux; Android 14; K)", "screenWidth": 1315, "screenHeight": 821},
                },
            })
            self.assertTrue(audit.validate_device_audit(path, "paper-mock-3", audit.current_app_version()))
            value = json.loads(path.read_text("utf-8"))
            value["audit"]["device"]["userAgent"] = "Mozilla/5.0 (Windows NT 10.0)"
            write_json(path, value)
            with self.assertRaisesRegex(audit.ReadinessError, "UA"):
                audit.validate_device_audit(path, "paper-mock-3", audit.current_app_version())

    def test_capability_goal_requires_three_recomputable_fresh_scores_at_72(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "capability-goal-evidence.json"
            generated_at = datetime.now(timezone.utc).replace(microsecond=0)
            generated_ms = int(generated_at.timestamp() * 1000)
            fields = [
                "runId", "sourceId", "submittedAt", "gradedAt", "score", "total",
                "freshnessConfirmedAt", "appVersion", "gradeSummary",
            ]
            runs = []
            for index, score in enumerate((72, 80, 100), start=1):
                questions = []
                remaining = score
                for no in range(1, 21):
                    points = min(5, remaining)
                    remaining -= points
                    questions.append({
                        "no": no, "status": "correct" if points == 5 else "incorrect",
                        "points": points, "maxPoints": 5,
                    })
                counts = {
                    "correct": sum(row["status"] == "correct" for row in questions),
                    "incorrect": sum(row["status"] == "incorrect" for row in questions),
                    "uncertain": 0, "unanswered": 0,
                }
                row = {
                    "runId": f"run-{index}", "sourceId": f"source-{index}",
                    "submittedAt": generated_ms - (4 - index) * 86400000,
                    "gradedAt": generated_ms - (4 - index) * 86400000 + 600000,
                    "score": score, "total": 100,
                    "freshnessConfirmedAt": generated_ms - (4 - index) * 86400000 - 600000,
                    "appVersion": audit.current_app_version(),
                    "gradeSummary": {
                        "questionCount": 20, "awardedPoints": score, "maxPoints": 100,
                        "statusCounts": counts, "questions": questions,
                    },
                }
                row["canonicalDigest"] = audit.canonical_sha({key: row[key] for key in fields})
                runs.append(row)
            value = {
                "kind": "matha-capability-goal-evidence-v1", "schemaVersion": 1,
                "generatedAt": generated_at.isoformat(),
                "appVersion": audit.current_app_version(),
                "baselineResetAt": generated_ms - 30 * 86400000,
                "status": "stable", "stable": True, "blockers": [],
                "goal": {"requiredRuns": 3, "distinctRuns": True, "distinctSources": True,
                         "questionsPerRun": 20, "minutesPerRun": 100,
                         "totalPoints": 100, "minimumScore": 72},
                "calibration": {"source": "external", "count": 3, "passes": 3,
                                "stable": True, "scorePercent": 84, "grade": "13級"},
                "digest": {"algorithm": "SHA-256",
                           "canonicalization": "recursive-key-sorted-json-v1",
                           "runDigestFields": fields},
                "runs": runs,
            }
            value["canonicalDigest"] = audit.canonical_sha({key: value[key] for key in (
                "kind", "schemaVersion", "generatedAt", "appVersion",
                "baselineResetAt", "status", "stable", "blockers", "goal",
                "calibration", "digest", "runs",
            )})
            write_json(path, value)
            self.assertTrue(audit.validate_capability_goal_evidence(path))
            unanswered = json.loads(json.dumps(value))
            first = unanswered["runs"][0]
            first["gradeSummary"]["questions"][0]["status"] = "unanswered"
            first["gradeSummary"]["statusCounts"]["correct"] -= 1
            first["gradeSummary"]["statusCounts"]["unanswered"] += 1
            first["canonicalDigest"] = audit.canonical_sha({
                key: first[key] for key in fields
            })
            unanswered["canonicalDigest"] = audit.canonical_sha({
                key: unanswered[key] for key in (
                    "kind", "schemaVersion", "generatedAt", "appVersion",
                    "baselineResetAt", "status", "stable", "blockers", "goal",
                    "calibration", "digest", "runs",
                )
            })
            write_json(path, unanswered)
            with self.assertRaisesRegex(audit.ReadinessError, "配分"):
                audit.validate_capability_goal_evidence(path)
            value["generatedAt"] = "2020-01-01T00:00:00+00:00"
            write_json(path, value)
            with self.assertRaisesRegex(audit.ReadinessError, "最新快照"):
                audit.validate_capability_goal_evidence(path)
            value["generatedAt"] = generated_at.isoformat()
            value["runs"][0]["score"] = 71
            write_json(path, value)
            with self.assertRaises(audit.ReadinessError):
                audit.validate_capability_goal_evidence(path)

    def test_missing_private_human_evidence_never_becomes_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            review, deployment, runtime, loader = audit.audit_starter(root / "missing")
            self.assertEqual(review["status"], "blocked")
            self.assertEqual(deployment["status"], "blocked")
            self.assertEqual(runtime["status"], "blocked")
            self.assertEqual(loader["status"], "blocked")
            self.assertFalse(audit.approved_gold({"releaseAuthority": True}))
            self.assertFalse(audit.identifiable_human("Codex agent"))

    def test_github_audit_rechecks_live_remote_actions_and_all_published_trust_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "github-delivery-verification.json"
            harness = github_fixtures.GitHubDeliveryTests(methodName="runTest")
            verifier = audit.github_delivery_verifier()
            runner = harness.runner()
            verifier.verify(path, command_runner=runner, fetcher=harness.fetch)
            evidence = audit.validate_github_delivery(
                path, command_runner=runner, fetcher=harness.fetch,
            )
            self.assertTrue(any(item.startswith("publishedCatalog:") for item in evidence))
            with self.assertRaisesRegex(audit.ReadinessError, "遠端 main"):
                audit.validate_github_delivery(
                    path,
                    command_runner=harness.runner(remote_head="b" * 40),
                    fetcher=harness.fetch,
                )

            def catalog_drift(url):
                if "/textbook-catalog.js?" in url:
                    return b"stale-catalog"
                return harness.fetch(url)

            with self.assertRaisesRegex(audit.ReadinessError, "textbook-catalog.js"):
                audit.validate_github_delivery(
                    path, command_runner=runner, fetcher=catalog_drift,
                )

    def test_owner_delegated_multi_batch_starter_is_transparent_and_hash_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "release"
            root.mkdir(parents=True)
            write_json(root / "signed-private-question-source.json", signed_source_value())
            review, deployment, runtime, loader = audit.audit_starter(root)
            self.assertEqual(review["status"], "blocked")
            self.assertIn("direct／dual", review["summary"])
            self.assertEqual(deployment["status"], "blocked")
            self.assertEqual(runtime["status"], "blocked")
            self.assertEqual(loader["status"], "blocked")

    def test_runtime_verification_binds_complete_release_and_current_app(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime_path, plan_path, record_path = trusted_runtime_verification_fixture(Path(temp))
            signed_path = Path(json.loads(plan_path.read_text(encoding="utf-8"))["source"])
            evidence = audit.validate_runtime_verification(
                runtime_path, plan_path, record_path, signed_path,
            )
            self.assertIn(
                "readback:alias=1,versioned=410,questions=217,packs=191,topics=14,answers=217",
                evidence,
            )

            value = json.loads(runtime_path.read_text(encoding="utf-8"))
            value["appJsSha256"] = "0" * 64
            write_json(runtime_path, value)
            with self.assertRaises(audit.ReadinessError):
                audit.validate_runtime_verification(
                    runtime_path, plan_path, record_path, signed_path,
                )

    def test_app_loader_audit_accepts_exact_current_verifier_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            harness = app_loader_fixtures.PrivateAppLoaderTests(methodName="runTest")
            plan, deployment, runtime, store = harness.fixture(root)
            harness.verify(
                root, app_loader_fixtures.FakeBackend(store),
                plan, deployment, runtime,
            )
            runtime_value = json.loads(runtime.read_text(encoding="utf-8"))
            not_before = audit.parse_timestamp(
                runtime_value["verifiedAt"], "Storage 全量讀回",
            )
            evidence = audit.validate_app_loader_verification(
                root / "app-loader.json", plan, deployment, runtime,
                not_before=not_before,
            )
            self.assertTrue(any(item.startswith("loader:packs=191,questions=217")
                                for item in evidence))

    def test_deploy_rollback_final_deploy_and_runtime_must_be_one_ordered_chain(self):
        with tempfile.TemporaryDirectory() as temp:
            release = Path(temp) / "release"
            release.mkdir(parents=True)
            runtime_path, plan_path, final_path = trusted_runtime_verification_fixture(release)
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            final = json.loads(final_path.read_text(encoding="utf-8"))

            first = dict(final)
            first["preparedAt"] = "2026-08-30T00:00:00+00:00"
            first["deployedAt"] = "2026-08-30T00:00:30+00:00"
            first_path = release / "deployment-first.json"
            write_json(first_path, first)
            rollback_path = release / "rollback-drill.json"
            write_json(rollback_path, {
                "kind": "matha-private-storage-rollback", "version": 1,
                "releaseId": plan["releaseId"],
                "rolledBackAt": "2026-08-30T00:01:00+00:00",
                "deploymentRecordSha256": digest(first_path),
                "restoredAliasSha256": first["alias"]["previousSha256"],
            })
            review, deployment, storage, loader = audit.audit_starter(release)
            self.assertEqual(review["status"], "pass")
            self.assertEqual(deployment["status"], "pass")
            self.assertEqual(storage["status"], "pass")
            self.assertEqual(loader["status"], "blocked")

            historical = release / "historical-runtime-verification-copy.json"
            historical.write_bytes(runtime_path.read_bytes())
            broken_pointer = json.loads(runtime_path.read_text(encoding="utf-8"))
            broken_pointer["immutableRecordSha256"] = "0" * 64
            write_json(runtime_path, broken_pointer)
            _, deployment, storage, loader = audit.audit_starter(release)
            self.assertEqual(deployment["status"], "pass")
            self.assertEqual(storage["status"], "fail")
            self.assertEqual(loader["status"], "blocked")

            final["preparedAt"] = "2026-08-30T00:00:40+00:00"
            final["deployedAt"] = "2026-08-30T00:00:50+00:00"
            write_json(final_path, final)
            _, deployment, storage, loader = audit.audit_starter(release)
            self.assertEqual(deployment["status"], "fail")
            self.assertEqual(storage["status"], "blocked")
            self.assertEqual(loader["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
