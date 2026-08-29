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
    def fixture(self, root: Path):
        assets = root / "assets"
        assets.mkdir()
        source = root / "source.pdf"
        source.write_bytes(b"source")
        cases = []
        for no in signer.REQUIRED_NOS:
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
        return gold

    def test_prepare_and_finalize_require_exact_complete_named_human_signoff(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            gold = self.fixture(root)
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
                "reviewPacketSha256": sha(packet), "questionNos": signer.REQUIRED_NOS,
                "checks": [{"no": no, **{field: True for field in signer.CHECK_FIELDS}}
                           for no in signer.REQUIRED_NOS],
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
            gold = self.fixture(root)
            review = root / "review"
            signer.prepare(gold, review)
            packet = review / "review-packet.json"
            base = {
                "kind": "matha-paper-detail-gold-signoff", "version": 1,
                "releaseAuthority": True, "approvedBy": "Codex agent",
                "approvedAt": "2026-08-29T10:00:00+08:00", "statement": signer.STATEMENT,
                "goldId": "detail-fixture", "unsignedGoldSha256": sha(gold),
                "reviewPacketSha256": sha(packet), "questionNos": signer.REQUIRED_NOS,
                "checks": [{"no": no, **{field: True for field in signer.CHECK_FIELDS}}
                           for no in signer.REQUIRED_NOS],
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

    def test_windows_launcher_is_hash_bound_and_starts_hidden_server(self):
        source = (ROOT / "scripts" / "start-paper-detail-gold-review.ps1").read_text("utf-8")
        self.assertIn("matha-paper-detail-gold-review-packet", source)
        self.assertIn("Get-FileHash", source)
        self.assertIn("matha-paper-detail-gold-signoff", source)
        self.assertIn("-WindowStyle Hidden", source)
        self.assertIn("$ValidateOnly", source)


if __name__ == "__main__":
    unittest.main()
