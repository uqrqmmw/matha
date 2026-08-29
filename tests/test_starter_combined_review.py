import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "prepare_starter_combined_review",
    ROOT / "scripts" / "ingest" / "prepare-starter-combined-review.py",
)
combined = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(combined)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


class StarterCombinedReviewTests(unittest.TestCase):
    def make_fixture(self, root: Path):
        question_id = "q-1"
        queue = root / "batch-01-cleaned-candidates.json"
        pixel = root / "pixel"
        answer = root / "answer"
        (pixel / "assets" / question_id).mkdir(parents=True)
        (pixel / "removed-overlays").mkdir()
        (answer / "assets" / question_id).mkdir(parents=True)
        source = pixel / "assets" / question_id / "source.png"
        cleaned = pixel / "assets" / question_id / "cleaned.png"
        overlay = pixel / "removed-overlays" / f"{question_id}.png"
        question = answer / "assets" / question_id / "question.png"
        official = answer / "assets" / question_id / "answer.png"
        source.write_bytes(b"source")
        cleaned.write_bytes(b"cleaned")
        overlay.write_bytes(b"overlay")
        question.write_bytes(cleaned.read_bytes())
        official.write_bytes(b"official")
        source_hash, cleaned_hash = sha(source), sha(cleaned)
        overlay_hash, answer_hash = sha(overlay), sha(official)
        write_json(queue, {
            "releaseAuthority": False, "questions": 1,
            "items": [{"id": question_id, "bookId": "book-a", "pdfPage": 2,
                       "sourceSha256": source_hash, "cleanedSha256": cleaned_hash}],
        })
        queue_hash = sha(queue)
        pixel_row = {
            "id": question_id, "sourceSha256": source_hash,
            "cleanedSha256": cleaned_hash, "removedOverlaySha256": overlay_hash,
            "decision": "", "visual": {
                "printedContentIntact": None, "allHandwritingRemoved": None,
                "noAnswerOrSolutionLeak": None, "fullQuestionAndOptions": None,
                "figuresAndGreyLinesIntact": None, "chineseTextIntact": None,
                "mathSymbolsAndFormulasIntact": None,
            }, "notes": "",
        }
        write_json(pixel / "review-packet.json", {
            "releaseAuthority": False, "candidateManifestSha256": queue_hash,
            "questions": 1,
        })
        write_json(pixel / "cleaned-handwriting-human-review.template.json", {
            "kind": "matha-private-cleaned-handwriting-human-review", "version": 1,
            "releaseAuthority": False, "humanReviewerRequired": True,
            "candidateManifestSha256": queue_hash, "summary": {},
            "reviewer": "", "reviewedAt": "", "questions": [pixel_row],
        })
        binding = {
            "id": question_id, "bookId": "book-a", "pdfPage": 2, "role": "example",
            "sourceSha256": source_hash, "cleanedSha256": cleaned_hash,
            "answerSha256": answer_hash, "sourcePdfSha256": "f" * 64,
        }
        answer_row = {
            "id": question_id, "cleanedSha256": cleaned_hash,
            "answerSha256": answer_hash, "sourcePdfSha256": "f" * 64,
            "decision": "", "visual": {
                "questionAnswerIdentityVerified": None, "allSubpartsCovered": None,
                "answerLegible": None, "noAdjacentAnswerConfusion": None,
                "figureConditionsHandled": None, "mathematicallyCorrect": None,
            }, "notes": "",
        }
        write_json(answer / "review-packet.json", {
            "releaseAuthority": False, "total": 1, "reviewable": 1, "quarantined": 0,
        })
        write_json(answer / "answer-binding-candidates.json", {
            "releaseAuthority": False, "candidateManifestSha256": queue_hash,
            "items": [binding],
        })
        write_json(answer / "cleaned-answer-human-review.template.json", {
            "kind": "matha-private-cleaned-answer-human-review", "version": 1,
            "releaseAuthority": False, "humanReviewerRequired": True,
            "summary": {}, "reviewer": "", "reviewedAt": "", "questions": [answer_row],
        })
        return queue, pixel, answer

    def test_builds_one_screen_for_both_unchanged_review_formats(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            queue, pixel, answer = self.make_fixture(root)
            output = root / "combined"
            packet = combined.build(queue, pixel, answer, output, 8769)
            html = (output / "review.html").read_text("utf-8")
            self.assertFalse(packet["releaseAuthority"])
            self.assertEqual(packet["questions"], 1)
            self.assertIn("cleaned-handwriting-human-review.json", html)
            self.assertIn("cleaned-answer-human-review.json", html)
            self.assertIn("mathematicallyCorrect", html)
            self.assertIn("allHandwritingRemoved", html)
            self.assertIn("source.png", html)
            self.assertIn("answer.png", html)
            script = html.rsplit("<script>", 1)[1].split("</script>", 1)[0]
            script_path = root / "inline.js"
            script_path.write_text(script, encoding="utf-8")
            check = subprocess.run(["node", "--check", str(script_path)],
                                   capture_output=True, text=True)
            self.assertEqual(check.returncode, 0, check.stderr)

    def test_refuses_private_combined_packet_inside_repo(self):
        with tempfile.TemporaryDirectory() as temp:
            queue, pixel, answer = self.make_fixture(Path(temp))
            with self.assertRaises(combined.CombinedReviewError):
                combined.build(queue, pixel, answer, ROOT / "private-review-output", 8769)


if __name__ == "__main__":
    unittest.main()
