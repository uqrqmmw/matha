import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "validate_starter_review_packets",
    ROOT / "scripts" / "ingest" / "validate-starter-review-packets.py",
)
validator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(validator)


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class StarterReviewPacketTests(unittest.TestCase):
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
        answer_question = answer / "assets" / question_id / "question.png"
        answer_image = answer / "assets" / question_id / "answer.png"
        source.write_bytes(b"source")
        cleaned.write_bytes(b"cleaned")
        overlay.write_bytes(b"overlay")
        answer_question.write_bytes(cleaned.read_bytes())
        answer_image.write_bytes(b"official-answer")

        source_hash, cleaned_hash = sha(source), sha(cleaned)
        answer_hash, overlay_hash = sha(answer_image), sha(overlay)
        write_json(queue, {
            "releaseAuthority": False,
            "questions": 1,
            "items": [{
                "id": question_id,
                "sourceSha256": source_hash,
                "cleanedSha256": cleaned_hash,
            }],
        })
        queue_hash = sha(queue)

        write_json(pixel / "review-packet.json", {
            "releaseAuthority": False,
            "candidateManifestSha256": queue_hash,
            "questions": 1,
        })
        write_json(pixel / "cleaned-handwriting-human-review.template.json", {
            "releaseAuthority": False,
            "candidateManifestSha256": queue_hash,
            "questions": [{
                "id": question_id,
                "sourceSha256": source_hash,
                "cleanedSha256": cleaned_hash,
                "removedOverlaySha256": overlay_hash,
            }],
        })

        source_pdf_hash = "f" * 64
        binding = {
            "id": question_id,
            "sourceSha256": source_hash,
            "cleanedSha256": cleaned_hash,
            "answerSha256": answer_hash,
            "sourcePdfSha256": source_pdf_hash,
        }
        write_json(answer / "review-packet.json", {
            "releaseAuthority": False,
            "total": 1,
            "reviewable": 1,
            "quarantined": 0,
        })
        write_json(answer / "answer-binding-candidates.json", {
            "releaseAuthority": False,
            "candidateManifestSha256": queue_hash,
            "items": [binding],
        })
        write_json(answer / "cleaned-answer-human-review.template.json", {
            "releaseAuthority": False,
            "questions": [binding],
        })
        return queue, pixel, answer, answer_image

    def test_validates_exact_pixel_and_answer_bindings(self):
        with tempfile.TemporaryDirectory() as temp:
            queue, pixel, answer, _ = self.make_fixture(Path(temp))
            result = validator.validate_batch(queue, pixel, answer)
        self.assertEqual(result["questions"], 1)

    def test_rejects_answer_pixel_hash_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            queue, pixel, answer, answer_image = self.make_fixture(Path(temp))
            answer_image.write_bytes(b"tampered")
            with self.assertRaises(validator.PacketValidationError):
                validator.validate_batch(queue, pixel, answer)


if __name__ == "__main__":
    unittest.main()
