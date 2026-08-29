import hashlib
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "advance_starter_release",
    ROOT / "scripts" / "ingest" / "advance-starter-release.py",
)
advance = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(advance)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class AdvanceStarterReleaseTests(unittest.TestCase):
    def make_layout(self, root: Path):
        private = root / "private"
        downloads = root / "downloads"
        pdf_root = root / "pdfs"
        work = root / "workflow"
        downloads.mkdir()
        pdf_root.mkdir()
        paths = advance.batch_paths(private, 1)
        for index, path in enumerate(paths.values()):
            write_json(path, {"fixture": index})
        candidate_hash = sha(paths["candidate"])
        pixel = downloads / "cleaned-handwriting-human-review.json"
        answer = downloads / "cleaned-answer-human-review (1).json"
        common = {
            "version": 1, "releaseAuthority": False,
            "candidateManifestSha256": candidate_hash,
            "reviewer": "王小明", "reviewedAt": "2026-08-29T10:00:00+08:00",
            "questions": [],
        }
        write_json(pixel, {**common, "kind": "matha-private-cleaned-handwriting-human-review"})
        write_json(answer, {
            **common, "kind": "matha-private-cleaned-answer-human-review",
            "structuredAnswerRequired": True,
        })
        return private, downloads, pdf_root, work, paths, pixel, answer

    def test_discovery_is_hash_bound_and_rejects_ambiguous_latest_exports(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            private, downloads, _, _, paths, pixel, _ = self.make_layout(root)
            found = advance.discover_review(
                downloads,
                kind="matha-private-cleaned-handwriting-human-review",
                candidate_hash=sha(paths["candidate"]), explicit=None,
            )
            self.assertEqual(found, pixel.resolve())
            wrong = downloads / "cleaned-handwriting-human-review-old.json"
            value = json.loads(pixel.read_text("utf-8"))
            write_json(wrong, {**value, "candidateManifestSha256": "0" * 64})
            self.assertEqual(advance.discover_review(
                downloads, kind=value["kind"],
                candidate_hash=sha(paths["candidate"]), explicit=None,
            ), pixel.resolve())
            conflict = downloads / "cleaned-handwriting-human-review (2).json"
            write_json(conflict, {**value, "reviewer": "陳老師"})
            with self.assertRaisesRegex(advance.AdvanceError, "ambiguous"):
                advance.discover_review(
                    downloads, kind=value["kind"],
                    candidate_hash=sha(paths["candidate"]), explicit=None,
                )

    def test_stage_and_finalize_are_resumable_but_refuse_input_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            private, downloads, pdf_root, work, paths, pixel, answer = self.make_layout(root)
            stale = work / "release-preparation.partial"
            stale.mkdir(parents=True)
            (stale / "incomplete.txt").write_text("crashed", encoding="utf-8")

            def fake_intersect(candidate, pixel_template, pixel_review,
                               answer_binding, answer_review, output):
                document = {
                    "kind": "matha-private-cleaned-dual-review-candidates",
                    "releaseAuthority": False, "uploadPerformed": False,
                    "candidateManifestSha256": sha(candidate),
                    "pixelReviewTemplateSha256": sha(pixel_template),
                    "pixelReviewSha256": sha(pixel_review),
                    "answerBindingSha256": sha(answer_binding),
                    "answerReviewSha256": sha(answer_review),
                    "items": [{"id": "q-1"}],
                }
                write_json(output, document)
                return document

            def fake_prepare(dual_files, selection, _pdf_root, output):
                output.mkdir(parents=True)
                source = output / "unsigned-private-question-source.json"
                assets = output / "asset-manifest.json"
                write_json(source, {"kind": "private-question-source", "releaseId": "starter-fixture"})
                write_json(assets, {"kind": "matha-starter-private-asset-manifest"})
                (output / "release-review.html").write_text("review", encoding="utf-8")
                packet = {
                    "kind": "matha-starter-private-release-review-packet",
                    "releaseAuthority": False, "releaseId": "starter-fixture",
                    "sampleSize": 1, "selectionSha256": sha(selection),
                    "dualReviewSha256": [sha(dual_files[0])],
                    "unsignedSourceSha256": sha(source),
                    "assetManifestSha256": sha(assets),
                }
                write_json(output / "release-review-packet.json", packet)
                return packet

            with mock.patch.object(advance.intersection, "intersect", side_effect=fake_intersect) as intersect_mock, \
                    mock.patch.object(advance.release, "prepare", side_effect=fake_prepare) as prepare_mock:
                result = advance.stage(
                    batch_number=1, private_root=private, downloads=downloads,
                    pdf_root=pdf_root, work_root=work,
                    pixel_review=None, answer_review=None,
                )
                self.assertEqual(result["phase"], "awaiting-release-signoff")
                self.assertEqual(result["eligibleQuestions"], 1)
                self.assertFalse((work / "release-preparation.partial").exists())
                advance.stage(
                    batch_number=1, private_root=private, downloads=downloads,
                    pdf_root=pdf_root, work_root=work,
                    pixel_review=None, answer_review=None,
                )
                self.assertEqual(intersect_mock.call_count, 1)
                self.assertEqual(prepare_mock.call_count, 1)

            source = work / "release-preparation" / "unsigned-private-question-source.json"
            asset = work / "release-preparation" / "asset-manifest.json"
            signoff = downloads / "starter-private-release-signoff.json"
            write_json(signoff, {
                "kind": "matha-starter-private-release-signoff",
                "releaseId": "starter-fixture",
                "unsignedSourceSha256": sha(source),
                "approvedAt": "2026-08-29T11:00:00+08:00",
            })

            def fake_finalize(source_file, asset_file, signoff_file, output_file):
                write_json(output_file, {
                    "kind": "private-question-source", "releaseId": "starter-fixture",
                    "releaseApproval": {
                        "signoffSha256": sha(signoff_file),
                        "unsignedSourceSha256": sha(source_file),
                        "assetManifestSha256": sha(asset_file),
                    },
                })

            def fake_assemble(signed_file, _promotion_root, output):
                (output / "matha-content").mkdir(parents=True)
                (output / "matha-figures").mkdir(parents=True)
                plan_file = output / "upload-plan.json"
                write_json(plan_file, {
                    "kind": "matha-private-storage-upload-plan", "version": 1,
                    "releaseReady": True, "uploadPerformed": False,
                    "releaseId": "starter-fixture", "sourceSha256": sha(signed_file),
                    "summary": {"questions": 1},
                    "buckets": {
                        "matha-content": {"root": str(output / "matha-content"), "files": []},
                        "matha-figures": {"root": str(output / "matha-figures"), "files": []},
                    },
                })
                return {"uploadPlan": str(plan_file)}

            def fake_validate(plan_file):
                plan = json.loads(plan_file.read_text("utf-8"))
                return plan, [{"path": "releases/starter-fixture/content/a.json"}], {
                    "path": "manifest-mistral-ocr4-verified-v1.json"
                }

            with mock.patch.object(advance.release, "finalize", side_effect=fake_finalize) as finalize_mock, \
                    mock.patch.object(advance.bundle, "assemble", side_effect=fake_assemble) as assemble_mock, \
                    mock.patch.object(advance.deployment, "validate_plan", side_effect=fake_validate):
                ready = advance.finalize(work_root=work, downloads=downloads, signoff=None)
                self.assertEqual(ready["phase"], "ready-for-explicit-supabase-deploy")
                self.assertEqual(ready["questions"], 1)
                rebased = json.loads((work / "private-bundle" / "upload-plan.json").read_text("utf-8"))
                self.assertEqual(
                    Path(rebased["buckets"]["matha-content"]["root"]),
                    (work / "private-bundle" / "matha-content").resolve(),
                )
                advance.finalize(work_root=work, downloads=downloads, signoff=None)
                self.assertEqual(finalize_mock.call_count, 1)
                self.assertEqual(assemble_mock.call_count, 1)

            pixel.write_text(pixel.read_text("utf-8") + " ", encoding="utf-8")
            with self.assertRaisesRegex(advance.AdvanceError, "does not match current input"):
                advance.stage(
                    batch_number=1, private_root=private, downloads=downloads,
                    pdf_root=pdf_root, work_root=work,
                    pixel_review=pixel, answer_review=answer,
                )


if __name__ == "__main__":
    unittest.main()
