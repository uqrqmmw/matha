import argparse
import base64
import hashlib
import importlib.util
import json
import re
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "audit_blueprint_readiness", ROOT / "scripts" / "audit-blueprint-readiness.py"
)
audit = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(audit)

RUNTIME_TEST_SPEC = importlib.util.spec_from_file_location(
    "private_release_runtime_fixtures",
    ROOT / "tests" / "test_private_release_runtime.py",
)
runtime_fixtures = importlib.util.module_from_spec(RUNTIME_TEST_SPEC)
assert RUNTIME_TEST_SPEC.loader
RUNTIME_TEST_SPEC.loader.exec_module(runtime_fixtures)

APP_LOADER_TEST_SPEC = importlib.util.spec_from_file_location(
    "private_app_loader_fixtures",
    ROOT / "tests" / "test_private_app_loader.py",
)
app_loader_fixtures = importlib.util.module_from_spec(APP_LOADER_TEST_SPEC)
assert APP_LOADER_TEST_SPEC.loader
APP_LOADER_TEST_SPEC.loader.exec_module(app_loader_fixtures)

GITHUB_TEST_SPEC = importlib.util.spec_from_file_location(
    "github_delivery_fixtures",
    ROOT / "tests" / "test_github_delivery.py",
)
github_fixtures = importlib.util.module_from_spec(GITHUB_TEST_SPEC)
assert GITHUB_TEST_SPEC.loader
GITHUB_TEST_SPEC.loader.exec_module(github_fixtures)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def capability_run(generated_ms: int, index: int, score: int, *, prefix: str = "run") -> dict:
    remaining = score
    questions = []
    for no in range(1, 21):
        points = min(5, remaining)
        remaining -= points
        questions.append({
            "no": no, "status": "correct" if points == 5 else "incorrect",
            "points": points, "maxPoints": 5,
        })
    counts = {
        status: sum(row["status"] == status for row in questions)
        for status in ("correct", "incorrect", "uncertain", "unanswered")
    }
    row = {
        "runId": f"{prefix}-run-{index}", "sourceId": f"{prefix}-source-{index}",
        "submittedAt": generated_ms - (10 - index) * 86400000,
        "gradedAt": generated_ms - (10 - index) * 86400000 + 600000,
        "score": score, "total": 100,
        "freshnessConfirmedAt": generated_ms - (10 - index) * 86400000 - 600000,
        "appVersion": audit.current_app_version(),
        "sourceContentDigest": hashlib.sha256(
            f"{prefix}-source-content-{index}".encode()
        ).hexdigest(),
        "submitAttemptDigest": hashlib.sha256(
            f"{prefix}-submit-attempt-{index}".encode()
        ).hexdigest(),
        "gradeReceiptDigest": "a" * 64,
        "submissionContentBindingSha256": "b" * 64,
        "modelInputBindingSha256": "c" * 64,
        "ownerVisualAttestationDigest": "d" * 64,
        "gradeSummary": {
            "questionCount": 20, "awardedPoints": score, "maxPoints": 100,
            "statusCounts": counts, "questions": questions,
        },
    }
    row["canonicalDigest"] = audit.canonical_sha({
        key: row[key] for key in audit.CAPABILITY_RUN_DIGEST_FIELDS
    })
    return row


def capability_evidence_value(
    generated_at: datetime,
    *,
    version: int = 2,
    run_scores: tuple[int, ...] = (72, 80, 100),
    fresh_scores: tuple[int, ...] = (55, 60, 65, 70, 75, 80),
) -> dict:
    generated_ms = int(generated_at.timestamp() * 1000)
    fresh_runs = []
    if version == 2:
        effective_fresh_scores = list(fresh_scores)
        if len(run_scores) > len(effective_fresh_scores):
            raise ValueError("run_scores cannot exceed fresh_scores")
        effective_fresh_scores[-len(run_scores):] = run_scores
        fresh_runs = [
            capability_run(generated_ms, index, score, prefix="fresh")
            for index, score in enumerate(effective_fresh_scores, start=1)
        ]
        runs = json.loads(json.dumps(fresh_runs[-len(run_scores):]))
    else:
        runs = [
            capability_run(generated_ms, index, score, prefix="goal")
            for index, score in enumerate(run_scores, start=1)
        ]
    passes = sum(score >= 72 for score in run_scores)
    stable = len(runs) == 3 and passes == 3
    value = {
        "kind": f"matha-capability-goal-evidence-v{version}",
        "schemaVersion": version,
        "generatedAt": generated_at.isoformat(),
        "appVersion": audit.current_app_version(),
        "baselineResetAt": generated_ms - 30 * 86400000,
        "status": "stable" if stable else "blocked", "stable": stable,
        "blockers": [] if stable else ["最近三回尚未全數達 72 分"],
        "goal": dict(audit.CAPABILITY_GOAL),
        "calibration": {
            "source": "external", "count": len(runs), "passes": passes,
            "stable": stable, "scorePercent": 84, "grade": "13級",
        },
        "digest": {
            "algorithm": "SHA-256",
            "canonicalization": "recursive-key-sorted-json-v1",
            "runDigestFields": list(audit.CAPABILITY_RUN_DIGEST_FIELDS),
        },
        "runs": runs,
    }
    canonical_fields = (
        "kind", "schemaVersion", "generatedAt", "appVersion",
        "baselineResetAt", "status", "stable", "blockers", "goal",
        "calibration", "digest", "runs",
    )
    if version == 2:
        value["freshCalibration"] = {
            **audit.FRESH_CALIBRATION_FIXED,
            "count": len(fresh_runs), "complete": len(fresh_runs) == 6,
        }
        value["freshRuns"] = fresh_runs
        canonical_fields = (*canonical_fields, "freshCalibration", "freshRuns")
    value["canonicalDigest"] = audit.canonical_sha({key: value[key] for key in canonical_fields})
    if version == 2:
        attach_capability_server_archive(value)
    return value


def capability_server_bytes(value: dict) -> bytes:
    core = {key: item for key, item in value.items() if key != "serverArchive"}
    return (json.dumps(core, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def attach_capability_server_archive(value: dict) -> dict:
    content = capability_server_bytes(value)
    content_hash = hashlib.sha256(content).hexdigest()
    value["serverArchive"] = {
        "authority": "supabase-service-role-storage-readback",
        "bucket": audit.PRIVATE_AUDIT_BUCKET,
        "path": (
            "capability-evidence/matha_" + "b" * 32
            + f"/matha-capability-goal-{content_hash[:16]}.json"
        ),
        "sha256": content_hash,
        "bytes": len(content),
        "readbackVerifiedAt": value["generatedAt"],
        "evidenceCanonicalDigest": value["canonicalDigest"],
    }
    return value


def capability_fetcher(value: dict):
    content = capability_server_bytes(value)
    return lambda bucket, path: content


def device_pdf_bytes(page_count: int) -> bytes:
    return (b"%PDF-1.4\n" + b"\n".join(b"/Type /Page" for _ in range(page_count))
            + b"\n" + b"x" * 2048 + b"\n%%EOF\n")


def device_server_archive_value(value: dict) -> dict:
    local = value["audit"]
    durability = local["submitDurability"]
    pdf_fields = (
        "format", "magic", "eof", "sha256", "bytes", "pageCount", "kind",
        "generatedAt", "storageVerified", "bucket", "path", "serverVerifiedAt",
        "contentBindingVersion", "contentBindingSha256", "sourceAssetVersion",
        "gradeBindingSha256",
    )
    safe_audit = {
        key: local[key] for key in (
            "schema", "appVersion", "runId", "sourceId", "createdAt", "startedAt",
            "submittedAt", "activeElapsedMs", "sessions", "crashRecoveries",
            "recoveryEvents", "strokesCommitted", "initialPage", "visitedPages",
            "pageSwitches", "localSaveMs", "localSaveFailures",
            "localSaveFailureIds", "pendingAtSubmit", "maxSingleCanvasPixels",
            "maxLiveCanvasCount", "deviceAttestation", "device",
        )
    }
    safe_audit["submitDurability"] = {
        key: durability[key] for key in (
            "journalDrained", "allPagesPersisted", "cloudFlushed", "pendingAtSubmit",
            "readbackVerifiedAt", "expectedPages", "verifiedPages",
        )
    }
    safe_audit["pdfArtifact"] = {key: local["pdfArtifact"][key] for key in pdf_fields}
    safe_audit["pdfPixelQa"] = dict(local["pdfPixelQa"])
    checks = [
        {"id": check, "status": "pass"}
        for check in ("duration", "page", "save", "canvas", "resume", "pdf", "pdf-visual", "durability")
    ]
    return {
        "kind": "matha-paper-runtime-audit-v2", "schemaVersion": 2,
        "exportedAt": value["exportedAt"], "appVersion": value["appVersion"],
        "deviceAttestation": dict(value["deviceAttestation"]),
        "run": {**value["run"], "pageCount": local["pdfArtifact"]["pageCount"]},
        "summary": {"passed": True, "checks": checks, "pageP95Ms": 210, "localSaveP95Ms": 200},
        "inkReadback": {
            "route": "service-role-postgrest",
            "queriedAfterClientReadbackAt": durability["readbackVerifiedAt"],
            "expectedPages": durability["expectedPages"],
            "verifiedPages": durability["verifiedPages"],
            "pages": [{
                "page": row["page"], "qid": row["qid"], "clientId": row["clientId"],
                "sha256": row["cloudSha256"], "revision": 1,
                "updatedAt": value["exportedAt"], "strokeCount": 1,
                "deletedCount": 0, "matched": True,
            } for row in durability["pages"]],
        },
        "audit": safe_audit,
    }


def device_server_archive_bytes(value: dict) -> bytes:
    return (json.dumps(device_server_archive_value(value), ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def device_remote_objects(value: dict) -> dict[tuple[str, str], bytes]:
    archive = value["audit"]["archive"]
    pdf = value["audit"]["pdfArtifact"]
    return {
        (archive["bucket"], archive["path"]): device_server_archive_bytes(value),
        (pdf["bucket"], pdf["path"]): device_pdf_bytes(pdf["pageCount"]),
    }


def device_fetcher(value: dict):
    objects = device_remote_objects(value)
    return lambda bucket, path: objects[(bucket, path)]


def device_audit_value() -> dict:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    now_ms = int(now.timestamp() * 1000)
    run_id = "paper-run-1700000000000"
    source_id = "paper-mock-3"
    page_count = audit.DEVICE_ACCEPTANCE_PAGE_COUNTS[source_id]
    attestation = {
        "confirmed": True, "model": audit.DEVICE_MODEL,
        "source": "user-confirmation", "confirmedAt": now.isoformat(),
        "browserReportedModel": "SM-X920",
    }
    pages = []
    for page in range(page_count):
        page_hash = hashlib.sha256(f"page-{page}".encode()).hexdigest()
        pages.append({
            "page": page, "qid": f"paper:{run_id}:v2:{page}",
            "clientId": f"ink-paper-{run_id}-{page}-device",
            "localSha256": page_hash, "cloudSha256": page_hash, "matched": True,
        })
    pdf_bytes = device_pdf_bytes(page_count)
    pdf_hash = hashlib.sha256(pdf_bytes).hexdigest()
    content_binding_hash = "c" * 64
    audit_row = {
        "schema": 2, "appVersion": audit.current_app_version(),
        "runId": run_id, "sourceId": source_id,
        "createdAt": now_ms - 6_100_000, "startedAt": now_ms - 6_000_000,
        "submittedAt": now_ms - 10_000,
        "activeElapsedMs": 6_000_000,
        "sessions": 2, "crashRecoveries": 1,
        "recoveryEvents": [{
            "sourceId": source_id, "checkpointUpdatedAt": now_ms - 3_000_000,
            "recoveredAt": now_ms - 2_999_000, "page": 2, "remainingMs": 2_900_000,
            "inkVerified": True,
            "checkpointInkSha256": "b" * 64, "recoveredInkSha256": "b" * 64,
            "pageCount": page_count, "strokeCount": 30, "deletedCount": 1,
        }],
        "initialPage": 0, "visitedPages": list(range(page_count)),
        "strokesCommitted": 30,
        "pageSwitches": [{
            "at": now_ms - 5_000_000 + page * 1000,
            "from": page - 1, "to": page, "method": "swipe",
            "ms": 180 + page * 10, "painted": True,
        } for page in range(1, page_count)],
        "localSaveMs": [80, 120, 200], "localSaveFailures": 0,
        "localSaveFailureIds": [], "pendingAtSubmit": 0,
        "maxSingleCanvasPixels": 8_000_000, "maxLiveCanvasCount": 2,
        "submitDurability": {
            "journalDrained": True, "allPagesPersisted": True,
            "cloudFlushed": True, "pendingAtSubmit": 0,
            "readbackVerifiedAt": now_ms - 9_000,
            "expectedPages": page_count, "verifiedPages": page_count,
            "pages": pages,
        },
        "pdfArtifact": {
            "format": "application/pdf", "magic": "%PDF-", "eof": "%%EOF",
            "sha256": pdf_hash, "bytes": len(pdf_bytes), "pageCount": page_count,
            "kind": "graded", "generatedAt": now_ms - 8_000,
            "storageVerified": True, "bucket": audit.PRIVATE_AUDIT_BUCKET,
            "contentBindingVersion": 1,
            "contentBindingSha256": content_binding_hash,
            "sourceAssetVersion": "private-scan-set-paper-mock-3-20260717-v1",
            "gradeBindingSha256": "d" * 64,
            "path": f"runtime-audits/matha_{'b' * 32}/pdf/{run_id}/graded-{content_binding_hash}-{pdf_hash}.pdf",
            "serverVerifiedAt": now.isoformat(), "runId": run_id, "sourceId": source_id,
        },
        "pdfPixelQa": {
            "confirmed": True, "source": "owner-visual-review",
            "reviewer": "authenticated-owner", "pdfSha256": pdf_hash,
            "contentBindingSha256": content_binding_hash,
            "confirmedAt": now.isoformat(),
        },
        "deviceAttestation": dict(attestation),
        "device": {
            "userAgent": "Mozilla/5.0 (Linux; Android 14; SM-X920)",
            "platform": "Linux armv8l", "screenWidth": 1315,
            "screenHeight": 821, "dpr": 2,
        },
    }
    value = {
        "kind": "matha-paper-runtime-audit-v2", "schemaVersion": 2,
        "exportedAt": now.isoformat(), "appVersion": audit.current_app_version(),
        "deviceAttestation": attestation,
        "run": {
            "id": run_id, "sourceId": source_id, "date": now.date().isoformat(),
            "status": "awaiting-correction", "paperLayoutVersion": 2,
        },
        # summary deliberately lies: the validator must recompute exclusively from raw audit.
        "summary": {"passed": False, "checks": [], "pageP95Ms": 9999},
        "audit": audit_row,
    }
    archive_bytes = device_server_archive_bytes(value)
    archive_hash = hashlib.sha256(archive_bytes).hexdigest()
    audit_row["archive"] = {
        "authority": "supabase-service-role-storage-readback",
        "bucket": audit.PRIVATE_AUDIT_BUCKET,
        "path": f"runtime-audits/matha_{'b' * 32}/matha-paper-runtime-audit-{run_id}-{archive_hash[:16]}.json",
        "sha256": archive_hash, "bytes": len(archive_bytes),
        "readbackVerifiedAt": now.isoformat(),
        "appVersion": audit.current_app_version(),
        "sourceId": source_id, "archivedAt": now_ms,
        "contentBindingSha256": content_binding_hash, "pdfSha256": pdf_hash,
    }
    return value


def signed_source_value(release_id: str = "starter-fixture") -> dict:
    hashes = ["a" * 64, "b" * 64]
    questions = []
    for index in range(217):
        qid = f"q-{index:03d}"
        if index < 35:
            answer = [1]
            structured = {"schema": 1, "mode": "single", "optionCount": 4,
                          "correctOptionNumbers": [2]}
        elif index < 56:
            answer = [0, 2]
            structured = {"schema": 1, "mode": "multi", "optionCount": 4,
                          "correctOptionNumbers": [1, 3]}
        else:
            answer = ["1"]
            structured = {"schema": 1, "mode": "text", "officialAnswerText": "1"}
        questions.append({
            "id": qid, "ans": answer, "sol": "官方答案：1",
            "displayTruth": "original-pdf-crop", "needsStemAsset": True,
            "stemAsset": {
                "sha256": hashlib.sha256(f"stem-{index}".encode()).hexdigest(),
                "assetStatus": "verified", "containsAnswer": False,
                "containsSolution": False, "containsHandwriting": False,
            },
            "answerVerification": {
                "officialAnswerSha256": hashlib.sha256(f"answer-{index}".encode()).hexdigest(),
                "structuredAnswer": structured,
            },
        })
    delegations = [{
        "kind": "owner-delegated-agent-content-review",
        "authorizedBy": "repo-owner",
        "authorizedAt": "2026-08-29T10:00:00+08:00",
        "scope": "217 題逐像素題面與官方答案核對",
        "basis": "repository owner delegated this bounded review",
    }]
    return {
        "schema": 3, "kind": "private-question-source", "releaseId": release_id,
        "corpusGeneration": "mistral-ocr4-verified-v1",
        "sourceInventorySha256": audit.EXPECTED_CORPUS["sourceInventorySha256"],
        "sourceDocuments": 25, "sourcePages": 6720,
        "ocrProvider": "mistral", "ocrModel": "mistral-ocr-latest",
        "verificationPolicy": "pdf-crop-and-answer-review-v1",
        "originalPdfVerified": True, "answerKeyVerified": True,
        "mathematicalCorrectnessVerified": True,
        "reviewPolicy": "owner-delegated-agent-direct-pixel-v1",
        "releaseApprovedBy": "repo-owner",
        "reviewedBy": "Codex direct-pixel audit",
        "ownerDelegations": delegations,
        "reviewAudit": {
            "directReviewSha256": hashes, "dualReviewSha256": hashes,
            "selectionSha256": "e" * 64,
        },
        "releaseApproval": {
            "kind": "owner-delegated-agent-starter-private-release-signoff",
            "version": 2, "authorizedBy": "repo-owner",
            "performedBy": "Codex direct-pixel audit",
            "humanPixelReviewClaimed": False,
            "delegatedReviewSha256": hashes,
            "unsignedSourceSha256": "f" * 64,
            "assetManifestSha256": "9" * 64,
            "sampleQuestionIds": [row["id"] for row in questions[:10]],
        },
        "questions": questions,
    }


def trusted_runtime_verification_fixture(
    root: Path,
    *,
    prepared_at: str = "2026-08-30T00:02:00+00:00",
    deployed_at: str = "2026-08-30T00:03:00+00:00",
) -> tuple[Path, Path, Path]:
    """Build evidence through the authoritative runtime verifier, not by hand."""
    harness = runtime_fixtures.PrivateReleaseRuntimeTests(methodName="runTest")
    fixture = harness.fixture(root)
    deployment = json.loads(fixture["deployment"].read_text(encoding="utf-8"))
    previous = b"previous-manifest"
    deployment["preparedAt"] = prepared_at
    deployment["deployedAt"] = deployed_at
    deployment["alias"]["previousSha256"] = hashlib.sha256(previous).hexdigest()
    deployment["alias"]["previousBytesBase64"] = base64.b64encode(previous).decode()
    write_json(fixture["deployment"], deployment)
    output = root / "private-release-runtime-verification.json"
    harness.verify(
        fixture, output, reviews=[fixture["review"]],
        downloader=harness.downloader(fixture["store"]),
    )
    return output, fixture["plan"], fixture["deployment"]


class BlueprintReadinessTests(unittest.TestCase):
    def private_integration_fixture(self, root: Path) -> tuple[dict, list[dict]]:
        app_version = audit.current_app_version()
        app_source = (ROOT / "app.js").read_text(encoding="utf-8")
        assets_root = root / "assets"
        papers = []
        source_documents = []
        storage_assets = []
        for paper_id in ["official-110-trial-matha", *(f"official-{year}-matha" for year in range(111, 116))]:
            year = paper_id.split("-")[1]
            app_source_id = (
                "paper-official-110-trial" if paper_id == "official-110-trial-matha"
                else f"paper-official-{year}"
            )
            source_id = f"{paper_id}-question"
            source = root / "sources" / f"{paper_id}.pdf"
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(f"independent-original-pdf:{paper_id}".encode())
            source_documents.append({
                "id": source_id,
                "fileName": source.name,
                "pathHint": str(source),
                "pages": 8,
                "sha256": digest(source),
            })
            rows = []
            names = re.findall(
                rf"{paper_id}/(page-\d{{2}}-[a-f0-9]{{12}}\.png)", app_source
            )
            self.assertEqual(len(names), 8)
            for page, name in enumerate(names, start=1):
                relative = f"{paper_id}/{name}"
                path = assets_root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"{paper_id}-{page}".encode())
                row = {
                    "appPage": page, "pdfPage": page,
                    "file": relative, "sha256": digest(path), "bytes": path.stat().st_size,
                }
                rows.append(row)
                storage_assets.append(dict(row))
            papers.append({
                "paperId": paper_id, "appSourceId": app_source_id,
                "paperClass": "official-exam",
                "sourceId": source_id, "sourceFileName": source.name,
                "sourceSha256": digest(source), "sourcePages": 8,
                "questionPdfPages": list(range(1, 9)), "assets": rows,
                "questionPageMap": [2, 3, 4, 5, 6, 7] + [7] * 14,
            })
        asset_manifest = assets_root / "official-paper-assets.json"
        write_json(asset_manifest, {
            "kind": "matha-official-paper-assets-v1", "releaseAuthority": False,
            "paperCount": 6, "assetCount": 48, "papers": papers,
        })
        visual = assets_root / "visual.json"
        write_json(visual, {
            "schema": 1, "releaseAuthority": False, "papersReviewed": 6, "pagesReviewed": 48,
            "checks": {
                "pageOrder": "pass", "cropCompleteness": "pass",
                "chineseReadability": "pass", "formulaReadability": "pass",
                "diagramPreservation": "pass", "grayscalePreservation": "pass",
                "handwritingPresent": False, "answerLeakageInQuestionPages": False,
            },
        })
        storage = assets_root / "storage.json"
        write_json(storage, {
            "kind": "matha-official-paper-storage-verification-v1",
            "releaseAuthority": False, "readOnlyVerification": True,
            "readbackMode": "live-authenticated-download", "credentialsSerialized": False,
            "projectRef": "rrihysbxhsbxjteqmtdu", "bucket": "matha-papers",
            "sourceManifestSha256": digest(asset_manifest), "paperCount": 6,
            "assetCount": 48, "remoteHashMismatches": 0, "assets": storage_assets,
        })
        solution_root = root / "solutions"
        solution_names = sorted(set(re.findall(
            r"paper-official-110-trial/(page-\d{2}-[a-f0-9]{12}\.png)",
            (ROOT / "supabase/functions/openai-proxy/lib.ts").read_text(encoding="utf-8"),
        )))
        self.assertEqual(len(solution_names), 8)
        solution_assets = []
        for name in solution_names:
            relative = f"paper-official-110-trial/{name}"
            path = solution_root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
            solution_assets.append({
                "file": relative, "sha256": digest(path), "bytes": path.stat().st_size,
            })
        solution_manifest = solution_root / "official-solution-assets.json"
        write_json(solution_manifest, {
            "kind": "matha-official-solution-assets-v1", "releaseAuthority": False,
            "projectRef": "rrihysbxhsbxjteqmtdu", "bucket": "matha-solutions",
            "appSourceId": "paper-official-110-trial", "sourcePages": 8,
            "questionPageMap": [1] * 20, "question20ContinuationPage": 8,
            "remoteListingExact": True, "readbackHashMismatches": 0,
            "assets": solution_assets,
        })
        solution_storage = solution_root / "official-solution-storage.json"
        write_json(solution_storage, {
            "kind": "matha-private-paper-solution-storage-verification-v1",
            "releaseAuthority": False, "readOnlyVerification": True,
            "readbackMode": "live-authenticated-download", "credentialsSerialized": False,
            "projectRef": "rrihysbxhsbxjteqmtdu", "bucket": "matha-solutions",
            "sourceManifestSha256": digest(solution_manifest),
            "paperCount": 1, "assetCount": 8, "remoteHashMismatches": 0,
            "assets": solution_assets,
        })
        return ({
            "status": "deployed-and-hash-verified", "appVersion": app_version,
            "supabaseProjectRef": "rrihysbxhsbxjteqmtdu", "bucket": "matha-papers",
            "officialPapers": 6, "officialPages": 48, "remoteHashMismatches": 0,
            "assetManifestPathHint": str(asset_manifest),
            "assetManifestSha256": digest(asset_manifest),
            "visualReviewPathHint": str(visual), "visualReviewSha256": digest(visual),
            "storageVerificationPathHint": str(storage),
            "storageVerificationSha256": digest(storage),
            "solutionManifestPathHint": str(solution_manifest),
            "solutionManifestSha256": digest(solution_manifest),
            "officialSolutionStorageVerificationPathHint": str(solution_storage),
            "officialSolutionStorageVerificationSha256": digest(solution_storage),
            "answerKeyPapersBehindPostSubmitGate": 7,
            "edgeFunctionVersion": audit.EXPECTED_EDGE_FUNCTION_VERSION,
            "officialDetailedSolutionPapers": 1, "officialSolutionPages": 8,
            "solutionStorageHashMismatches": 0,
            "freshnessStillRequiresUserConfirmation": True,
        }, source_documents)

    def refresh_private_paper_evidence(self, integration: dict) -> None:
        manifest_path = Path(integration["assetManifestPathHint"])
        storage_path = Path(integration["storageVerificationPathHint"])
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        storage = json.loads(storage_path.read_text(encoding="utf-8"))
        storage["assets"] = [
            dict(asset)
            for paper in manifest["papers"]
            for asset in paper["assets"]
        ]
        write_json(storage_path, storage)
        storage["sourceManifestSha256"] = digest(manifest_path)
        write_json(storage_path, storage)
        integration["assetManifestSha256"] = digest(manifest_path)
        integration["storageVerificationSha256"] = digest(storage_path)

    def private_paper_inventory_fixture(self, root: Path) -> tuple[Path, dict, list[dict]]:
        integration, source_documents = self.private_integration_fixture(root)
        manifest = json.loads(Path(integration["assetManifestPathHint"]).read_text(
            encoding="utf-8",
        ))
        papers = [{
            "id": paper["paperId"], "appSourceId": paper["appSourceId"],
            "questions": 20, "minutes": 100, "freshness": "unconfirmed",
            "calibrationStatus": "reserve-pending-freshness",
        } for paper in manifest["papers"]]
        inventory = root / "inventory.json"
        write_json(inventory, {
            "schema": 1, "privateAppIntegration": integration,
            "sourceDocuments": source_documents, "papers": papers,
        })
        return inventory, integration, source_documents

    def test_local_discovery_requires_exact_report_and_visual_review_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            report = root / "report.json"
            review = root / "review.json"
            write_json(report, {
                "kind": "matha-local-full-paper-discovery-v1",
                "releaseAuthority": False,
                "scannedPdfCount": 2,
                "candidates": [{"sha256": "a"}, {"sha256": "b"}],
            })
            write_json(review, {
                "kind": "matha-local-full-paper-discovery-visual-review-v1",
                "releaseAuthority": False,
                "discoveryReport": {"sha256": digest(report), "mathOrExamPathReadErrors": 0},
                "imageOnlyReview": {
                    "allFirstPagesReviewed": True, "uniqueHashes": 1,
                    "mathPaperHashesFound": [],
                },
                "namedCandidateReview": {"newCompleteMathAPaperHashesFound": []},
            })
            row = {
                "reportPathHint": str(report), "reportSha256": digest(report),
                "visualReviewPathHint": str(review), "visualReviewSha256": digest(review),
                "scannedPdfCount": 2, "candidateRows": 2, "candidateUniqueHashes": 2,
                "imageOnlyUniqueHashesVisuallyReviewed": 1,
                "mathOrExamPathReadErrors": 0, "newCompleteMathAPapersFound": 0,
            }
            self.assertEqual(len(audit.validate_local_discovery(row, root)), 3)
            report.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(audit.ReadinessError, "雜湊漂移"):
                audit.validate_local_discovery(row, root)

    def test_full_paper_gate_ignores_static_freshness_and_requires_v2_real_runs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inventory = root / "inventory.json"
            integration, source_documents = self.private_integration_fixture(root)
            ready = [{
                "id": paper["paperId"], "questions": 20, "minutes": 100,
                "appSourceId": paper["appSourceId"],
                "freshness": "confirmed-unseen", "calibrationStatus": "ready-fresh",
            } for paper in json.loads(Path(integration["assetManifestPathHint"]).read_text(
                encoding="utf-8",
            ))["papers"]]
            write_json(inventory, {
                "schema": 1,
                "privateAppIntegration": integration,
                "sourceDocuments": source_documents,
                "papers": ready,
            })
            engineering, calibration = audit.audit_full_papers(inventory, root)
            self.assertEqual(engineering["status"], "pass")
            self.assertEqual(engineering["phase"], "engineering")
            self.assertEqual(calibration["status"], "blocked")
            self.assertEqual(calibration["phase"], "post-delivery")
            self.assertIn("清冊文字不算作答", calibration["summary"])
            evidence = root / "capability-goal-evidence-v2.json"
            capability = capability_evidence_value(
                datetime.now(timezone.utc).replace(microsecond=0),
            )
            write_json(evidence, capability)
            engineering, calibration = audit.audit_full_papers(
                inventory, root, [root], [evidence], capability_fetcher(capability),
            )
            self.assertEqual(engineering["status"], "pass")
            self.assertEqual(calibration["status"], "pass")
            ready[-1]["freshness"] = "unconfirmed"
            ready[-1]["calibrationStatus"] = "reserve-pending-freshness"
            write_json(inventory, {
                "schema": 1,
                "privateAppIntegration": integration,
                "sourceDocuments": source_documents,
                "papers": ready,
            })
            engineering, calibration = audit.audit_full_papers(
                inventory, root, [root], [evidence], capability_fetcher(capability),
            )
            self.assertEqual(engineering["status"], "pass")
            self.assertEqual(calibration["status"], "pass")

    def test_full_paper_gate_rejects_stale_app_or_cached_storage_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inventory, integration, _ = self.private_paper_inventory_fixture(root)
            value = json.loads(inventory.read_text(encoding="utf-8"))
            value["privateAppIntegration"]["appVersion"] = "0000a"
            write_json(inventory, value)
            engineering, _ = audit.audit_full_papers(inventory, root)
            self.assertEqual(engineering["status"], "fail")
            self.assertIn("evidence=0000a", engineering["summary"])

            value["privateAppIntegration"]["appVersion"] = audit.current_app_version()
            storage_path = Path(value["privateAppIntegration"]["storageVerificationPathHint"])
            storage_value = json.loads(storage_path.read_text(encoding="utf-8"))
            storage_value["readbackMode"] = "offline-cache"
            write_json(storage_path, storage_value)
            value["privateAppIntegration"]["storageVerificationSha256"] = digest(storage_path)
            write_json(inventory, value)
            engineering, _ = audit.audit_full_papers(inventory, root)
            self.assertEqual(engineering["status"], "fail")
            self.assertIn("Storage", engineering["summary"])

    def test_full_paper_gate_rejects_duplicate_app_source_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inventory, integration, _ = self.private_paper_inventory_fixture(root)
            manifest_path = Path(integration["assetManifestPathHint"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["papers"][1]["appSourceId"] = manifest["papers"][0]["appSourceId"]
            write_json(manifest_path, manifest)
            self.refresh_private_paper_evidence(integration)
            value = json.loads(inventory.read_text(encoding="utf-8"))
            value["privateAppIntegration"] = integration
            value["papers"][1]["appSourceId"] = value["papers"][0]["appSourceId"]
            write_json(inventory, value)

            engineering, calibration = audit.audit_full_papers(inventory, root)
            self.assertEqual(engineering["status"], "fail")
            self.assertIn("appSourceId", engineering["summary"])
            self.assertEqual(calibration["status"], "blocked")

    def test_full_paper_gate_rejects_duplicate_ordered_whole_paper_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inventory, integration, _ = self.private_paper_inventory_fixture(root)
            manifest_path = Path(integration["assetManifestPathHint"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            first, duplicate = manifest["papers"][:2]
            asset_root = manifest_path.parent
            for original, copied in zip(first["assets"], duplicate["assets"], strict=True):
                copied_path = asset_root / copied["file"]
                copied_path.write_bytes((asset_root / original["file"]).read_bytes())
                copied["sha256"] = digest(copied_path)
                copied["bytes"] = copied_path.stat().st_size
            write_json(manifest_path, manifest)
            self.refresh_private_paper_evidence(integration)
            value = json.loads(inventory.read_text(encoding="utf-8"))
            value["privateAppIntegration"] = integration
            write_json(inventory, value)

            engineering, calibration = audit.audit_full_papers(inventory, root)
            self.assertEqual(engineering["status"], "fail")
            self.assertIn("整卷逐頁內容雜湊重複", engineering["summary"])
            self.assertEqual(calibration["status"], "blocked")

    def test_full_paper_gate_requires_independent_source_pdf_hash_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            inventory, _, _ = self.private_paper_inventory_fixture(root)
            value = json.loads(inventory.read_text(encoding="utf-8"))
            value["sourceDocuments"] = value["sourceDocuments"][1:]
            write_json(inventory, value)

            engineering, _ = audit.audit_full_papers(inventory, root)
            self.assertEqual(engineering["status"], "fail")
            self.assertIn("原始 PDF 實體雜湊綁定", engineering["summary"])

    def test_fresh_calibration_rejects_incomplete_or_digest_drift_as_blocked(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            evidence = root / "capability-goal-evidence-v2.json"
            generated = datetime.now(timezone.utc).replace(microsecond=0)
            incomplete = capability_evidence_value(
                generated, fresh_scores=(55, 60, 65, 70, 75),
            )
            write_json(evidence, incomplete)
            self.assertTrue(audit.validate_capability_goal_evidence(
                evidence, capability_fetcher(incomplete),
            ))
            gate = audit.audit_fresh_calibration(
                [root], [evidence], capability_fetcher(incomplete),
            )
            self.assertEqual(gate["status"], "blocked")
            self.assertIn("5 / 6", gate["summary"])
            low_scores = capability_evidence_value(
                generated, run_scores=(60, 70, 80),
            )
            write_json(evidence, low_scores)
            self.assertTrue(audit.validate_fresh_calibration_evidence(
                evidence, capability_fetcher(low_scores),
            ))
            with self.assertRaisesRegex(audit.ReadinessError, "72"):
                audit.validate_capability_goal_evidence(
                    evidence, capability_fetcher(low_scores),
                )
            complete = capability_evidence_value(generated)
            complete["freshRuns"][0]["canonicalDigest"] = "0" * 64
            write_json(evidence, complete)
            gate = audit.audit_fresh_calibration(
                [root], [evidence], capability_fetcher(complete),
            )
            self.assertEqual(gate["status"], "blocked")
            self.assertIn("canonical digest", gate["summary"])

    def test_device_gate_v2_recomputes_raw_evidence_and_ignores_summary(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audit.json"
            original = device_audit_value()
            write_json(path, original)
            self.assertTrue(audit.validate_device_audit(
                path, "paper-mock-3", audit.current_app_version(), device_fetcher(original),
            ))
            value = json.loads(path.read_text("utf-8"))
            value["audit"]["device"]["userAgent"] = "Mozilla/5.0 (Windows NT 10.0)"
            write_json(path, value)
            with self.assertRaisesRegex(audit.ReadinessError, "UA"):
                audit.validate_device_audit(
                    path, "paper-mock-3", audit.current_app_version(), device_fetcher(original),
                )

    def test_device_gate_rejects_locally_self_signed_json_without_private_readback(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audit.json"
            write_json(path, device_audit_value())
            with self.assertRaisesRegex(audit.ReadinessError, "私有 Storage 即時回讀"):
                audit.validate_device_audit(path, "paper-mock-3", audit.current_app_version())

    def test_device_gate_rejects_v1_timestamp_resume_page_swipe_and_hash_shortcuts(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audit.json"
            valid_fetcher = device_fetcher(device_audit_value())

            old = device_audit_value()
            old["kind"] = "matha-paper-runtime-audit-v1"
            old["schemaVersion"] = 1
            old["audit"]["schema"] = 1
            write_json(path, old)
            with self.assertRaisesRegex(audit.ReadinessError, "v2"):
                audit.validate_device_audit(
                    path, "paper-mock-3", audit.current_app_version(), valid_fetcher,
                )

            cases = []
            canceled_print = device_audit_value()
            canceled_print["audit"].pop("pdfArtifact")
            canceled_print["audit"]["pdfPreparedAt"] = canceled_print["audit"]["submittedAt"] + 1
            canceled_print["summary"]["passed"] = True
            cases.append(("cancelled-print-timestamp", canceled_print, "PDF"))

            sessions_only = device_audit_value()
            sessions_only["audit"]["crashRecoveries"] = 0
            sessions_only["audit"]["recoveryEvents"] = []
            cases.append(("sessions-are-not-crash-recovery", sessions_only, "當機恢復"))

            missing_page = device_audit_value()
            missing_page["audit"]["visitedPages"].pop()
            cases.append(("missing-visited-page", missing_page, "全部頁面"))

            button_only = device_audit_value()
            for row in button_only["audit"]["pageSwitches"]:
                row["method"] = "button"
            cases.append(("button-only", button_only, "button-only"))

            hash_drift = device_audit_value()
            hash_drift["audit"]["submitDurability"]["pages"][2]["cloudSha256"] = "f" * 64
            cases.append(("local-cloud-hash-drift", hash_drift, "雜湊"))

            missing_pixel_qa = device_audit_value()
            missing_pixel_qa["audit"].pop("pdfPixelQa")
            cases.append(("missing-owner-pdf-pixel-qa", missing_pixel_qa, "像素核對"))

            content_binding_drift = device_audit_value()
            content_binding_drift["audit"]["pdfArtifact"]["contentBindingSha256"] = "f" * 64
            cases.append(("pdf-content-binding-drift", content_binding_drift, "PDF"))

            bad_archive = device_audit_value()
            bad_archive["audit"]["archive"]["path"] = bad_archive["audit"]["archive"]["path"].replace(
                bad_archive["audit"]["archive"]["sha256"][:16], "0" * 16,
            )
            cases.append(("private-archive-hash-drift", bad_archive, "封存雜湊"))

            for name, candidate, message in cases:
                with self.subTest(name=name):
                    write_json(path, candidate)
                    with self.assertRaisesRegex(audit.ReadinessError, message):
                        audit.validate_device_audit(
                            path, "paper-mock-3", audit.current_app_version(), valid_fetcher,
                        )

    def test_capability_goal_requires_three_recomputable_fresh_scores_at_72(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "capability-goal-evidence.json"
            generated_at = datetime.now(timezone.utc).replace(microsecond=0)
            generated_ms = int(generated_at.timestamp() * 1000)
            fields = list(audit.CAPABILITY_RUN_DIGEST_FIELDS)
            runs = []
            for index, score in enumerate((72, 80, 100), start=1):
                questions = []
                remaining = score
                for no in range(1, 21):
                    points = min(5, remaining)
                    remaining -= points
                    questions.append({
                        "no": no, "status": "correct" if points == 5 else "incorrect",
                        "points": points, "maxPoints": 5,
                    })
                counts = {
                    "correct": sum(row["status"] == "correct" for row in questions),
                    "incorrect": sum(row["status"] == "incorrect" for row in questions),
                    "uncertain": 0, "unanswered": 0,
                }
                row = {
                    "runId": f"run-{index}", "sourceId": f"source-{index}",
                    "submittedAt": generated_ms - (4 - index) * 86400000,
                    "gradedAt": generated_ms - (4 - index) * 86400000 + 600000,
                    "score": score, "total": 100,
                    "freshnessConfirmedAt": generated_ms - (4 - index) * 86400000 - 600000,
                    "appVersion": audit.current_app_version(),
                    "sourceContentDigest": hashlib.sha256(
                        f"legacy-source-content-{index}".encode()
                    ).hexdigest(),
                    "submitAttemptDigest": hashlib.sha256(
                        f"legacy-submit-attempt-{index}".encode()
                    ).hexdigest(),
                    "gradeReceiptDigest": "a" * 64,
                    "submissionContentBindingSha256": "b" * 64,
                    "modelInputBindingSha256": "c" * 64,
                    "ownerVisualAttestationDigest": "d" * 64,
                    "gradeSummary": {
                        "questionCount": 20, "awardedPoints": score, "maxPoints": 100,
                        "statusCounts": counts, "questions": questions,
                    },
                }
                row["canonicalDigest"] = audit.canonical_sha({key: row[key] for key in fields})
                runs.append(row)
            value = {
                "kind": "matha-capability-goal-evidence-v1", "schemaVersion": 1,
                "generatedAt": generated_at.isoformat(),
                "appVersion": audit.current_app_version(),
                "baselineResetAt": generated_ms - 30 * 86400000,
                "status": "stable", "stable": True, "blockers": [],
                "goal": {"requiredRuns": 3, "distinctRuns": True, "distinctSources": True,
                         "questionsPerRun": 20, "minutesPerRun": 100,
                         "totalPoints": 100, "minimumScore": 72},
                "calibration": {"source": "external", "count": 3, "passes": 3,
                                "stable": True, "scorePercent": 84, "grade": "13級"},
                "digest": {"algorithm": "SHA-256",
                           "canonicalization": "recursive-key-sorted-json-v1",
                           "runDigestFields": fields},
                "runs": runs,
            }
            value["canonicalDigest"] = audit.canonical_sha({key: value[key] for key in (
                "kind", "schemaVersion", "generatedAt", "appVersion",
                "baselineResetAt", "status", "stable", "blockers", "goal",
                "calibration", "digest", "runs",
            )})
            write_json(path, value)
            with self.assertRaisesRegex(audit.ReadinessError, "v2"):
                audit.validate_capability_goal_evidence(path)
            with self.assertRaisesRegex(audit.ReadinessError, "v2"):
                audit.validate_fresh_calibration_evidence(path)
            v2 = capability_evidence_value(generated_at)
            write_json(path, v2)
            with self.assertRaisesRegex(audit.ReadinessError, "私有 Storage"):
                audit.validate_capability_goal_evidence(path)
            self.assertTrue(audit.validate_capability_goal_evidence(
                path, capability_fetcher(v2),
            ))
            self.assertTrue(audit.validate_fresh_calibration_evidence(
                path, capability_fetcher(v2),
            ))
            missing_visual_binding = json.loads(json.dumps(v2))
            missing_visual_binding["runs"][0].pop("ownerVisualAttestationDigest")
            write_json(path, missing_visual_binding)
            with self.assertRaisesRegex(audit.ReadinessError, "資格"):
                audit.validate_capability_goal_evidence(
                    path, capability_fetcher(missing_visual_binding),
                )
            duplicate_source_content = json.loads(json.dumps(v2))
            duplicate_source_content["freshRuns"][1]["sourceContentDigest"] = (
                duplicate_source_content["freshRuns"][0]["sourceContentDigest"]
            )
            duplicate_source_content["freshRuns"][1]["canonicalDigest"] = audit.canonical_sha({
                key: duplicate_source_content["freshRuns"][1][key]
                for key in audit.CAPABILITY_RUN_DIGEST_FIELDS
            })
            duplicate_source_content["canonicalDigest"] = audit.canonical_sha({
                key: duplicate_source_content[key] for key in (
                    "kind", "schemaVersion", "generatedAt", "appVersion",
                    "baselineResetAt", "status", "stable", "blockers", "goal",
                    "calibration", "digest", "runs", "freshCalibration", "freshRuns",
                )
            })
            attach_capability_server_archive(duplicate_source_content)
            write_json(path, duplicate_source_content)
            with self.assertRaisesRegex(audit.ReadinessError, "唯一性"):
                audit.validate_fresh_calibration_evidence(
                    path, capability_fetcher(duplicate_source_content),
                )
            mismatched_latest = json.loads(json.dumps(v2))
            mismatched_latest["runs"][0]["runId"] = "not-the-third-latest-run"
            mismatched_latest["runs"][0]["canonicalDigest"] = audit.canonical_sha({
                key: mismatched_latest["runs"][0][key]
                for key in audit.CAPABILITY_RUN_DIGEST_FIELDS
            })
            mismatched_latest["canonicalDigest"] = audit.canonical_sha({
                key: mismatched_latest[key] for key in (
                    "kind", "schemaVersion", "generatedAt", "appVersion",
                    "baselineResetAt", "status", "stable", "blockers", "goal",
                    "calibration", "digest", "runs", "freshCalibration", "freshRuns",
                )
            })
            attach_capability_server_archive(mismatched_latest)
            write_json(path, mismatched_latest)
            with self.assertRaisesRegex(audit.ReadinessError, "最近三回"):
                audit.validate_capability_goal_evidence(
                    path, capability_fetcher(mismatched_latest),
                )
            uncertain = json.loads(json.dumps(v2))
            first = uncertain["runs"][0]
            first["gradeSummary"]["questions"][0]["status"] = "uncertain"
            first["gradeSummary"]["statusCounts"]["correct"] -= 1
            first["gradeSummary"]["statusCounts"]["uncertain"] += 1
            first["canonicalDigest"] = audit.canonical_sha({
                key: first[key] for key in audit.CAPABILITY_RUN_DIGEST_FIELDS
            })
            uncertain["canonicalDigest"] = audit.canonical_sha({
                key: uncertain[key] for key in (
                    "kind", "schemaVersion", "generatedAt", "appVersion",
                    "baselineResetAt", "status", "stable", "blockers", "goal",
                    "calibration", "digest", "runs", "freshCalibration", "freshRuns",
                )
            })
            write_json(path, uncertain)
            with self.assertRaisesRegex(audit.ReadinessError, "配分"):
                audit.validate_capability_goal_evidence(
                    path, capability_fetcher(uncertain),
                )
            write_json(path, value)
            unanswered = json.loads(json.dumps(value))
            first = unanswered["runs"][0]
            first["gradeSummary"]["questions"][0]["status"] = "unanswered"
            first["gradeSummary"]["statusCounts"]["correct"] -= 1
            first["gradeSummary"]["statusCounts"]["unanswered"] += 1
            first["canonicalDigest"] = audit.canonical_sha({
                key: first[key] for key in fields
            })
            unanswered["canonicalDigest"] = audit.canonical_sha({
                key: unanswered[key] for key in (
                    "kind", "schemaVersion", "generatedAt", "appVersion",
                    "baselineResetAt", "status", "stable", "blockers", "goal",
                    "calibration", "digest", "runs",
                )
            })
            write_json(path, unanswered)
            with self.assertRaisesRegex(audit.ReadinessError, "配分"):
                audit.validate_capability_goal_evidence(path)
            value["generatedAt"] = "2020-01-01T00:00:00+00:00"
            write_json(path, value)
            with self.assertRaisesRegex(audit.ReadinessError, "最新快照"):
                audit.validate_capability_goal_evidence(path)
            value["generatedAt"] = generated_at.isoformat()
            value["runs"][0]["score"] = 71
            write_json(path, value)
            with self.assertRaises(audit.ReadinessError):
                audit.validate_capability_goal_evidence(path)

    def test_missing_private_human_evidence_never_becomes_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            review, deployment, runtime, loader = audit.audit_starter(root / "missing")
            self.assertEqual(review["status"], "blocked")
            self.assertEqual(deployment["status"], "blocked")
            self.assertEqual(runtime["status"], "blocked")
            self.assertEqual(loader["status"], "blocked")
            self.assertFalse(audit.approved_gold({"releaseAuthority": True}))
            self.assertFalse(audit.identifiable_human("Codex agent"))

    def test_github_audit_rechecks_live_remote_actions_and_all_published_trust_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "github-delivery-verification.json"
            harness = github_fixtures.GitHubDeliveryTests(methodName="runTest")
            verifier = audit.github_delivery_verifier()
            runner = harness.runner()
            verifier.verify(path, command_runner=runner, fetcher=harness.fetch)
            evidence = audit.validate_github_delivery(
                path, command_runner=runner, fetcher=harness.fetch,
            )
            self.assertTrue(any(item.startswith("publishedCatalog:") for item in evidence))
            with self.assertRaisesRegex(audit.ReadinessError, "遠端 main"):
                audit.validate_github_delivery(
                    path,
                    command_runner=harness.runner(remote_head="b" * 40),
                    fetcher=harness.fetch,
                )

            def catalog_drift(url):
                if "/textbook-catalog.js?" in url:
                    return b"stale-catalog"
                return harness.fetch(url)

            with self.assertRaisesRegex(audit.ReadinessError, "textbook-catalog.js"):
                audit.validate_github_delivery(
                    path, command_runner=runner, fetcher=catalog_drift,
                )

    def test_supabase_delivery_binds_current_head_migrations_and_exact_edge_source(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "supabase-runtime-delivery.json"
            edge_root = ROOT / "supabase" / "functions" / "openai-proxy"
            source_files = [{
                "file": source.name, "sha256": digest(source), "bytes": source.stat().st_size,
            } for source in edge_root.glob("*.ts") if not source.name.endswith(".test.ts")]
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True,
                text=True, encoding="utf-8", check=True,
            ).stdout.strip()
            write_json(path, {
                "kind": "matha-supabase-runtime-delivery-v1", "version": 1,
                "status": "verified", "verifiedAt": datetime.now(timezone.utc).isoformat(),
                "projectRef": "rrihysbxhsbxjteqmtdu", "headSha": head,
                "appVersion": audit.current_app_version(), "appJsSha256": digest(ROOT / "app.js"),
                "migrations": audit.EXPECTED_MIGRATIONS,
                "edge": {"slug": "openai-proxy", "version": audit.EXPECTED_EDGE_FUNCTION_VERSION,
                         "status": "ACTIVE", "verifyJwt": False, "sourceFiles": source_files},
                "contractProbe": {"optionsStatus": 204, "unauthenticatedPostStatus": 401},
                "browserUsed": False, "openAiApiCalled": False, "credentialsSerialized": False,
            })
            self.assertIn("migrations:001-011:exact", audit.validate_supabase_delivery(path))
            value = json.loads(path.read_text(encoding="utf-8"))
            value["edge"]["sourceFiles"][0]["sha256"] = "0" * 64
            write_json(path, value)
            with self.assertRaisesRegex(audit.ReadinessError, "Edge"):
                audit.validate_supabase_delivery(path)

    def test_owner_delegated_multi_batch_starter_is_transparent_and_hash_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "release"
            root.mkdir(parents=True)
            write_json(root / "signed-private-question-source.json", signed_source_value())
            review, deployment, runtime, loader = audit.audit_starter(root)
            self.assertEqual(review["status"], "blocked")
            self.assertIn("direct／dual", review["summary"])
            self.assertEqual(deployment["status"], "blocked")
            self.assertEqual(runtime["status"], "blocked")
            self.assertEqual(loader["status"], "blocked")

    def test_current_intersection_filename_is_discovered_by_hash(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            harness = runtime_fixtures.PrivateReleaseRuntimeTests(methodName="runTest")
            fixture = harness.fixture(root)
            current_name = root / "owner-delegated-review.intersection.json"
            fixture["dual_review"].replace(current_name)
            evidence = audit.validate_starter_review_files(
                fixture["source"], fixture["plan"], root,
            )
            self.assertIn(f"dualFile:{digest(current_name)}", evidence)

    def test_runtime_verification_binds_complete_release_and_current_app(self):
        with tempfile.TemporaryDirectory() as temp:
            runtime_path, plan_path, record_path = trusted_runtime_verification_fixture(Path(temp))
            signed_path = Path(json.loads(plan_path.read_text(encoding="utf-8"))["source"])
            evidence = audit.validate_runtime_verification(
                runtime_path, plan_path, record_path, signed_path,
            )
            self.assertIn(
                "readback:alias=1,versioned=410,questions=217,packs=191,topics=14,answers=217",
                evidence,
            )

            value = json.loads(runtime_path.read_text(encoding="utf-8"))
            value["appJsSha256"] = "0" * 64
            write_json(runtime_path, value)
            with self.assertRaises(audit.ReadinessError):
                audit.validate_runtime_verification(
                    runtime_path, plan_path, record_path, signed_path,
                )

    def test_app_loader_audit_accepts_exact_current_verifier_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            harness = app_loader_fixtures.PrivateAppLoaderTests(methodName="runTest")
            plan, deployment, runtime, store = harness.fixture(root)
            harness.verify(
                root, app_loader_fixtures.FakeBackend(store),
                plan, deployment, runtime,
            )
            runtime_value = json.loads(runtime.read_text(encoding="utf-8"))
            not_before = audit.parse_timestamp(
                runtime_value["verifiedAt"], "Storage 全量讀回",
            )
            evidence = audit.validate_app_loader_verification(
                root / "app-loader.json", plan, deployment, runtime,
                not_before=not_before,
            )
            self.assertTrue(any(item.startswith("loader:packs=191,questions=217")
                                for item in evidence))

    def test_deploy_rollback_final_deploy_and_runtime_must_be_one_ordered_chain(self):
        with tempfile.TemporaryDirectory() as temp:
            release = Path(temp) / "release"
            release.mkdir(parents=True)
            runtime_path, plan_path, final_path = trusted_runtime_verification_fixture(release)
            plan = json.loads(plan_path.read_text(encoding="utf-8"))
            final = json.loads(final_path.read_text(encoding="utf-8"))

            first = dict(final)
            first["preparedAt"] = "2026-08-30T00:00:00+00:00"
            first["deployedAt"] = "2026-08-30T00:00:30+00:00"
            first_path = release / "deployment-first.json"
            write_json(first_path, first)
            rollback_path = release / "rollback-drill.json"
            write_json(rollback_path, {
                "kind": "matha-private-storage-rollback", "version": 1,
                "releaseId": plan["releaseId"],
                "rolledBackAt": "2026-08-30T00:01:00+00:00",
                "deploymentRecordSha256": digest(first_path),
                "restoredAliasSha256": first["alias"]["previousSha256"],
            })
            review, deployment, storage, loader = audit.audit_starter(release)
            self.assertEqual(review["status"], "pass")
            self.assertEqual(deployment["status"], "pass")
            self.assertEqual(storage["status"], "pass")
            self.assertEqual(loader["status"], "blocked")

            historical = release / "historical-runtime-verification-copy.json"
            historical.write_bytes(runtime_path.read_bytes())
            broken_pointer = json.loads(runtime_path.read_text(encoding="utf-8"))
            broken_pointer["immutableRecordSha256"] = "0" * 64
            write_json(runtime_path, broken_pointer)
            _, deployment, storage, loader = audit.audit_starter(release)
            self.assertEqual(deployment["status"], "pass")
            self.assertEqual(storage["status"], "fail")
            self.assertEqual(loader["status"], "blocked")

            final["preparedAt"] = "2026-08-30T00:00:40+00:00"
            final["deployedAt"] = "2026-08-30T00:00:50+00:00"
            write_json(final_path, final)
            _, deployment, storage, loader = audit.audit_starter(release)
            self.assertEqual(deployment["status"], "fail")
            self.assertEqual(storage["status"], "blocked")
            self.assertEqual(loader["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
