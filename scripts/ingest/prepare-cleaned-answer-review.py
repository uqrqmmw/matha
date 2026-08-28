#!/usr/bin/env python3
"""Bind cleaned question candidates to exact source-PDF answer pixels.

The output is an offline, paged human review packet.  OCR text is never used
as answer truth.  Missing or mismatched question/answer evidence is explicitly
quarantined, and even a completed review remains ``releaseAuthority:false``
until the separate handwriting pixel review has also been signed.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any

import fitz


REPO_ROOT = Path(__file__).resolve().parents[2]
SAFE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z")


class AnswerReviewError(RuntimeError):
    pass


class QuarantineItem(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise AnswerReviewError("Private textbook artifacts must stay outside the Git repository")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AnswerReviewError(f"Cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise AnswerReviewError(f"Expected a JSON object: {path}")
    return value


def catalog_rows(path: Path) -> dict[str, dict[str, str]]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        value = json.loads(text)
        rows = [*(value.get("books") or []), *(value.get("supplemental") or [])]
        return {
            str(row["id"]): {"file": str(row["file"]), "pdfSha256": str(row["pdfSha256"])}
            for row in rows if row.get("id") and row.get("file") and row.get("pdfSha256")
        }
    result: dict[str, dict[str, str]] = {}
    pattern = re.compile(
        r"\{\s*id:'([^']+)'[^\n]*?file:'([^']+)'[^\n]*?pdfSha256:'([a-f0-9]{64})'"
    )
    for match in pattern.finditer(text):
        result[match.group(1)] = {"file": match.group(2), "pdfSha256": match.group(3)}
    return result


def checked_file(path: Path, expected_hash: str, label: str) -> Path:
    path = outside_repo(path)
    if not path.is_file() or not re.fullmatch(r"[a-f0-9]{64}", str(expected_hash)):
        raise QuarantineItem(f"{label}-missing-or-unbound")
    if sha256(path) != expected_hash:
        raise QuarantineItem(f"{label}-hash-mismatch")
    return path


def normalized_region(region: Any, label: str) -> list[int]:
    if (not isinstance(region, list) or len(region) != 4
            or not all(isinstance(value, int) for value in region)):
        raise QuarantineItem(f"{label}-region-invalid")
    x0, y0, x1, y1 = region
    if x0 < 0 or y0 < 0 or x1 <= x0 or y1 <= y0:
        raise QuarantineItem(f"{label}-region-empty")
    return region


def pdf_rect(region: list[int], review_dpi: int = 150) -> fitz.Rect:
    scale = 72.0 / review_dpi
    return fitz.Rect(*(value * scale for value in region))


def exact_pdf_crop(image: Path, document: fitz.Document, page_number: int,
                   region: list[int], crop_dpi: int, label: str) -> tuple[int, int]:
    if page_number < 1 or page_number > document.page_count:
        raise QuarantineItem(f"{label}-page-out-of-range")
    try:
        actual = fitz.Pixmap(str(image))
        expected = document[page_number - 1].get_pixmap(
            dpi=crop_dpi, clip=pdf_rect(region), alpha=False
        )
    except Exception as error:
        raise QuarantineItem(f"{label}-pixel-check-failed:{error}") from error
    exact = (actual.width == expected.width and actual.height == expected.height
             and actual.n == expected.n and actual.samples == expected.samples)
    # PyMuPDF can round a clip that touches the physical right/bottom page edge
    # a few pixels wider than the original full-page raster.  Accept only an
    # exact top-left pixel prefix with a very small edge-only size difference;
    # never resample or tolerate changed content.
    edge_clamped = False
    if (not exact and actual.n == expected.n and actual.width <= expected.width
            and actual.height <= expected.height
            and expected.width - actual.width <= 12
            and expected.height - actual.height <= 2):
        channels = actual.n
        actual_samples = actual.samples
        expected_samples = expected.samples
        edge_clamped = all(
            actual_samples[y * actual.width * channels:(y + 1) * actual.width * channels]
            == expected_samples[
                y * expected.width * channels:y * expected.width * channels
                + actual.width * channels
            ]
            for y in range(actual.height)
        )
    if not exact and not edge_clamped:
        raise QuarantineItem(f"{label}-pixels-do-not-match-source-pdf")
    return actual.width, actual.height


def answer_location(question: dict[str, Any], crop: dict[str, Any]) -> tuple[int, list[int], str]:
    inline = (question.get("regions") or {}).get("inlineAnswer")
    if inline:
        return int(question["pdfPage"]), normalized_region(inline, "inline-answer"), "inline"
    answer_ref = question.get("answerRef") or {}
    if answer_ref.get("pdfPage") and crop.get("answerRegion"):
        return (
            int(answer_ref["pdfPage"]),
            normalized_region(crop["answerRegion"], "answer-key"),
            "answer-key",
        )
    if question.get("solutionPdfPage") and question.get("solutionRegion"):
        return (
            int(question["solutionPdfPage"]),
            normalized_region(question["solutionRegion"], "next-page-solution"),
            "next-page-solution",
        )
    raise QuarantineItem("official-answer-region-missing")


def link_asset(source: Path, target: Path, expected_hash: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    if sha256(target) != expected_hash:
        raise AnswerReviewError(f"Materialized review asset hash mismatch: {target}")


def serve_script() -> str:
    return '''#!/usr/bin/env python3
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
parser = argparse.ArgumentParser(description="Serve the offline MathA answer review packet")
parser.add_argument("--port", type=int, default=8767)
args = parser.parse_args()
root = Path(__file__).resolve().parent
server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(SimpleHTTPRequestHandler, directory=str(root)))
print(f"Answer review: http://127.0.0.1:{args.port}/review.html", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
'''


CHECKS = [
    ("questionAnswerIdentityVerified", "題號、單元與題目確實對應這份答案"),
    ("allSubpartsCovered", "答案涵蓋題目的全部小題"),
    ("answerLegible", "答案與必要公式清楚可辨"),
    ("noAdjacentAnswerConfusion", "沒有把相鄰題答案誤當成本題答案"),
    ("figureConditionsHandled", "題目有圖時，答案有正確使用圖中條件"),
    ("mathematicallyCorrect", "已獨立確認答案與推理在數學上正確"),
]


def style() -> str:
    return '''<style>:root{--paper:#f4f2ed;--card:#fff;--ink:#34312d;--line:#d7d1c7;--accent:#647268;--warn:#8c4139}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.5 system-ui,"Microsoft JhengHei",sans-serif}nav{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 18px;background:#f4f2edf2;border-bottom:1px solid var(--line)}nav a{color:var(--ink)}nav input{padding:9px;min-width:240px}button{padding:10px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:700}main{max-width:1800px;margin:auto;padding:18px}article{margin:0 0 24px;padding:18px;background:var(--card);border:1px solid var(--line);border-radius:10px}header{display:flex;justify-content:space-between;gap:12px}.images{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:16px}figure{margin:0}figcaption{font-weight:700;margin-bottom:6px}img{display:block;width:100%;height:auto;background:#fff;border:1px solid var(--line)}fieldset{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px 16px;margin-top:14px;border:1px solid var(--line)}label{display:flex;gap:8px;align-items:center}label input[type=checkbox],label input[type=radio]{width:22px;height:22px}.decision{font-weight:700}.notes{grid-column:1/-1}.notes input{flex:1;padding:8px}.warning{color:var(--warn);font-weight:700}.pages{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px}.pages a{padding:10px;background:#fff;border:1px solid var(--line);border-radius:6px;text-align:center;text-decoration:none}@media(max-width:1000px){.images{grid-template-columns:1fr}nav{position:static}}</style>'''


def card(row: dict[str, Any]) -> str:
    qid = html.escape(row["id"])
    checks = "".join(
        f'<label><input type="checkbox" data-check="{key}"> {html.escape(label)}</label>'
        for key, label in CHECKS
    )
    return f'''<article data-id="{qid}"><header><b>{qid}</b><span>{html.escape(row['chapter'])} · 題目 PDF {row['pdfPage']} · 答案 PDF {row['answerPdfPage']} · {html.escape(row['answerSource'])}</span></header><p>下列兩張圖都已逐像素比對 catalog 所列原始 PDF；OCR 不參與答案真值。</p><div class="images"><figure><figcaption>去筆跡題面</figcaption><img src="../assets/{qid}/question.png" loading="lazy"></figure><figure><figcaption>原書答案／詳解</figcaption><img src="../assets/{qid}/answer.png" loading="lazy"></figure></div><fieldset><legend>人工答案與數學 QA</legend><label class="decision"><input type="radio" name="decision-{qid}" value="pass"> 通過答案 QA</label><label class="decision"><input type="radio" name="decision-{qid}" value="reject"> 隔離</label>{checks}<label class="notes">備註 <input type="text" data-notes></label></fieldset></article>'''


def page_script(binding_hash: str, rows: list[dict[str, Any]]) -> str:
    data = json.dumps([
        {"id": row["id"], "cleanedSha256": row["cleanedSha256"],
         "answerSha256": row["answerSha256"], "sourcePdfSha256": row["sourcePdfSha256"]}
        for row in rows
    ], ensure_ascii=False).replace("</", "<\\/")
    checks = json.dumps([key for key, _ in CHECKS])
    return f'''<script>'use strict';const bindingHash={json.dumps(binding_hash)};const rows={data};const checks={checks};const key=id=>`matha-answer-review:${{bindingHash}}:${{id}}`;for(const row of rows){{const card=document.querySelector(`article[data-id="${{CSS.escape(row.id)}}"]`);const saved=JSON.parse(localStorage.getItem(key(row.id))||'null');if(saved){{const radio=card.querySelector(`input[type=radio][value="${{saved.decision}}"]`);if(radio)radio.checked=true;for(const name of checks)card.querySelector(`[data-check="${{name}}"]`).checked=!!saved.visual?.[name];card.querySelector('[data-notes]').value=saved.notes||''}}card.addEventListener('change',()=>{{const decision=card.querySelector('input[type=radio]:checked')?.value||'';const visual=Object.fromEntries(checks.map(name=>[name,!!card.querySelector(`[data-check="${{name}}"]`).checked]));localStorage.setItem(key(row.id),JSON.stringify({{...row,decision,visual,notes:card.querySelector('[data-notes]').value.trim()}}));update()}});card.querySelector('[data-notes]').addEventListener('input',()=>card.dispatchEvent(new Event('change')))}}function update(){{let done=0;for(const row of rows)if(JSON.parse(localStorage.getItem(key(row.id))||'null')?.decision)done++;document.getElementById('progress').textContent=`本頁 ${{done}}/${{rows.length}}`}}update();</script>'''


def review_page(binding_hash: str, rows: list[dict[str, Any]], number: int,
                page_count: int) -> str:
    previous = f"page-{number - 1:04d}.html" if number > 1 else "../review.html"
    following = f"page-{number + 1:04d}.html" if number < page_count else "../review.html"
    return ("<!doctype html><html lang='zh-Hant'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>答案 QA {number}/{page_count}</title>{style()}</head><body><nav><a href='../review.html'>索引</a><a href='{previous}'>上一頁</a><b>{number}/{page_count}</b><a href='{following}'>下一頁</a><span id='progress'></span></nav><main>"
            + "".join(card(row) for row in rows) + "</main>" + page_script(binding_hash, rows) + "</body></html>")


def index_page(binding_hash: str, rows: list[dict[str, Any]], page_count: int,
               page_size: int, template: dict[str, Any], quarantined: int) -> str:
    links = "".join(f'<a href="review-pages/page-{n:04d}.html">{n}</a>' for n in range(1, page_count + 1))
    data = json.dumps([
        {"id": row["id"], "cleanedSha256": row["cleanedSha256"],
         "answerSha256": row["answerSha256"], "sourcePdfSha256": row["sourcePdfSha256"]}
        for row in rows
    ], ensure_ascii=False).replace("</", "<\\/")
    base = json.dumps({key: value for key, value in template.items() if key != "questions"}, ensure_ascii=False).replace("</", "<\\/")
    checks = json.dumps([key for key, _ in CHECKS])
    return f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>答案與數學 QA</title>{style()}</head><body><nav><b>答案與數學 QA</b><label>審核者 <input id="reviewer" autocomplete="off"></label><button id="export">下載審核 JSON</button><span id="progress"></span></nav><main><h1>{len(rows):,} 題答案複核</h1><p>另有 {quarantined} 題因缺少或無法驗證官方答案而隔離。執行 <code>python serve-review.py</code> 後從 <code>http://127.0.0.1:8767/review.html</code> 進入。此關卡不採信 OCR；必須確認答案屬於本題並獨立檢查數學正確性。</p><div class="pages">{links}</div></main><script>'use strict';const bindingHash={json.dumps(binding_hash)};const rows={data};const base={base};const checks={checks};const key=id=>`matha-answer-review:${{bindingHash}}:${{id}}`;const reviewerKey=`matha-answer-review:${{bindingHash}}:reviewer`;const reviewer=document.getElementById('reviewer');reviewer.value=localStorage.getItem(reviewerKey)||'';reviewer.addEventListener('input',()=>localStorage.setItem(reviewerKey,reviewer.value));function update(){{let done=0;for(const row of rows)if(JSON.parse(localStorage.getItem(key(row.id))||'null')?.decision)done++;document.getElementById('progress').textContent=`已決定 ${{done}}/${{rows.length}}`}}update();window.addEventListener('focus',update);document.getElementById('export').addEventListener('click',()=>{{const name=reviewer.value.trim();if(name.length<3){{alert('請填可辨識的真人審核者名稱');return}}const questions=[];let passed=0,rejected=0;for(const row of rows){{const saved=JSON.parse(localStorage.getItem(key(row.id))||'null');if(!saved?.decision){{alert(`尚未決定：${{row.id}}`);return}}if(saved.decision==='pass'&&!checks.every(name=>saved.visual?.[name]===true)){{alert(`通過題仍有未確認項目：${{row.id}}`);return}}saved.decision==='pass'?passed++:rejected++;questions.push(saved)}}const output={{...base,reviewer:name,reviewedAt:new Date().toISOString(),summary:{{passed,rejected,unreviewed:0}},questions}};const blob=new Blob([JSON.stringify(output,null,2)+'\n'],{{type:'application/json'}});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='cleaned-answer-human-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}});</script></body></html>'''


def prepare(candidate_manifest: Path, work: Path, source_root: Path, catalog: Path,
            output: Path, page_size: int = 20) -> dict[str, Any]:
    candidate_manifest = outside_repo(candidate_manifest)
    work = outside_repo(work)
    source_root = outside_repo(source_root)
    output = outside_repo(output)
    if page_size < 1 or page_size > 100:
        raise AnswerReviewError("Page size must be between 1 and 100")
    if output.exists() and any(output.iterdir()):
        raise AnswerReviewError("Answer review output must be empty")
    candidates = read_json(candidate_manifest)
    items = candidates.get("items")
    if (candidates.get("kind") != "cleaned-page-question-candidates"
            or candidates.get("releaseAuthority") is not False
            or not isinstance(items, list) or not items):
        raise AnswerReviewError("Candidate manifest is not a non-empty review-only recrop manifest")
    catalog_by_id = catalog_rows(catalog)
    if not catalog_by_id:
        raise AnswerReviewError("Trusted textbook catalog is empty")
    output.mkdir(parents=True, exist_ok=True)
    (output / "assets").mkdir()
    (output / "review-pages").mkdir()
    books: dict[str, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []
    quarantined: list[dict[str, Any]] = []
    seen: set[str] = set()
    try:
        for item in items:
            qid = item.get("id")
            if not isinstance(qid, str) or not SAFE_ID_RE.fullmatch(qid) or qid in seen:
                raise AnswerReviewError("Candidate ids must be safe and globally unique")
            seen.add(qid)
            bid = str(item.get("bookId") or "")
            try:
                if bid not in books:
                    catalog_row = catalog_by_id.get(bid)
                    if catalog_row is None:
                        raise QuarantineItem("book-not-in-trusted-catalog")
                    book = work / bid
                    question_doc = read_json(book / "questions.pending-review.json")
                    crop_doc = read_json(book / "crops-manifest.json")
                    pdf_hash = catalog_row["pdfSha256"]
                    if (question_doc.get("schema") != 11
                            or question_doc.get("kind") != "textbook-question-candidates"
                            or question_doc.get("bookId") != bid
                            or question_doc.get("pdfSha256") != pdf_hash
                            or crop_doc.get("schema") != 11
                            or crop_doc.get("kind") != "textbook-crop-manifest"
                            or crop_doc.get("bookId") != bid
                            or crop_doc.get("pdfSha256") != pdf_hash):
                        raise QuarantineItem("book-manifests-do-not-match-trusted-catalog")
                    pdf = checked_file(source_root / catalog_row["file"], pdf_hash, "source-pdf")
                    books[bid] = {
                        "questions": {row["id"]: row for row in question_doc.get("questions") or []},
                        "crops": crop_doc.get("crops") or {},
                        "cropDpi": int(crop_doc.get("cropDpi") or 0),
                        "pdfHash": pdf_hash,
                        "document": fitz.open(str(pdf)),
                        "book": book,
                    }
                info = books[bid]
                question = info["questions"].get(qid)
                crop = info["crops"].get(qid)
                if not isinstance(question, dict) or not isinstance(crop, dict):
                    raise QuarantineItem("question-or-crop-record-missing")
                if (question.get("bookId") != bid or question.get("pdfPage") != item.get("pdfPage")
                        or question.get("displayTruth") != "original-pdf-crop"):
                    raise QuarantineItem("book-page-question-binding-mismatch")
                if crop.get("stemRegion") != item.get("stemRegion"):
                    raise QuarantineItem("stem-region-binding-mismatch")
                expected_source = (info["book"] / "crops" / qid / "stem.png").resolve()
                source = checked_file(Path(str(item.get("source") or "")), str(item.get("sourceSha256") or ""), "source-stem")
                cleaned = checked_file(Path(str(item.get("cleaned") or "")), str(item.get("cleanedSha256") or ""), "cleaned-stem")
                if source != expected_source:
                    raise QuarantineItem("source-stem-path-mismatch")
                exact_pdf_crop(source, info["document"], int(item["pdfPage"]),
                               normalized_region(crop["stemRegion"], "stem"), info["cropDpi"], "stem")
                answer = info["book"] / "crops" / qid / "answer.png"
                if crop.get("answer") is not True or not answer.is_file():
                    raise QuarantineItem("official-answer-crop-missing")
                answer_hash = sha256(answer)
                answer_page, answer_region, answer_source = answer_location(question, crop)
                exact_pdf_crop(answer, info["document"], answer_page, answer_region,
                               info["cropDpi"], "answer")
                figure_count = int(crop.get("figures") or 0)
                figure_hashes = []
                for number in range(1, figure_count + 1):
                    figure = info["book"] / "crops" / qid / f"figure-{number}.png"
                    if not figure.is_file():
                        raise QuarantineItem("declared-figure-asset-missing")
                    figure_hashes.append(sha256(figure))
                link_asset(cleaned, output / "assets" / qid / "question.png", item["cleanedSha256"])
                link_asset(answer, output / "assets" / qid / "answer.png", answer_hash)
                rows.append({
                    "id": qid, "bookId": bid, "chapter": str(question.get("chapter") or ""),
                    "role": str(question.get("role") or ""), "questionType": str(question.get("questionType") or ""),
                    "pdfPage": int(item["pdfPage"]), "answerPdfPage": answer_page,
                    "answerRegion": answer_region, "answerSource": answer_source,
                    "sourcePdfSha256": info["pdfHash"], "sourceSha256": item["sourceSha256"],
                    "cleanedSha256": item["cleanedSha256"], "answerSha256": answer_hash,
                    "figureCount": figure_count, "figureSha256": figure_hashes,
                })
            except (QuarantineItem, OSError, ValueError, KeyError) as error:
                quarantined.append({"id": qid, "bookId": bid, "reason": str(error)})
    finally:
        for info in books.values():
            info["document"].close()
    candidate_hash = sha256(candidate_manifest)
    binding = {
        "kind": "cleaned-answer-binding-candidates", "version": 1,
        "releaseAuthority": False, "humanAnswerReviewRequired": True,
        "handwritingPixelReviewAlsoRequired": True,
        "candidateManifestSha256": candidate_hash, "catalogSha256": sha256(catalog),
        "total": len(items), "reviewableCount": len(rows),
        "quarantinedCount": len(quarantined), "quarantined": quarantined, "items": rows,
    }
    binding_file = output / "answer-binding-candidates.json"
    binding_file.write_text(json.dumps(binding, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    binding_hash = sha256(binding_file)
    template = {
        "kind": "matha-private-cleaned-answer-human-review", "version": 1,
        "releaseAuthority": False, "humanReviewerRequired": True,
        "answerBindingSha256": binding_hash, "candidateManifestSha256": candidate_hash,
        "reviewer": "", "reviewedAt": "",
        "summary": {"passed": 0, "rejected": 0, "unreviewed": len(rows)},
        "questions": [{
            "id": row["id"], "cleanedSha256": row["cleanedSha256"],
            "answerSha256": row["answerSha256"], "sourcePdfSha256": row["sourcePdfSha256"],
            "decision": "", "visual": {key: None for key, _ in CHECKS}, "notes": "",
        } for row in rows],
    }
    template_file = output / "cleaned-answer-human-review.template.json"
    template_file.write_text(json.dumps(template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    page_count = (len(rows) + page_size - 1) // page_size
    for offset in range(0, len(rows), page_size):
        number = offset // page_size + 1
        (output / "review-pages" / f"page-{number:04d}.html").write_text(
            review_page(binding_hash, rows[offset:offset + page_size], number, page_count),
            encoding="utf-8",
        )
    (output / "review.html").write_text(
        index_page(binding_hash, rows, page_count, page_size, template, len(quarantined)),
        encoding="utf-8",
    )
    (output / "serve-review.py").write_text(serve_script(), encoding="utf-8")
    packet = {
        "kind": "cleaned-answer-review-packet", "version": 1,
        "releaseAuthority": False, "total": len(items), "reviewable": len(rows),
        "quarantined": len(quarantined), "pages": page_count, "pageSize": page_size,
        "answerBindingSha256": binding_hash,
        "review": str((output / "review.html").resolve()),
        "localUrl": "http://127.0.0.1:8767/review.html", "serveCommand": "python serve-review.py",
    }
    (output / "review-packet.json").write_text(
        json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return packet


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, default=REPO_ROOT / "textbook-catalog.js")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--page-size", type=int, default=20)
    args = parser.parse_args(argv)
    try:
        result = prepare(
            args.candidate_manifest, args.work, args.source_root,
            args.catalog, args.out, args.page_size,
        )
    except (AnswerReviewError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"prepare-cleaned-answer-review: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
