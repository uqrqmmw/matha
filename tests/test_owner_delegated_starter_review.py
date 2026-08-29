import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / "ingest" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


delegated = load("owner_delegated_review", "intersect-owner-delegated-review.py")
decision_builder = load("owner_delegated_decision_builder", "build-owner-delegated-decisions.py")
release = load("starter_private_release_owner", "prepare-starter-private-release.py")


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


class OwnerDelegatedStarterReviewTests(unittest.TestCase):
    def make_packet(self, root):
        qid = "q-1"
        candidate = root / "candidate.json"
        write(candidate, {"releaseAuthority": False, "items": [{
            "id": qid, "sourceSha256": "1" * 64, "cleanedSha256": "2" * 64,
            "stemRegion": [0, 0, 100, 100], "cropDpi": 300, "cleaned": "cleaned.png",
        }]})
        pixel = root / "pixel.json"
        write(pixel, {"releaseAuthority": False,
                      "candidateManifestSha256": delegated.sha256(candidate), "questions": [{
                          "id": qid, "sourceSha256": "1" * 64, "cleanedSha256": "2" * 64,
                          "removedOverlaySha256": "3" * 64,
                      }]})
        binding = root / "binding.json"
        write(binding, {"releaseAuthority": False,
                        "candidateManifestSha256": delegated.sha256(candidate), "items": [{
                            "id": qid, "bookId": "matha-114-real-number-line", "chapter": "實數",
                            "role": "example", "questionType": "worked-example", "pdfPage": 4,
                            "answerPdfPage": 4, "answerRegion": [0, 0, 100, 100],
                            "answerSource": "inline", "cleanedSha256": "2" * 64,
                            "answerSha256": "4" * 64, "sourcePdfSha256": "5" * 64,
                            "figureCount": 0, "figureSha256": [],
                        }]})
        answer = root / "answer.json"
        write(answer, {"releaseAuthority": False,
                       "candidateManifestSha256": delegated.sha256(candidate),
                       "answerBindingSha256": delegated.sha256(binding), "questions": [{
                           "id": qid, "cleanedSha256": "2" * 64,
                           "answerSha256": "4" * 64, "sourcePdfSha256": "5" * 64,
                       }]})
        decisions = root / "decisions.json"
        checks = {
            "pixelChecks": {key: True for key in delegated.PIXEL_CHECKS},
            "answerChecks": {key: True for key in delegated.ANSWER_CHECKS},
        }
        decision_value = {
            "kind": delegated.REVIEW_KIND, "version": 1, "releaseAuthority": False,
            "reviewPolicy": delegated.REVIEW_POLICY,
            "reviewedBy": "Codex direct-pixel audit", "reviewedAt": "2026-08-29T15:00:00+08:00",
            "delegation": {"kind": "owner-delegated-agent-content-review",
                           "authorizedBy": "repo-owner", "authorizedAt": "2026-08-29T14:00:00+08:00",
                           "scope": "starter batch direct review",
                           "basis": "Owner explicitly delegated this exact private content review."},
            "exactInputs": {"candidateManifestSha256": delegated.sha256(candidate),
                            "pixelTemplateSha256": delegated.sha256(pixel),
                            "answerBindingSha256": delegated.sha256(binding),
                            "answerTemplateSha256": delegated.sha256(answer)},
            "passAttestation": {"appliesToEveryPassedQuestion": True, **checks},
            "questions": [{"id": qid, "pixelDecision": "pass", "answerDecision": "pass",
                           "structuredAnswer": {"schema": 1, "mode": "text",
                                                "officialAnswerText": "1/2"}}],
        }
        write(decisions, decision_value)
        return candidate, pixel, binding, answer, decisions, decision_value

    def test_full_hash_bound_agent_review_is_transparent_and_eligible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = self.make_packet(root)
            output = root / "intersection.json"
            result = delegated.build(*paths[:5], output)
            self.assertEqual(result["counts"], {"totalCandidates": 1, "eligible": 1,
                                                "quarantined": 0})
            self.assertFalse(result["humanReviewClaimed"])
            self.assertEqual(result["reviewPolicy"], delegated.REVIEW_POLICY)

    def test_compact_decision_spec_expands_checks_and_binds_exact_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate, pixel, binding, answer, _, decision_value = self.make_packet(root)
            spec = root / "spec.json"
            write(spec, {
                "reviewedBy": decision_value["reviewedBy"],
                "reviewedAt": decision_value["reviewedAt"],
                "delegation": decision_value["delegation"],
                "questions": [{"id": "q-1", "answerText": "1/2"}],
            })
            output = root / "built-decisions.json"
            result = decision_builder.build(candidate, pixel, binding, answer,
                                            spec, None, output)
            value = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["questions"], 1)
            self.assertEqual(value["exactInputs"]["candidateManifestSha256"],
                             delegated.sha256(candidate))
            self.assertTrue(value["passAttestation"]["pixelChecks"]["printedContentIntact"])
            self.assertEqual(value["questions"][0]["structuredAnswer"]["officialAnswerText"],
                             "1/2")

    def test_missing_printed_official_answer_attestation_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate, pixel, binding, answer, decisions, value = self.make_packet(root)
            value["passAttestation"]["answerChecks"]["printedOfficialAnswerPresent"] = False
            write(decisions, value)
            with self.assertRaisesRegex(delegated.DelegatedReviewError, "attestation"):
                delegated.build(candidate, pixel, binding, answer, decisions, root / "out.json")

    def test_owner_finalize_records_agent_without_claiming_human_pixel_review(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, _, _, _, decisions, review_value = self.make_packet(root)
            source = root / "source.json"
            assets = root / "assets.json"
            source_value = {
                "kind": "private-question-source", "releaseId": "starter-test1234",
                "releaseApprovedBy": None, "reviewPolicy": release.OWNER_DELEGATED_POLICY,
                "ownerDelegation": review_value["delegation"],
                "reviewAudit": {"directReviewSha256": [release.sha256(decisions)]},
                "releaseReviewSampleQuestionIds": ["q-1"], "questions": [{"id": "q-1"}],
            }
            write(source, source_value)
            write(assets, {"kind": "matha-starter-private-asset-manifest",
                           "questions": [{"id": "q-1"}]})
            output = root / "signed.json"
            result = release.finalize_owner_delegated(source, assets, [decisions], output)
            signed = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["authorizedBy"], "repo-owner")
            self.assertEqual(signed["releaseApproval"]["performedBy"], "Codex direct-pixel audit")
            self.assertFalse(signed["releaseApproval"]["humanPixelReviewClaimed"])


if __name__ == "__main__":
    unittest.main()
