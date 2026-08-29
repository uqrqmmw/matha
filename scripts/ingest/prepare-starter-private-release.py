#!/usr/bin/env python3
"""Prepare and finalize a fail-closed starter-bank private release.

This is the bridge between the dual human-review intersection and the existing
private-bank builder.  It never calls OCR or a model.  ``prepare`` verifies the
exact cleaned pixels, official-answer bindings, catalog PDFs and structured
answers, builds image-first questions, and creates a deterministic 10-question
visual sign-off packet.  ``finalize`` accepts only a named-human sign-off bound
to every generated hash and produces the signed source consumed by
``assemble-private-release.py``.  Neither command uploads anything.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import fitz
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[2]
NON_HUMAN = re.compile(
    r"claude|codex|chatgpt|gpt|gemini|agent|bot|automation|自動|模型|人工智慧|\bai\b",
    re.I,
)
SAFE_ID = re.compile(r"^[\w.:-]+$")
ROLE_DIFF = {
    "chapter-end-easy": 1,
    "example": 2,
    "chapter-end-medium": 2,
    "comprehensive-review": 2,
    "chapter-end-hard": 3,
}
SIGNOFF_STATEMENT = (
    "I reviewed the exact deterministic visual sample and approve this exact "
    "hash-bound starter batch for authenticated private release."
)


class StarterReleaseError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise StarterReleaseError(f"{label} does not exist: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise StarterReleaseError(f"{label} must be a JSON object")
    return value


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise StarterReleaseError(f"private release output must stay outside Git: {resolved}")


def unique_rows(value: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(value, list):
        raise StarterReleaseError(f"{label} must be a list")
    result: dict[str, dict[str, Any]] = {}
    for row in value:
        question_id = row.get("id") if isinstance(row, dict) else None
        if not isinstance(question_id, str) or not SAFE_ID.fullmatch(question_id):
            raise StarterReleaseError(f"{label} contains an invalid question id")
        if question_id in result:
            raise StarterReleaseError(f"{label} contains duplicate id: {question_id}")
        result[question_id] = row
    return result


def load_catalog() -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    script = (
        "const c=require('./textbook-catalog');"
        "console.log(JSON.stringify({trusted:c.trustedCorpus,books:[...(c.books||[]),...(c.supplemental||[])]}))"
    )
    completed = subprocess.run(
        ["node", "-e", script], cwd=REPO_ROOT, capture_output=True,
        text=True, encoding="utf-8", check=False,
    )
    if completed.returncode:
        raise StarterReleaseError(f"cannot load textbook catalog: {completed.stderr[:500]}")
    payload = json.loads(completed.stdout)
    trusted = payload.get("trusted")
    books = payload.get("books")
    if not isinstance(trusted, dict) or not isinstance(books, list):
        raise StarterReleaseError("textbook catalog trust metadata is invalid")
    return trusted, unique_rows(books, "catalog books")


def normalize_answer(answer: Any, question_id: str) -> tuple[str, list[str], list[Any]]:
    if not isinstance(answer, dict) or answer.get("schema") != 1:
        raise StarterReleaseError(f"{question_id}: structured answer is missing")
    mode = answer.get("mode")
    if mode == "text":
        text = answer.get("officialAnswerText")
        if not isinstance(text, str) or not text.strip() or len(text.strip()) > 4000:
            raise StarterReleaseError(f"{question_id}: official answer text is invalid")
        return "fill", [], [text.strip()]
    if mode not in {"single", "multi"}:
        raise StarterReleaseError(f"{question_id}: answer mode is invalid")
    option_count = answer.get("optionCount")
    correct = answer.get("correctOptionNumbers")
    if (not isinstance(option_count, int) or isinstance(option_count, bool)
            or not 2 <= option_count <= 12
            or not isinstance(correct, list) or not correct
            or any(not isinstance(number, int) or isinstance(number, bool)
                   or number < 1 or number > option_count for number in correct)
            or len(correct) != len(set(correct))
            or (mode == "single" and len(correct) != 1)):
        raise StarterReleaseError(f"{question_id}: option answer structure is invalid")
    return mode, [f"原題選項 {number}" for number in range(1, option_count + 1)], [
        number - 1 for number in correct
    ]


def normalized_bbox(pdf_file: Path, pdf_page: int, region: Any, dpi: int,
                    question_id: str) -> list[float]:
    if (not isinstance(region, list) or len(region) != 4
            or any(not isinstance(value, (int, float)) for value in region)):
        raise StarterReleaseError(f"{question_id}: stem region is invalid")
    with fitz.open(pdf_file) as document:
        if not 1 <= pdf_page <= document.page_count:
            raise StarterReleaseError(f"{question_id}: PDF page is out of range")
        rect = document[pdf_page - 1].rect
    page_width = rect.width * dpi / 72
    page_height = rect.height * dpi / 72
    x0, y0, x1, y1 = map(float, region)
    if (x0 < 0 or y0 < 0 or x1 <= x0 or y1 <= y0
            or x1 > page_width + 3 or y1 > page_height + 3):
        raise StarterReleaseError(f"{question_id}: stem region escapes the source PDF page")
    values = [x0 / page_width, y0 / page_height,
              (x1 - x0) / page_width, (y1 - y0) / page_height]
    return [round(max(0.0, min(1.0, value)), 8) for value in values]


def review_html(rows: list[dict[str, str]], metadata: dict[str, Any]) -> str:
    cards = []
    for row in rows:
        cards.append(
            f'''<article data-id="{html.escape(row["id"])}"><h2>{html.escape(row["id"])}</h2>
<p>{html.escape(row["book"])}｜PDF 第 {html.escape(row["page"])} 頁｜{html.escape(row["topic"])}</p>
<div class="pair"><figure><figcaption>即將發布的去筆跡題面</figcaption><img src="{html.escape(row["question"])}" alt="去筆跡題面"></figure><figure><figcaption>原書官方答案</figcaption><img src="{html.escape(row["answer"])}" alt="官方答案"></figure></div>
<p><b>App 判分答案：</b>{html.escape(row["structured"])}</p><label><input type="checkbox" data-check="pixels"> 題面完整、無殘留筆跡、圖與公式未受損</label><label><input type="checkbox" data-check="answer"> 官方答案屬於本題且 App 判分答案逐字／逐選項相符</label></article>'''
        )
    encoded = json.dumps(metadata, ensure_ascii=False).replace("<", "\\u003c")
    return f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=6,user-scalable=yes"><title>Starter 發布抽查</title><style>
:root{{--bg:#f3f1eb;--paper:#fffefa;--ink:#383934;--line:#d8d4c9;--accent:#68705f}}*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,"Noto Sans TC",sans-serif}}header{{position:sticky;top:0;z-index:3;padding:14px;background:var(--paper);border-bottom:1px solid var(--line)}}main{{max-width:1300px;margin:auto;padding:16px}}article{{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}}.pair{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}figure{{margin:0}}figcaption{{color:#707269;margin-bottom:6px}}img{{display:block;width:100%;height:auto;touch-action:pan-x pan-y pinch-zoom}}label{{display:block;padding:10px 0}}input[type=checkbox]{{width:22px;height:22px;vertical-align:middle}}.sign{{background:var(--paper);padding:16px;border:1px solid var(--line);border-radius:10px}}input[type=text]{{width:100%;min-height:48px;padding:8px;border:1px solid var(--line);border-radius:8px}}button{{min-height:52px;margin-top:12px;padding:10px 18px;border:0;border-radius:8px;background:var(--accent);color:white;font:inherit}}@media(max-width:800px){{.pair{{grid-template-columns:1fr}}}}
</style></head><body><header><b>Starter 私有發布：固定 10 題視覺抽查</b><br>所有勾選與簽名都綁定本次 exact source hash；任何檔案改變後本簽核自動失效。</header><main>{''.join(cards)}<section class="sign"><label>最終發布簽核人（可辨識真人姓名）<input type="text" id="reviewer"></label><button id="export">全部核對完成，下載發布簽核</button></section></main><script>'use strict';const meta={encoded};document.getElementById('export').onclick=()=>{{const name=document.getElementById('reviewer').value.trim(),cards=[...document.querySelectorAll('article')];if(name.length<3){{alert('請填可辨識的真人姓名');return}}for(const card of cards)if([...card.querySelectorAll('[data-check]')].some(x=>!x.checked)){{alert(`尚未完成：${{card.dataset.id}}`);return}}const out={{kind:'matha-starter-private-release-signoff',version:1,releaseAuthority:true,approvedBy:name,approvedAt:new Date().toISOString(),statement:{json.dumps(SIGNOFF_STATEMENT)},...meta,sampleChecks:cards.map(card=>({{id:card.dataset.id,questionPixelsVerified:true,answerBindingVerified:true,structuredAnswerVerified:true}}))}};const blob=new Blob([JSON.stringify(out,null,2)+'\\n'],{{type:'application/json'}}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='starter-private-release-signoff.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}};</script></body></html>'''


def prepare(dual_files: list[Path], selection_file: Path, pdf_root: Path,
            output: Path) -> dict[str, Any]:
    output = outside_repo(output)
    if output.exists():
        raise StarterReleaseError("release preparation output already exists")
    selection = load_json(selection_file, "starter selection")
    if (selection.get("kind") != "matha-cleaned-starter-review-selection"
            or selection.get("releaseAuthority") is not False):
        raise StarterReleaseError("starter selection is not a review-only manifest")
    selected = unique_rows(selection.get("items"), "starter selection items")
    trusted, catalog = load_catalog()

    dual_documents = []
    eligible: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for dual_file in dual_files:
        dual = load_json(dual_file, "dual review")
        if (dual.get("kind") != "matha-private-cleaned-dual-review-candidates"
                or dual.get("version") != 1 or dual.get("releaseAuthority") is not False
                or dual.get("humanReleaseSignoffStillRequired") is not True
                or dual.get("uploadPerformed") is not False):
            raise StarterReleaseError(f"invalid dual review manifest: {dual_file}")
        if any(NON_HUMAN.search(str(dual.get(field) or ""))
               for field in ("pixelReviewer", "answerReviewer")):
            raise StarterReleaseError("dual review contains a non-human reviewer")
        rows = unique_rows(dual.get("items"), f"dual review items: {dual_file.name}")
        for question_id, row in rows.items():
            if question_id in eligible:
                raise StarterReleaseError(f"question appears in multiple dual reviews: {question_id}")
            if question_id not in selected:
                raise StarterReleaseError(f"dual-reviewed question is not in starter selection: {question_id}")
            eligible[question_id] = (row, dual)
        dual_documents.append({"path": str(dual_file.resolve()), "sha256": sha256(dual_file)})
    if not eligible:
        raise StarterReleaseError("no dual-reviewed questions are eligible")

    seed = hashlib.sha256(
        (sha256(selection_file) + "|" + "|".join(row["sha256"] for row in dual_documents)).encode()
    ).hexdigest()
    release_id = f"starter-{seed[:16]}"
    promotion_root = output / "promotion"
    questions = []
    sample_evidence: dict[str, dict[str, Path]] = {}
    pdf_cache: dict[str, tuple[Path, dict[str, Any]]] = {}
    reviewed_times = []
    reviewer_names = []

    for question_id in sorted(eligible):
        row, dual = eligible[question_id]
        selected_row = selected[question_id]
        for field in ("bookId", "pdfPage", "cleanedSha256", "answerSha256", "sourcePdfSha256"):
            selected_value = selected_row.get(field)
            if field == "sourcePdfSha256" and selected_value is None:
                selected_value = row.get(field)
            if row.get(field) != selected_value:
                raise StarterReleaseError(f"{question_id}: selection/dual {field} mismatch")
        cleaned = Path(str(selected_row.get("cleanedPath") or row.get("cleaned") or ""))
        answer = Path(str(selected_row.get("answerPath") or ""))
        if not cleaned.is_file() or sha256(cleaned) != row.get("cleanedSha256"):
            raise StarterReleaseError(f"{question_id}: cleaned pixels changed")
        if not answer.is_file() or sha256(answer) != row.get("answerSha256"):
            raise StarterReleaseError(f"{question_id}: official answer pixels changed")
        book_id = row.get("bookId")
        book = catalog.get(book_id)
        if not book or book.get("pdfSha256") != row.get("sourcePdfSha256"):
            raise StarterReleaseError(f"{question_id}: catalog PDF identity mismatch")
        if book_id not in pdf_cache:
            pdf_file = pdf_root / str(book.get("file") or "")
            if not pdf_file.is_file() or sha256(pdf_file) != book.get("pdfSha256"):
                raise StarterReleaseError(f"catalog PDF missing or changed: {book_id}")
            pdf_cache[book_id] = (pdf_file, book)
        pdf_file, _ = pdf_cache[book_id]
        topic = selected_row.get("topic")
        if topic not in set(book.get("topics") or []):
            raise StarterReleaseError(f"{question_id}: topic is not permitted by the catalog book")
        qtype, options, correct = normalize_answer(row.get("structuredAnswer"), question_id)
        with Image.open(cleaned) as image:
            width, height = image.size
            if width < 80 or height < 80:
                raise StarterReleaseError(f"{question_id}: cleaned crop is too small")
        dpi = int(row.get("cropDpi") or 300)
        bbox = normalized_bbox(
            pdf_file, int(row.get("pdfPage")), row.get("stemRegion"), dpi, question_id
        )
        relative = f"releases/{release_id}/stems/{book_id}/{question_id}-{row['cleanedSha256'][:16]}.png"
        target = promotion_root / "promoted" / book_id / "stem-assets" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cleaned, target)
        if sha256(target) != row["cleanedSha256"]:
            raise StarterReleaseError(f"{question_id}: copied cleaned pixels changed")
        pixel_reviewer = str(dual.get("pixelReviewer"))
        answer_reviewer = str(dual.get("answerReviewer"))
        reviewer_names.extend([pixel_reviewer, answer_reviewer])
        reviewed_times.extend([str(dual.get("pixelReviewedAt")), str(dual.get("answerReviewedAt"))])
        role = selected_row.get("role") or row.get("role") or "unclassified"
        source_text = f"{book.get('title')}｜PDF 第 {row.get('pdfPage')} 頁"
        question = {
            "id": question_id,
            "topic": topic,
            "type": qtype,
            "diff": ROLE_DIFF.get(role, 2),
            "q": "完整題目、公式、選項與圖形請見原 PDF 題目裁圖。",
            "opts": options,
            "ans": correct,
            "sol": "官方答案：" + (
                row["structuredAnswer"].get("officialAnswerText")
                if qtype == "fill" else "、".join(map(str, row["structuredAnswer"]["correctOptionNumbers"]))
            ),
            "src": source_text,
            "bookId": book_id,
            "bookTitle": book.get("title"),
            "page": int(row.get("pdfPage")),
            "role": role,
            "displayTruth": "original-pdf-crop",
            "needsStemAsset": True,
            "stemAsset": {
                "path": relative,
                "sha256": row["cleanedSha256"],
                "sourcePdfSha256": row["sourcePdfSha256"],
                "pageIndex": int(row.get("pdfPage")),
                "bbox": bbox,
                "role": "question-stem",
                "assetStatus": "verified",
                "mime": "image/png",
                "width": width,
                "height": height,
                "containsAnswer": False,
                "containsSolution": False,
                "containsHandwriting": False,
                "includesOptions": qtype in {"single", "multi"},
                "questionIds": [question_id],
                "bookId": book_id,
                "producer": "YesScanner handwriting-remover v2",
                "verifier": {
                    "reviewer": pixel_reviewer,
                    "reviewVersion": 2,
                    "questionRoleVerified": True,
                    "safetyVerified": True,
                    "assetHashVerified": True,
                    "fullStemVerified": True,
                    "optionsVerified": True,
                    "verifiedAt": dual.get("pixelReviewedAt"),
                },
            },
            "answerVerification": {
                "reviewer": answer_reviewer,
                "reviewedAt": dual.get("answerReviewedAt"),
                "officialAnswerSha256": row["answerSha256"],
                "answerSource": row.get("answerSource"),
                "answerPdfPage": row.get("answerPdfPage"),
                "structuredAnswer": row["structuredAnswer"],
            },
        }
        questions.append(question)
        sample_evidence[question_id] = {"question": cleaned, "answer": answer}

    latest_review = max(
        datetime.fromisoformat(value.replace("Z", "+00:00")) for value in reviewed_times
    ).isoformat()
    ranked = sorted(questions, key=lambda q: hashlib.sha256(
        f"{seed}|{q['id']}".encode()).hexdigest())
    sample_ids = [question["id"] for question in ranked[:min(10, len(ranked))]]
    source = {
        "schema": 3,
        "kind": "private-question-source",
        "releaseId": release_id,
        "corpusGeneration": trusted["generation"],
        "sourceInventorySha256": trusted["sourceInventorySha256"],
        "sourceDocuments": trusted["sourceDocuments"],
        "sourcePages": trusted["sourcePages"],
        "ocrProvider": trusted["ocrProvider"],
        "ocrModel": trusted["ocrModel"],
        "verificationPolicy": trusted["verificationPolicy"],
        "originalPdfVerified": True,
        "answerKeyVerified": True,
        "mathematicalCorrectnessVerified": True,
        "reviewedBy": " / ".join(sorted(set(reviewer_names))),
        "releaseApprovedBy": None,
        "releaseReviewSampleQuestionIds": sample_ids,
        "reviewAudit": {
            "sourceQuestionCount": len(questions),
            "approvedQuestionCount": len(questions),
            "completedAt": latest_review,
            "dualReviewSha256": [row["sha256"] for row in dual_documents],
            "selectionSha256": sha256(selection_file),
        },
        "questions": questions,
    }
    # The promotion asset copy above intentionally creates descendants under
    # this fresh output root before the JSON manifests are written.
    output.mkdir(parents=True, exist_ok=True)
    source_file = output / "unsigned-private-question-source.json"
    source_file.write_text(json.dumps(source, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    sample_root = output / "release-review-assets"
    review_rows = []
    by_id = {question["id"]: question for question in questions}
    for question_id in sample_ids:
        question_dir = sample_root / question_id
        question_dir.mkdir(parents=True, exist_ok=True)
        question_file = question_dir / "question.png"
        answer_file = question_dir / "answer.png"
        shutil.copy2(sample_evidence[question_id]["question"], question_file)
        shutil.copy2(sample_evidence[question_id]["answer"], answer_file)
        question = by_id[question_id]
        structured = question["answerVerification"]["structuredAnswer"]
        review_rows.append({
            "id": question_id, "book": question["bookTitle"],
            "page": str(question["page"]), "topic": question["topic"],
            "question": question_file.relative_to(output).as_posix(),
            "answer": answer_file.relative_to(output).as_posix(),
            "structured": json.dumps(structured, ensure_ascii=False),
        })

    asset_manifest = {
        "kind": "matha-starter-private-asset-manifest", "version": 1,
        "releaseAuthority": False, "releaseId": release_id,
        "questions": [{
            "id": q["id"], "path": q["stemAsset"]["path"],
            "sha256": q["stemAsset"]["sha256"], "bookId": q["bookId"],
        } for q in questions],
    }
    asset_file = output / "asset-manifest.json"
    asset_file.write_text(json.dumps(asset_manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    metadata = {
        "releaseId": release_id,
        "unsignedSourceSha256": sha256(source_file),
        "assetManifestSha256": sha256(asset_file),
        "selectionSha256": sha256(selection_file),
        "dualReviewSha256": [row["sha256"] for row in dual_documents],
        "sampleQuestionIds": sample_ids,
    }
    (output / "release-review.html").write_text(
        review_html(review_rows, metadata), encoding="utf-8"
    )
    packet = {
        "kind": "matha-starter-private-release-review-packet", "version": 1,
        "releaseAuthority": False, **metadata,
        "questions": len(questions), "sampleSize": len(sample_ids),
        "review": str((output / "release-review.html").resolve()),
        "promotionRoot": str(promotion_root.resolve()),
        "next": "Complete the visual sample and export starter-private-release-signoff.json.",
    }
    packet_file = output / "release-review-packet.json"
    packet_file.write_text(json.dumps(packet, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return packet


def finalize(source_file: Path, asset_manifest_file: Path, signoff_file: Path,
             output_file: Path) -> dict[str, Any]:
    output_file = outside_repo(output_file)
    if output_file.exists():
        raise StarterReleaseError("signed output already exists; refusing to overwrite")
    source = load_json(source_file, "unsigned source")
    assets = load_json(asset_manifest_file, "asset manifest")
    signoff = load_json(signoff_file, "release signoff")
    if (source.get("kind") != "private-question-source"
            or source.get("releaseApprovedBy") is not None
            or assets.get("kind") != "matha-starter-private-asset-manifest"):
        raise StarterReleaseError("source or asset manifest is not an unsigned starter release")
    if (signoff.get("kind") != "matha-starter-private-release-signoff"
            or signoff.get("version") != 1 or signoff.get("releaseAuthority") is not True
            or signoff.get("statement") != SIGNOFF_STATEMENT):
        raise StarterReleaseError("release signoff contract is invalid")
    approved_by = str(signoff.get("approvedBy") or "").strip()
    if len(approved_by) < 3 or NON_HUMAN.search(approved_by):
        raise StarterReleaseError("release signer must be an identifiable human")
    approved_at = signoff.get("approvedAt")
    try:
        parsed = datetime.fromisoformat(str(approved_at).replace("Z", "+00:00"))
    except ValueError as error:
        raise StarterReleaseError("release approval time is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise StarterReleaseError("release approval time must include a timezone")
    exact = {
        "releaseId": source.get("releaseId"),
        "unsignedSourceSha256": sha256(source_file),
        "assetManifestSha256": sha256(asset_manifest_file),
        "selectionSha256": (source.get("reviewAudit") or {}).get("selectionSha256"),
        "dualReviewSha256": (source.get("reviewAudit") or {}).get("dualReviewSha256"),
    }
    for key, value in exact.items():
        if signoff.get(key) != value:
            raise StarterReleaseError(f"release signoff {key} hash binding mismatch")
    expected_samples = source.get("releaseReviewSampleQuestionIds")
    checks = signoff.get("sampleChecks")
    if (not isinstance(expected_samples, list) or not expected_samples
            or len(expected_samples) != min(10, len(source.get("questions") or []))
            or signoff.get("sampleQuestionIds") != expected_samples
            or not isinstance(checks, list)
            or [row.get("id") for row in checks if isinstance(row, dict)] != expected_samples
            or any(not isinstance(row, dict)
                   or set(row) != {"id", "questionPixelsVerified", "answerBindingVerified",
                                "structuredAnswerVerified"}
                   or any(row.get(field) is not True for field in (
                       "questionPixelsVerified", "answerBindingVerified",
                       "structuredAnswerVerified")) for row in checks)):
        raise StarterReleaseError("release visual sample is incomplete or changed")
    asset_rows = unique_rows(assets.get("questions"), "asset manifest questions")
    source_rows = unique_rows(source.get("questions"), "source questions")
    if set(asset_rows) != set(source_rows):
        raise StarterReleaseError("source and asset manifest question sets differ")
    signed = {
        **source,
        "releaseApprovedBy": approved_by,
        "releaseApproval": {
            "kind": "named-human-starter-private-release-signoff", "version": 1,
            "approvedBy": approved_by, "approvedAt": str(approved_at),
            "statement": SIGNOFF_STATEMENT,
            "unsignedSourceSha256": sha256(source_file),
            "assetManifestSha256": sha256(asset_manifest_file),
            "signoffSha256": sha256(signoff_file),
            "sampleQuestionIds": expected_samples,
        },
    }
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(signed, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return {
        "releaseId": source["releaseId"], "questions": len(source_rows),
        "approvedBy": approved_by, "signedOutput": str(output_file),
        "signedSha256": sha256(output_file),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--dual-review", action="append", required=True, type=Path)
    prepare_parser.add_argument("--selection", required=True, type=Path)
    prepare_parser.add_argument("--pdf-root", required=True, type=Path)
    prepare_parser.add_argument("--output", required=True, type=Path)
    final_parser = commands.add_parser("finalize")
    final_parser.add_argument("--source", required=True, type=Path)
    final_parser.add_argument("--asset-manifest", required=True, type=Path)
    final_parser.add_argument("--signoff", required=True, type=Path)
    final_parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = (
            prepare(args.dual_review, args.selection, args.pdf_root, args.output)
            if args.command == "prepare"
            else finalize(args.source, args.asset_manifest, args.signoff, args.output)
        )
    except (StarterReleaseError, OSError, ValueError, json.JSONDecodeError, fitz.FileDataError) as error:
        print(f"prepare-starter-private-release: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
