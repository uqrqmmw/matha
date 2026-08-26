#!/usr/bin/env python3
"""Prepare a private, offline review page for original-PDF question crops.

The page deliberately does not show OCR/transcribed problem text.  Reviewers
judge only the source pixels, then download a hash-bound JSON decision file for
``promote-reviewed-stems.py``.  No copyrighted image is copied into Git or
uploaded by this command.
"""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "promote_reviewed_stems", SCRIPT_DIR / "promote-reviewed-stems.py")
stem = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(stem)


def prepare(source_file: Path, book_dir: Path, pdf_file: Path, crop_manifest_file: Path,
            output_dir: Path, catalog_file: Path) -> dict[str, Any]:
    source_file = stem.ensure_outside_repo(source_file)
    book_dir = stem.ensure_outside_repo(book_dir)
    pdf_file = stem.ensure_outside_repo(pdf_file)
    crop_manifest_file = stem.ensure_outside_repo(crop_manifest_file)
    output_dir = stem.ensure_outside_repo(output_dir)
    if output_dir.exists() and any(output_dir.iterdir()):
        raise stem.PromotionError("Review output directory must be empty to prevent stale decisions")
    output_dir.mkdir(parents=True, exist_ok=True)

    source = stem.read_json(source_file)
    manifest = stem.read_json(crop_manifest_file)
    questions = source.get("questions")
    if source.get("kind") != "private-question-source" or not isinstance(questions, list) or not questions:
        raise stem.PromotionError("Source must be a non-empty apply-review qpack")
    book_id = str(source.get("bookId") or "")
    pdf_hash = stem.sha256(pdf_file)
    if stem.catalog_books(catalog_file).get(book_id) != pdf_hash or source.get("pdfSha256") != pdf_hash:
        raise stem.PromotionError("Source PDF/qpack does not match the trusted textbook catalog")
    if manifest.get("schema") != 11 or manifest.get("kind") != "textbook-crop-manifest" \
            or manifest.get("bookId") != book_id or manifest.get("pdfSha256") != pdf_hash:
        raise stem.PromotionError("Crop manifest does not match the trusted qpack")
    crop_dpi = manifest.get("cropDpi")
    if not isinstance(crop_dpi, int) or crop_dpi < 150 or crop_dpi > 600:
        raise stem.PromotionError("Crop manifest DPI is invalid")

    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    document = stem.fitz.open(str(pdf_file))
    try:
        for question in questions:
            if not isinstance(question, dict) or not isinstance(question.get("id"), str):
                raise stem.PromotionError("Qpack has a question without a valid id")
            qid = question["id"]
            if qid in seen:
                raise stem.PromotionError(f"Qpack has duplicate id {qid}")
            seen.add(qid)
            if question.get("bookId") != book_id or question.get("displayTruth") != "original-pdf-crop" \
                    or question.get("needsStemAsset") is not True:
                raise stem.PromotionError(f"Question {qid} did not arrive through scan-review quarantine")
            page = question.get("page")
            if not isinstance(page, int) or page < 1:
                raise stem.PromotionError(f"Question {qid} has no valid PDF page")
            entry = (manifest.get("crops") or {}).get(qid) or {}
            region = entry.get("stemRegion")
            if not isinstance(region, list):
                raise stem.PromotionError(f"Question {qid} has no stem crop")
            page_index = stem.read_json(book_dir / "pages" / f"p{page:04d}.json")
            if page_index.get("bookId") != book_id or page_index.get("pdfSha256") != pdf_hash \
                    or page_index.get("pdfPage") != page:
                raise stem.PromotionError(f"Page index is not bound to the trusted PDF for {qid}")
            geometry = (page_index.get("width"), page_index.get("height"), page_index.get("dpi"))
            if not all(isinstance(value, int) and value > 0 for value in geometry):
                raise stem.PromotionError(f"Page index geometry is invalid for {qid}")
            stem.normalized_bbox(region, geometry[0], geometry[1])
            crop_file = book_dir / "crops" / qid / "stem.png"
            if not crop_file.is_file():
                raise stem.PromotionError(f"Stem crop is missing for {qid}")
            width, height = stem.pixmap_matches_original(
                crop_file, document, page, region, geometry[2], crop_dpi)
            answer_file = book_dir / "crops" / qid / "answer.png"
            rows.append({
                "id": qid, "page": page, "printedPage": question.get("printedPage"),
                "type": question.get("type"), "role": question.get("role"),
                "cropSha256": stem.sha256(crop_file), "width": width, "height": height,
                "cropUri": crop_file.resolve().as_uri(),
                "answerUri": answer_file.resolve().as_uri() if answer_file.is_file() else "",
            })
    finally:
        document.close()

    source_hash = stem.sha256(source_file)
    manifest_hash = stem.sha256(crop_manifest_file)
    template = {
        "kind": "matha-private-stem-independent-review", "version": 1,
        "reviewer": "", "reviewedAt": "", "sourceSha256": source_hash,
        "cropManifestSha256": manifest_hash,
        "summary": {"passed": 0, "failed": len(rows)},
        "questions": [{
            "id": row["id"], "decision": "", "cropSha256": row["cropSha256"],
            "integrity": {"sourcePdfHash": True, "cropHash": True,
                          "cropPixelsMatchPdf": True, "bookPageQuestionBinding": True},
            "visual": {"fullStemVerified": None, "allOptionsVerified": None,
                       "containsAnswer": None, "containsSolution": None,
                       "containsHandwriting": None, "containsAdjacentQuestion": None},
            "notes": "",
        } for row in rows],
        "howToUse": "Open review.html, inspect original pixels, then download the completed review JSON.",
    }
    template_file = output_dir / "independent-stem-review.template.json"
    template_file.write_text(json.dumps(template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    review_file = output_dir / "review.html"
    review_file.write_text(review_html(book_id, rows, template), encoding="utf-8")
    return {"questions": len(rows), "template": str(template_file), "reviewPage": str(review_file),
            "sourceSha256": source_hash, "cropManifestSha256": manifest_hash}


def review_html(book_id: str, rows: list[dict[str, Any]], template: dict[str, Any]) -> str:
    cards = []
    for row in rows:
        qid = html.escape(row["id"])
        options = "" if row["type"] == "fill" else (
            '<label><input type="checkbox" data-check="options"> 全部選項都完整可見</label>')
        answer = (f'<details><summary>核對官方答案裁圖（不屬於學生題面）</summary>'
                  f'<img class="answer" src="{html.escape(row["answerUri"])}" alt="官方答案裁圖"></details>') \
            if row["answerUri"] else '<p class="warning">沒有答案裁圖；本批只能審題面，不能證明答案正確。</p>'
        cards.append(f'''<article data-id="{qid}" data-type="{html.escape(str(row['type']))}">
          <header><b>{qid}</b><span>PDF {row['page']} · 印刷頁 {html.escape(str(row['printedPage']))} · {html.escape(str(row['type']))}</span></header>
          <img class="stem" src="{html.escape(row['cropUri'])}" alt="原 PDF 題幹與選項裁圖">
          <fieldset><legend>裁圖審核</legend>
            <label><input type="radio" name="decision-{qid}" value="pass"> 通過</label>
            <label><input type="radio" name="decision-{qid}" value="reject"> 退回重裁</label>
            <label><input type="checkbox" data-check="stem"> 完整題幹、條件、公式、圖表均可見</label>{options}
            <label><input type="checkbox" data-check="no-answer"> 題面沒有答案或詳解</label>
            <label><input type="checkbox" data-check="no-writing"> 題面沒有前手筆跡</label>
            <label><input type="checkbox" data-check="no-adjacent"> 題面沒有相鄰題目</label>
            <label>備註 <input type="text" data-notes></label>
          </fieldset>{answer}</article>''')
    base = json.dumps({key: value for key, value in template.items() if key != "questions"}, ensure_ascii=False).replace("</", "<\\/")
    rows_json = json.dumps([{"id": row["id"], "type": row["type"], "cropSha256": row["cropSha256"]}
                            for row in rows], ensure_ascii=False).replace("</", "<\\/")
    return f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>{html.escape(book_id)} 原卷題面審核</title><style>
    :root{{--paper:#f7f5f0;--card:#fff;--ink:#34312d;--line:#d7d1c7;--accent:#68776b}}
    *{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 system-ui,"Microsoft JhengHei",sans-serif}}
    nav{{position:sticky;top:0;z-index:2;display:flex;gap:16px;align-items:center;padding:14px 20px;background:#f7f5f0ee;border-bottom:1px solid var(--line)}}
    nav input{{min-width:260px;padding:10px}}button{{padding:11px 18px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:700}}
    main{{max-width:1300px;margin:auto;padding:22px}}article{{margin:0 0 28px;padding:18px;background:var(--card);border:1px solid var(--line);border-radius:10px}}
    header{{display:flex;justify-content:space-between;gap:16px;margin-bottom:12px}}.stem{{display:block;width:100%;height:auto;background:#fff;border:1px solid var(--line)}}
    fieldset{{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 18px;margin-top:14px;border:1px solid var(--line)}}
    label{{display:flex;gap:8px;align-items:center}}label input[type=checkbox],label input[type=radio]{{width:22px;height:22px}}label input[type=text]{{flex:1;padding:8px}}
    details{{margin-top:12px}}.answer{{max-width:100%;border:1px solid var(--line)}}.warning{{color:#8a5c3d}}
    </style></head><body><nav><b>原卷題面審核：{html.escape(book_id)}</b><label>審核者 <input id="reviewer" autocomplete="off"></label><button id="export">下載審核 JSON</button></nav>
    <main><p>只以原 PDF 像素判斷，不以 OCR／轉錄文字判斷。每題必須做出通過或退回決定；未勾選安全項目會視為不安全。</p>{''.join(cards)}</main>
    <script>'use strict';const base={base};const rows={rows_json};
    document.getElementById('export').addEventListener('click',()=>{{const reviewer=document.getElementById('reviewer').value.trim();if(reviewer.length<3){{alert('請填可辨識的審核者名稱');return}}
      const questions=[];let passed=0,failed=0;for(const row of rows){{const card=document.querySelector(`article[data-id="${{CSS.escape(row.id)}}"]`);const choice=card.querySelector('input[type=radio]:checked');if(!choice){{alert(`尚未決定：${{row.id}}`);return}}
        const checked=name=>!!card.querySelector(`[data-check="${{name}}"]`)?.checked;const decision=choice.value;decision==='pass'?passed++:failed++;
        questions.push({{id:row.id,decision,cropSha256:row.cropSha256,integrity:{{sourcePdfHash:true,cropHash:true,cropPixelsMatchPdf:true,bookPageQuestionBinding:true}},visual:{{fullStemVerified:checked('stem'),allOptionsVerified:row.type==='fill'||checked('options'),containsAnswer:!checked('no-answer'),containsSolution:!checked('no-answer'),containsHandwriting:!checked('no-writing'),containsAdjacentQuestion:!checked('no-adjacent')}},notes:card.querySelector('[data-notes]').value.trim()}})}}
      const output={{...base,reviewer,reviewedAt:new Date().toISOString(),summary:{{passed,failed}},questions}};delete output.howToUse;const blob=new Blob([JSON.stringify(output,null,2)+'\\n'],{{type:'application/json'}});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='independent-stem-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}});
    </script></body></html>'''


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--book-dir", required=True, type=Path)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--crop-manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--catalog", type=Path, default=stem.REPO_ROOT / "textbook-catalog.js")
    args = parser.parse_args(argv)
    try:
        result = prepare(args.source, args.book_dir, args.pdf, args.crop_manifest, args.output, args.catalog)
    except (stem.PromotionError, OSError, ValueError) as error:
        print(f"prepare-stem-review: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
