import unittest
from scripts.check_paper_contract_deployment_preflight import verify

class PreflightTests(unittest.TestCase):
    def test_empty_remote_is_safe(self): verify(" Local | Remote | Time\n 001 |        | x\n")
    def test_remote_006_blocks(self):
        with self.assertRaisesRegex(RuntimeError,"006 was remotely applied"):
            verify(" Local | Remote | Time\n 202608300006 | 202608300006 | x\n")
    def test_any_unreviewed_remote_history_blocks(self):
        with self.assertRaisesRegex(RuntimeError,"not empty"):
            verify(" Local | Remote | Time\n 202608300001 | 202608300001 | x\n")
