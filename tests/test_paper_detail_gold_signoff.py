import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "paper_detail_gold_signoff", ROOT / "scripts" / "prepare-paper-detail-gold-signoff.py"
)
signer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(signer)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class PaperDetailGoldSignoffTests(unittest.TestCase):
    def fixture(self, root: Path, numbers=None):
        numbers = list(numbers or [3, 4, 11, 12, 13, 14, 16])
        assets = root / "assets"
        assets.mkdir()
        source = root / "source.pdf"
        source.write_bytes(b"source")
        cases = []
        for no in numbers:
            student = assets / f"q{no}-student.png"
            solution = assets / f"q{no}-solution.png"
            student.write_bytes(f"student-{no}".encode())
            solution.write_bytes(f"solution-{no}".encode())
            mode = "abstain" if no in {3, 4, 16} else "diagnose"
            cases.append({
                "no": no, "officialAnswer": "(1)", "expectedMode": mode,
                "firstErrorEvidenceAliases": [] if mode == "abstain" else [f"wrong-{no}"],
                "goodWorkEvidenceAliases": [], "reviewNote": "fixture",
                "studentEvidence": {"file": student.name, "sha256": sha(student)},
                "solutionEvidence": [{"file": solution.name, "sha256": sha(solution)}],
            })
        gold = root / "gold.json"
        write_json(gold, {
            "schema": 1, "id": "detail-fixture", "visibility": "private-local-only",
            "releaseAuthority": False, "assetRoot": str(assets),
            "sources": {"paper": {"path": str(source), "sha256": sha(source)}},
            "cases": cases,
        })
        return gold, numbers

    def test_prepare_and_finalize_require_exact_complete_named_human_signoff(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            gold, numbers = self.fixture(root)
            review = root / "review"
            result = signer.prepare(gold, review)
            self.assertEqual(result["questions"], 7)
            self.assertTrue((review / "review.html").is_file())
            packet = review / "review-packet.json"
            signoff = root / "signoff.json"
            write_json(signoff, {
                "kind": "matha-paper-detail-gold-signoff", "version": 1,
                "releaseAuthority": True, "approvedBy": "王老師",
                "approvedAt": "2026-08-29T10:00:00+08:00", "statement": signer.STATEMENT,
                "goldId": "detail-fixture", "unsignedGoldSha256": sha(gold),
                "reviewPacketSha256": sha(packet), "questionNos": numbers,
                "checks": [{"no": no, **{field: True for field in signer.CHECK_FIELDS}}
                           for no in numbers],
            })
            signed = root / "signed.json"
            final = signer.finalize(gold, packet, signoff, signed)
            self.assertEqual(final["questions"], 7)
            value = json.loads(signed.read_text("utf-8"))
            self.assertTrue(value["releaseAuthority"])
            self.assertEqual(value["releaseApproval"]["signoffSha256"], sha(signoff))

    def test_finalize_refuses_agent_name_incomplete_checks_and_hash_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            gold, numbers = self.fixture(root)
            review = root / "review"
            signer.prepare(gold, review)
            packet = review / "review-packet.json"
            base = {
                "kind": "matha-paper-detail-gold-signoff", "version": 1,
                "releaseAuthority": True, "approvedBy": "Codex agent",
                "approvedAt": "2026-08-29T10:00:00+08:00", "statement": signer.STATEMENT,
                "goldId": "detail-fixture", "unsignedGoldSha256": sha(gold),
                "reviewPacketSha256": sha(packet), "questionNos": numbers,
                "checks": [{"no": no, **{field: True for field in signer.CHECK_FIELDS}}
                           for no in numbers],
            }
            signoff = root / "signoff.json"
            write_json(signoff, base)
            with self.assertRaisesRegex(signer.DetailSignoffError, "identifiable human"):
                signer.finalize(gold, packet, signoff, root / "signed.json")
            base["approvedBy"] = "王老師"
            base["checks"][0][signer.CHECK_FIELDS[0]] = False
            write_json(signoff, base)
            with self.assertRaisesRegex(signer.DetailSignoffError, "complete every"):
                signer.finalize(gold, packet, signoff, root / "signed.json")
            base["checks"][0][signer.CHECK_FIELDS[0]] = True
            base["unsignedGoldSha256"] = "0" * 64
            write_json(signoff, base)
            with self.assertRaisesRegex(signer.DetailSignoffError, "hash contract"):
                signer.finalize(gold, packet, signoff, root / "signed.json")

    def test_one_and_thirty_case_packets_are_dynamic_and_hash_bound(self):
        for count in (1, 30):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                numbers = list(range(1, count + 1))
                gold, numbers = self.fixture(root, numbers)
                review = root / "review"
                result = signer.prepare(gold, review)
                self.assertEqual(result["questions"], count)
                packet = json.loads((review / "review-packet.json").read_text("utf-8"))
                self.assertEqual(packet["questionNos"], numbers)
                html = (review / "review.html").read_text("utf-8")
                self.assertIn(f"{count} 題詳批 Gold", html)
                self.assertNotIn("七題全部", html)
                packet_path = review / "review-packet.json"
                signoff = root / "signoff.json"
                write_json(signoff, {
                    "kind": "matha-paper-detail-gold-signoff", "version": 1,
                    "releaseAuthority": True, "approvedBy": "王老師",
                    "approvedAt": "2026-08-29T10:00:00+08:00", "statement": signer.STATEMENT,
                    "goldId": "detail-fixture", "unsignedGoldSha256": sha(gold),
                    "reviewPacketSha256": sha(packet_path), "questionNos": numbers,
                    "checks": [{"no": no, **{field: True for field in signer.CHECK_FIELDS}}
                               for no in numbers],
                })
                final = signer.finalize(gold, packet_path, signoff, root / "signed.json")
                self.assertEqual(final["questions"], count)

    def test_rejects_empty_duplicate_non_integer_and_more_than_thirty_cases(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            gold, _ = self.fixture(root, [1])
            value = json.loads(gold.read_text("utf-8"))
            for cases, pattern in (
                ([], "between 1 and 30"),
                ([value["cases"][0], value["cases"][0]], "unique positive"),
                ([{**value["cases"][0], "no": "1.5"}], "unique positive"),
                ([{**value["cases"][0], "no": no} for no in range(1, 32)], "between 1 and 30"),
            ):
                value["cases"] = cases
                write_json(gold, value)
                with self.assertRaisesRegex(signer.DetailSignoffError, pattern):
                    signer.validate_unsigned_gold(gold)

    def test_windows_launcher_is_hash_bound_and_starts_hidden_server(self):
        source = (ROOT / "scripts" / "start-paper-detail-gold-review.ps1").read_text("utf-8")
        self.assertIn("matha-paper-detail-gold-review-packet", source)
        self.assertIn("Get-FileHash", source)
        self.assertIn("matha-paper-detail-gold-signoff", source)
        self.assertIn("-WindowStyle Hidden", source)
        self.assertIn("$ValidateOnly", source)


if __name__ == "__main__":
    unittest.main()
