import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "verify_github_delivery", ROOT / "scripts" / "verify-github-delivery.py"
)
delivery = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(delivery)


class GitHubDeliveryTests(unittest.TestCase):
    HEAD = "a" * 40

    def runner(self, *, dirty=False, pages_conclusion="success", remote_head=None):
        rows = [
            {"databaseId": 1, "workflowName": "CI", "status": "completed",
             "conclusion": "success", "headSha": self.HEAD,
             "url": "https://github.com/uqrqmmw/matha/actions/runs/1",
             "updatedAt": "2026-08-30T01:00:00Z"},
            {"databaseId": 2, "workflowName": "Deploy GitHub Pages", "status": "completed",
             "conclusion": pages_conclusion, "headSha": self.HEAD,
             "url": "https://github.com/uqrqmmw/matha/actions/runs/2",
             "updatedAt": "2026-08-30T01:01:00Z"},
        ]

        def run(command):
            if command[:3] == ["git", "status", "--porcelain"]:
                return " M app.js" if dirty else ""
            if command[:3] == ["git", "fetch", "--quiet"]:
                return ""
            if command[:3] == ["git", "branch", "--show-current"]:
                return "main"
            if command[:3] == ["git", "rev-parse", "HEAD"]:
                return self.HEAD
            if command[:3] == ["git", "rev-parse", "origin/main"]:
                return self.HEAD
            if command[:3] == ["gh", "repo", "view"]:
                return json.dumps({
                    "nameWithOwner": "uqrqmmw/matha",
                    "defaultBranchRef": {"name": "main"},
                })
            if command[:3] == ["gh", "api", "repos/uqrqmmw/matha/git/ref/heads/main"]:
                return remote_head or self.HEAD
            if command[:3] == ["gh", "run", "list"]:
                return json.dumps(rows)
            raise AssertionError(command)
        return run

    @staticmethod
    def fetch(url):
        name = url.split("/matha/", 1)[1].split("?", 1)[0]
        return (ROOT / name).read_bytes()

    def test_success_binds_clean_head_actions_and_exact_pages_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "delivery.json"
            value = delivery.verify(path, command_runner=self.runner(), fetcher=self.fetch)
            self.assertEqual(value["status"], "verified")
            self.assertEqual(value["headSha"], self.HEAD)
            self.assertEqual(
                set(value["published"]),
                {"index.html", "app.js", "sw.js", "textbook-catalog.js"},
            )
            self.assertTrue(path.is_file())

    def test_dirty_worktree_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(delivery.DeliveryVerificationError, "not clean"):
                delivery.verify(Path(temp) / "delivery.json",
                                command_runner=self.runner(dirty=True), fetcher=self.fetch)

    def test_failed_pages_run_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(delivery.DeliveryVerificationError, "successfully"):
                delivery.verify(Path(temp) / "delivery.json",
                                command_runner=self.runner(pages_conclusion="failure"),
                                fetcher=self.fetch)

    def test_published_asset_drift_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            def drift(url):
                data = self.fetch(url)
                return b"drift" if "/app.js?" in url else data

            with self.assertRaisesRegex(delivery.DeliveryVerificationError, "app.js"):
                delivery.verify(Path(temp) / "delivery.json",
                                command_runner=self.runner(), fetcher=drift)

    def test_remote_main_moving_after_local_tracking_ref_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(delivery.DeliveryVerificationError, "main has moved"):
                delivery.verify(
                    Path(temp) / "delivery.json",
                    command_runner=self.runner(remote_head="b" * 40),
                    fetcher=self.fetch,
                )


if __name__ == "__main__":
    unittest.main()
