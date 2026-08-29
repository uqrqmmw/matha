import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch-private-runtime-audits.py"
SPEC = importlib.util.spec_from_file_location("fetch_private_runtime_audits", SCRIPT)
fetch = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(fetch)


def audit_bytes(run_id="paper-run-1234567890123"):
    value = {
        "kind": "matha-paper-runtime-audit-v1",
        "run": {"id": run_id, "sourceId": "paper-mock-3", "status": "awaiting-correction"},
        "summary": {"passed": True},
        "audit": {"schema": 1},
    }
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


class RuntimeAuditFetchTests(unittest.TestCase):
    def remote_path(self, content, run_id="paper-run-1234567890123"):
        short = hashlib.sha256(content).hexdigest()[:16]
        return f"/matha-content/runtime-audits/{'a' * 64}/matha-paper-runtime-audit-{run_id}-{short}.json"

    def test_filters_to_exact_hash_addressed_runtime_audits(self):
        content = audit_bytes()
        valid = self.remote_path(content)
        self.assertEqual(fetch.accepted_remote_paths([valid, valid, "/matha-content/manifest.json"]), [valid])

    def test_discover_parses_cli_json_and_rejects_unrelated_objects(self):
        valid = self.remote_path(audit_bytes())
        runner = lambda _args: json.dumps({"paths": [valid, "/matha-content/runtime-audits/bad.json"]})
        self.assertEqual(fetch.discover("project", runner), [valid])

    def test_sync_downloads_validates_and_then_reuses_without_redownload(self):
        content = audit_bytes()
        remote = self.remote_path(content)
        calls = []

        def runner(arguments):
            calls.append(arguments)
            Path(arguments[3]).write_bytes(content)
            return "{}"

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "private"
            first = fetch.sync_audits([remote], output, "project", runner)
            self.assertEqual(first["items"][0]["status"], "downloaded")
            self.assertEqual(len(calls), 1)
            second = fetch.sync_audits([remote], output, "project", runner)
            self.assertEqual(second["items"][0]["status"], "reused")
            self.assertEqual(len(calls), 1)

    def test_hash_mismatch_fails_closed(self):
        content = audit_bytes()
        remote = self.remote_path(content)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / Path(remote).name
            path.write_bytes(content + b"tampered")
            with self.assertRaises(fetch.AuditFetchError):
                fetch.validate_runtime_audit(path, remote)

    def test_public_repo_output_is_rejected(self):
        with self.assertRaises(fetch.AuditFetchError):
            fetch.sync_audits([], fetch.REPO_ROOT / "private", "project", lambda _args: "{}")


if __name__ == "__main__":
    unittest.main()
