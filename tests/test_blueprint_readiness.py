import argparse
import hashlib
import importlib.util
import json
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
                "freshness": "confirmed-unseen", "calibrationStatus": "ready-fresh",
            } for index in range(6)]
            write_json(inventory, {
                "schema": 1,
                "sourceDocuments": [{"id": "source", "fileName": source.name, "sha256": digest(source)}],
                "papers": ready,
            })
            self.assertEqual(audit.audit_full_papers(inventory, root)["status"], "pass")
            ready.pop()
            write_json(inventory, {
                "schema": 1,
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


if __name__ == "__main__":
    unittest.main()
