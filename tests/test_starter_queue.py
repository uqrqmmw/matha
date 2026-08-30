import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_cleaned_starter_queue",
    ROOT / "scripts" / "ingest" / "build-cleaned-starter-queue.py",
)
starter = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(starter)


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class StarterQueueTests(unittest.TestCase):
    def make_fixture(self, root: Path):
        topics = {topic: f"Topic {index:02d}"
                  for index, topic in enumerate(sorted(starter.APP_TOPICS))}
        books = {
            f"book-{index:02d}": [{
                "fromPdfPage": 1,
                "toPdfPage": 2,
                "topic": topic,
                "confidence": "high",
                "evidence": "test",
            }]
            for index, topic in enumerate(topics)
        }
        topic_map = root / "topic-map.json"
        write_json(topic_map, {"schema": 1, "topics": topics, "books": books})

        candidate_items = []
        answer_items = []
        answer_root = root / "answers"
        for index, topic in enumerate(topics):
            for page in (1, 2):
                qid = f"q-{index:02d}-{page}"
                asset = root / qid
                asset.mkdir()
                source = asset / "source.png"
                cleaned = asset / "cleaned.png"
                source.write_bytes(f"source-{qid}".encode())
                cleaned.write_bytes(f"cleaned-{qid}".encode())
                answer_asset = answer_root / "assets" / qid
                answer_asset.mkdir(parents=True)
                question = answer_asset / "question.png"
                answer = answer_asset / "answer.png"
                question.write_bytes(cleaned.read_bytes())
                answer.write_bytes(f"answer-{qid}".encode())
                source_hash, cleaned_hash = sha(source), sha(cleaned)
                candidate_items.append({
                    "id": qid,
                    "bookId": f"book-{index:02d}",
                    "pdfPage": page,
                    "source": str(source),
                    "cleaned": str(cleaned),
                    "sourceSha256": source_hash,
                    "cleanedSha256": cleaned_hash,
                })
                answer_items.append({
                    "id": qid,
                    "bookId": f"book-{index:02d}",
                    "pdfPage": page,
                    "sourceSha256": source_hash,
                    "cleanedSha256": cleaned_hash,
                    "role": "example",
                    "figureCount": page % 2,
                    "questionType": "single-choice",
                    "answerPdfPage": 99,
                    "answerSource": "answer-key",
                    "answerSha256": sha(answer),
                })
        candidates = root / "candidates.json"
        write_json(candidates, {
            "schema": 1,
            "kind": "cleaned-page-question-candidates",
            "releaseAuthority": False,
            "items": candidate_items,
        })
        binding = answer_root / "answer-binding.json"
        write_json(binding, {
            "schema": 1,
            "kind": "cleaned-answer-binding-candidates",
            "releaseAuthority": False,
            "candidateManifestSha256": sha(candidates),
            "items": answer_items,
        })
        return topics, topic_map, candidates, binding

    def test_topic_map_requires_fourteen_non_overlapping_topics(self):
        topics = {topic: topic for topic in starter.APP_TOPICS}
        first, second = sorted(topics)[:2]
        with self.assertRaisesRegex(starter.StarterQueueError, "Overlapping"):
            starter.validate_topic_map({
                "schema": 1,
                "topics": topics,
                "books": {"book": [
                    {"fromPdfPage": 1, "toPdfPage": 2, "topic": first, "confidence": "high"},
                    {"fromPdfPage": 2, "toPdfPage": 3, "topic": second, "confidence": "high"},
                ]},
            })

    def test_large_queue_scales_role_mix_instead_of_filling_with_examples(self):
        self.assertEqual(starter.role_targets(26), {
            "example": 8,
            "chapter-end-easy": 5,
            "chapter-end-medium": 9,
            "chapter-end-hard": 4,
        })
        rows = []
        for book in ("book-a", "book-b"):
            for role in starter.ROLES:
                for index in range(12):
                    rows.append({
                        "id": f"{book}-{role}-{index}",
                        "bookId": book,
                        "pdfPage": index + 1,
                        "role": role,
                        "figureCount": index % 2,
                    })
        selected = starter.select_topic(rows, 26)
        roles = {role: sum(row["role"] == role for row in selected)
                 for role in starter.ROLES}
        books = {book: sum(row["bookId"] == book for row in selected)
                 for book in ("book-a", "book-b")}
        self.assertEqual(roles, starter.role_targets(26))
        self.assertEqual(books, {"book-a": 13, "book-b": 13})

    def test_original_pdf_verified_cross_topic_boundaries_are_high_confidence(self):
        topic_map = json.loads(starter.DEFAULT_TOPIC_MAP.read_text("utf-8"))
        linear = topic_map["books"]["matha-114-linear-transform"]
        cramer = topic_map["books"]["matha-114-cramer-circle"]
        self.assertEqual([(row["fromPdfPage"], row["toPdfPage"], row["topic"])
                          for row in linear], [(1, 118, "mat"), (119, 238, "splane")])
        self.assertEqual([(row["fromPdfPage"], row["toPdfPage"], row["topic"])
                          for row in cramer], [(1, 86, "line"), (87, 146, "mat"),
                                               (147, 304, "line")])
        self.assertTrue(all(row["confidence"] == "high" for row in linear + cramer))
        self.assertTrue(all(str(row["evidence"]).startswith("verified-original-pdf-")
                            for row in linear + cramer))

    def test_build_balances_all_topics_and_keeps_review_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            topics, topic_map, candidates, binding = self.make_fixture(root)
            output = root / "output"
            result = starter.build(candidates, binding, topic_map, output, 1, 7)
            selection = json.loads((output / "starter-review-selection.json").read_text("utf-8"))
        self.assertEqual(result["selected"], 14)
        self.assertEqual(len(result["batches"]), 2)
        self.assertFalse(selection["releaseAuthority"])
        self.assertFalse(selection["studentReady"])
        self.assertEqual(set(topics), {row["topic"] for row in selection["items"]})

    def test_identity_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, topic_map, candidates, binding = self.make_fixture(root)
            value = json.loads(binding.read_text("utf-8"))
            value["items"][0]["cleanedSha256"] = "0" * 64
            write_json(binding, value)
            with self.assertRaisesRegex(starter.StarterQueueError, "identity mismatch"):
                starter.build(candidates, binding, topic_map, root / "output", 1, 7)

    def test_explicit_exclusion_is_replaced_and_bound_into_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, topic_map, candidates, binding = self.make_fixture(root)
            exclusions = root / "exclusions.json"
            write_json(exclusions, {
                "schema": 1,
                "kind": "matha-starter-review-exclusions",
                "items": [{"id": "q-00-1", "reason": "visible pixel defect"}],
            })
            exclusions_hash = sha(exclusions)
            output = root / "output"
            result = starter.build(candidates, binding, topic_map, output, 1, 7, exclusions)
            selection = json.loads((output / "starter-review-selection.json").read_text("utf-8"))
        ids = {row["id"] for row in selection["items"]}
        self.assertNotIn("q-00-1", ids)
        self.assertIn("q-00-2", ids)
        self.assertEqual(result["explicitExclusions"], 1)
        self.assertEqual(selection["exclusionsSha256"], exclusions_hash)

    def test_prior_selection_is_excluded_and_hash_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, topic_map, candidates, binding = self.make_fixture(root)
            prior = root / "prior-selection.json"
            write_json(prior, {
                "schema": 1,
                "kind": "matha-cleaned-starter-review-selection",
                "candidateManifestSha256": sha(candidates),
                "items": [{"id": "q-00-1"}],
            })
            prior_path = str(prior.resolve())
            prior_hash = sha(prior)
            output = root / "output"
            result = starter.build(
                candidates, binding, topic_map, output, 1, 7,
                prior_selection_paths=[prior],
            )
            selection = json.loads((output / "starter-review-selection.json").read_text("utf-8"))
        ids = {row["id"] for row in selection["items"]}
        self.assertNotIn("q-00-1", ids)
        self.assertIn("q-00-2", ids)
        self.assertEqual(result["previouslySelectedExclusions"], 1)
        self.assertEqual(selection["priorSelections"], [{
            "path": prior_path,
            "sha256": prior_hash,
            "questions": 1,
        }])

    def test_prior_selection_must_bind_same_candidate_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, topic_map, candidates, binding = self.make_fixture(root)
            prior = root / "prior-selection.json"
            write_json(prior, {
                "schema": 1,
                "kind": "matha-cleaned-starter-review-selection",
                "candidateManifestSha256": "0" * 64,
                "items": [{"id": "q-00-1"}],
            })
            with self.assertRaisesRegex(starter.StarterQueueError, "mismatched prior"):
                starter.build(
                    candidates, binding, topic_map, root / "output", 1, 7,
                    prior_selection_paths=[prior],
                )

    def test_long_term_queue_can_record_sparse_topic_inventory_without_padding(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            topics, topic_map, candidates, binding = self.make_fixture(root)
            prior = root / "prior-selection.json"
            write_json(prior, {
                "schema": 1,
                "kind": "matha-cleaned-starter-review-selection",
                "candidateManifestSha256": sha(candidates),
                "items": [{"id": "q-00-1"}],
            })
            with self.assertRaisesRegex(starter.StarterQueueError, "only 1/2"):
                starter.build(
                    candidates, binding, topic_map, root / "strict-output", 2, 7,
                    prior_selection_paths=[prior],
                )
            output = root / "long-term-output"
            result = starter.build(
                candidates, binding, topic_map, output, 2, 7,
                prior_selection_paths=[prior], allow_topic_shortfall=True,
            )
            selection = json.loads((output / "starter-review-selection.json").read_text("utf-8"))
        first_topic = sorted(topics)[0]
        first_summary = next(row for row in selection["topicSummary"]
                             if row["topic"] == first_topic)
        self.assertEqual(result["selected"], 27)
        self.assertTrue(selection["allowTopicShortfall"])
        self.assertEqual(first_summary["selected"], 1)
        self.assertEqual(first_summary["requested"], 2)
        self.assertEqual(first_summary["inventoryShortfall"], 1)
        self.assertEqual(result["topicInventoryShortfalls"], {first_topic: 1})


if __name__ == "__main__":
    unittest.main()
