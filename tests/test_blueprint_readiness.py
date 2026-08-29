import argparse
import hashlib
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "audit_blueprint_readiness", ROOT / "scripts" / "audit-blueprint-readiness.py"
)
audit = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(audit)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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
            self.assertEqual(audit.audit_full_papers(inventory, root)["status"], "pass")
            ready.pop()
            write_json(inventory, {
                "schema": 1,
                "privateAppIntegration": self.private_integration_fixture(root),
                "sourceDocuments": [{"id": "source", "fileName": source.name, "sha256": digest(source)}],
                "papers": ready,
            })
            result = audit.audit_full_papers(inventory, root)
            self.assertEqual(result["status"], "blocked")
            self.assertIn("1 回", result["blockers"][0])

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

    def test_missing_private_human_evidence_never_becomes_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            review, deployment = audit.audit_starter(root / "missing")
            self.assertEqual(review["status"], "blocked")
            self.assertEqual(deployment["status"], "blocked")
            self.assertFalse(audit.approved_gold({"releaseAuthority": True}))
            self.assertFalse(audit.identifiable_human("Codex agent"))

    def test_owner_delegated_multi_batch_starter_is_transparent_and_hash_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "release"
            root.mkdir(parents=True)
            hashes = ["a" * 64, "b" * 64]
            write_json(root / "signed-private-question-source.json", {
                "kind": "private-question-source", "releaseId": "starter-fixture",
                "reviewPolicy": "owner-delegated-agent-direct-pixel-v1",
                "releaseApprovedBy": "repo-owner",
                "reviewAudit": {"directReviewSha256": hashes},
                "releaseApproval": {
                    "kind": "owner-delegated-agent-starter-private-release-signoff",
                    "version": 2, "authorizedBy": "repo-owner",
                    "performedBy": "Codex direct-pixel audit",
                    "humanPixelReviewClaimed": False,
                    "delegatedReviewSha256": hashes,
                },
                "questions": [{"id": f"q-{index}"} for index in range(100)],
            })
            review, deployment = audit.audit_starter(root)
            self.assertEqual(review["status"], "pass")
            self.assertIn("100 題", review["summary"])
            self.assertEqual(deployment["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
