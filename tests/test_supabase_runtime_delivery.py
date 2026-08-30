import importlib.util
import unittest
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "verify_supabase_runtime_delivery",
    ROOT / "scripts" / "verify-supabase-runtime-delivery.py",
)
delivery = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(delivery)


class Response(BytesIO):
    def __init__(self, status):
        super().__init__(b"")
        self.status = status

    def __enter__(self): return self
    def __exit__(self, *_): self.close()


class SupabaseRuntimeDeliveryTests(unittest.TestCase):
    def test_unauthenticated_probe_never_reaches_a_model(self):
        methods = []
        def opener(request, timeout):
            methods.append((request.method, timeout))
            if request.method == "OPTIONS":
                return Response(204)
            raise HTTPError(request.full_url, 401, "unauthorized", {}, None)

        self.assertEqual(
            delivery.unauthenticated_contract_probe("exampleprojectref123", opener),
            {"optionsStatus": 204, "unauthenticatedPostStatus": 401},
        )
        self.assertEqual(methods, [("OPTIONS", 30), ("POST", 30)])

    def test_expected_migrations_are_exactly_001_through_011(self):
        self.assertEqual(delivery.EXPECTED_MIGRATIONS[0], "202608300001")
        self.assertEqual(delivery.EXPECTED_MIGRATIONS[-1], "202608300011")
        self.assertEqual(len(delivery.EXPECTED_MIGRATIONS), 11)


if __name__ == "__main__":
    unittest.main()
