#!/usr/bin/env python3
"""Build an offline, hash-bound pixel review packet for cleaned question crops.

This command never publishes questions.  It verifies the recrop manifest and
all referenced artifacts, generates a removed-ink overlay, and writes paged
HTML that stores review decisions in browser localStorage.  The exported JSON
remains ``releaseAuthority:false`` because answer and mathematical review are
separate release gates.
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

from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[2]


class ReviewPacketError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise ReviewPacketError("Review artifacts must stay outside the Git repository")


def checked_artifact(item: dict[str, Any], field: str, hash_field: str) -> Path:
    value = item.get(field)
    expected = item.get(hash_field)
    if not isinstance(value, str) or not isinstance(expected, str) or len(expected) != 64:
        raise ReviewPacketError(f"{item.get('id')}: invalid {field} binding")
    path = ensure_outside_repo(Path(value))
    if not path.is_file() or sha256(path) != expected:
        raise ReviewPacketError(f"{item.get('id')}: {field} hash mismatch")
    return path


def materialize_asset(source: Path, target: Path, expected_hash: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    if sha256(target) != expected_hash:
        raise ReviewPacketError(f"Materialized review asset hash mismatch: {target.name}")


def cleanup_items(path: Path, expected_hash: str | None, label: str) -> dict[str, dict[str, Any]]:
    path = ensure_outside_repo(path)
    if not path.is_file() or not isinstance(expected_hash, str) or sha256(path) != expected_hash:
        raise ReviewPacketError(f"{label} manifest hash mismatch")
    document = json.loads(path.read_text(encoding="utf-8"))
    if (document.get("service") != "yescanner-handwriting-remover-v1"
            or document.get("releaseAuthority") is not False):
        raise ReviewPacketError(f"{label} manifest is not a review-only YesScanner manifest")
    rows = document.get("cacheItems") or document.get("items") or []
    return {str(row["id"]): row for row in rows if row.get("id") and row.get("cleaned")}


def crop_page_evidence(image: Image.Image, region: list[Any], target_size: tuple[int, int],
                       qid: str) -> Image.Image:
    if len(region) != 4 or not all(isinstance(value, (int, float)) for value in region):
        raise ReviewPacketError(f"{qid}: invalid source crop region")
    x0, y0, x1, y1 = region
    if x1 <= x0 or y1 <= y0:
        raise ReviewPacketError(f"{qid}: empty source crop region")
    scale_x = target_size[0] / (x1 - x0)
    scale_y = target_size[1] / (y1 - y0)
    if abs(scale_x / scale_y - 1) > 0.01:
        raise ReviewPacketError(f"{qid}: source crop geometry is inconsistent")
    box = tuple(round(value * ((scale_x + scale_y) / 2)) for value in region)
    overflow = max(-box[0], -box[1], box[2] - image.width, box[3] - image.height)
    if overflow > 2:
        raise ReviewPacketError(f"{qid}: evidence crop exceeds cleaned page")
    box = (
        max(0, box[0]), max(0, box[1]),
        min(image.width, box[2]), min(image.height, box[3]),
    )
    result = image.crop(box)
    if result.size != target_size:
        result = result.resize(target_size, Image.Resampling.NEAREST)
    return result


def canonical_overlay(
    item: dict[str, Any], source_size: tuple[int, int], page_items: dict[str, dict[str, Any]],
    fallback_items: dict[str, dict[str, Any]],
) -> tuple[Image.Image, float, str]:
    qid = str(item["id"])
    mode = item.get("cleanupMode")
    if mode == "full-page-recrop":
        evidence = page_items.get(str(item.get("pageId")))
        if evidence is None:
            raise ReviewPacketError(f"{qid}: missing full-page cleanup evidence")
        if (evidence.get("sourceSha256") != item.get("pageRenderSha256")
                or evidence.get("cleanedSha256") != item.get("pageCleanedSha256")):
            raise ReviewPacketError(f"{qid}: full-page cleanup binding mismatch")
        diff = checked_artifact(evidence, "diff", "diffSha256")
        mask = checked_artifact(evidence, "mask", "maskSha256")
        with Image.open(diff) as diff_image, Image.open(mask) as mask_image:
            if diff_image.size != mask_image.size:
                raise ReviewPacketError(f"{qid}: full-page evidence geometry mismatch")
            overlay = crop_page_evidence(
                diff_image.convert("RGB"), item.get("stemRegion") or [], source_size, qid
            )
            cropped_mask = crop_page_evidence(
                mask_image.convert("L"), item.get("stemRegion") or [], source_size, qid
            )
        evidence_source = "hash-bound-full-page-overlay-crop"
    elif mode == "question-fallback":
        evidence = fallback_items.get(qid)
        if evidence is None:
            raise ReviewPacketError(f"{qid}: missing question-level cleanup evidence")
        if (evidence.get("sourceSha256") != item.get("sourceSha256")
                or evidence.get("cleanedSha256") != item.get("cleanedSha256")):
            raise ReviewPacketError(f"{qid}: question fallback binding mismatch")
        diff = checked_artifact(evidence, "diff", "diffSha256")
        mask = checked_artifact(evidence, "mask", "maskSha256")
        with Image.open(diff) as diff_image, Image.open(mask) as mask_image:
            if diff_image.size != source_size or mask_image.size != source_size:
                raise ReviewPacketError(f"{qid}: question fallback evidence geometry mismatch")
            overlay = diff_image.convert("RGB")
            overlay.load()
            cropped_mask = mask_image.convert("L")
            cropped_mask.load()
        evidence_source = "hash-bound-question-overlay"
    else:
        raise ReviewPacketError(f"{qid}: unsupported cleanup mode")
    pixels = (cropped_mask.get_flattened_data()
              if hasattr(cropped_mask, "get_flattened_data") else cropped_mask.getdata())
    changed = sum(1 for value in pixels if value)
    total = cropped_mask.width * cropped_mask.height
    cropped_mask.close()
    return overlay, changed / total if total else 0.0, evidence_source


def review_template(manifest_hash: str, page_cleanup_hash: str,
                    fallback_cleanup_hash: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "kind": "matha-private-cleaned-handwriting-human-review",
        "version": 1,
        "releaseAuthority": False,
        "humanReviewerRequired": True,
        "reviewer": "",
        "reviewedAt": "",
        "candidateManifestSha256": manifest_hash,
        "pageCleanupManifestSha256": page_cleanup_hash,
        "fallbackCleanupManifestSha256": fallback_cleanup_hash,
        "summary": {"passed": 0, "rejected": 0, "unreviewed": len(rows)},
        "questions": [
            {
                "id": row["id"],
                "sourceSha256": row["sourceSha256"],
                "cleanedSha256": row["cleanedSha256"],
                "removedOverlaySha256": row["removedOverlaySha256"],
                "decision": "",
                "visual": {
                    "printedContentIntact": None,
                    "allHandwritingRemoved": None,
                    "noAnswerOrSolutionLeak": None,
                    "fullQuestionAndOptions": None,
                    "figuresAndGreyLinesIntact": None,
                    "chineseTextIntact": None,
                    "mathSymbolsAndFormulasIntact": None,
                },
                "notes": "",
            }
            for row in rows
        ],
    }


CHECKS = [
    ("printedContentIntact", "印刷內容沒有被刪除或變形"),
    ("allHandwritingRemoved", "手寫、圈選與計算痕跡已全部清除"),
    ("noAnswerOrSolutionLeak", "沒有答案或詳解洩漏"),
    ("fullQuestionAndOptions", "完整題幹與全部選項均可見"),
    ("figuresAndGreyLinesIntact", "必要圖形、座標軸、灰階與細線完整"),
    ("chineseTextIntact", "中文沒有缺字、錯位或繁簡替換"),
    ("mathSymbolsAndFormulasIntact", "負號、不等號、根號、上下標、矩陣與公式完整"),
]
SAFE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z")


def card(row: dict[str, Any]) -> str:
    qid = html.escape(row["id"])
    checks = "".join(
        f'<label><input type="checkbox" data-check="{key}"> {html.escape(label)}</label>'
        for key, label in CHECKS
    )
    warning = ""
    if row["changedFraction"] >= 0.03:
        warning = '<p class="warning">自動警示：移除墨跡面積偏大，請特別核對印刷線條。</p>'
    return f'''<article data-id="{qid}">
      <header><b>{qid}</b><span>{html.escape(row['bookId'])} · PDF {row['pdfPage']} · {html.escape(row['cleanupMode'])}</span></header>
      <p>紅圖只標出疑似被移除的墨跡；不得用紅圖取代原圖與清理圖的逐像素對照。移除候選 {100 * row['changedFraction']:.3f}%</p>{warning}
      <div class="images">
        <figure><figcaption>原始題面</figcaption><img src="{html.escape(row['sourceUri'])}" loading="lazy"></figure>
        <figure><figcaption>去筆跡候選</figcaption><img src="{html.escape(row['cleanedUri'])}" loading="lazy"></figure>
        <figure><figcaption>疑似移除區（紅）</figcaption><img src="{html.escape(row['overlayUri'])}" loading="lazy"></figure>
      </div>
      <fieldset><legend>人工像素 QA</legend>
        <label class="decision"><input type="radio" name="decision-{qid}" value="pass"> 通過像素 QA</label>
        <label class="decision"><input type="radio" name="decision-{qid}" value="reject"> 隔離</label>
        {checks}<label class="notes">備註 <input type="text" data-notes></label>
      </fieldset>
    </article>'''


def common_style() -> str:
    return '''<style>
    :root{--paper:#f4f2ed;--card:#fff;--ink:#34312d;--muted:#756f66;--line:#d7d1c7;--accent:#647268;--danger:#8c4139}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.5 system-ui,"Microsoft JhengHei",sans-serif}
    nav{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 18px;background:#f4f2edf2;border-bottom:1px solid var(--line)}
    nav a{color:var(--ink)}nav input{padding:9px;min-width:240px}button{padding:10px 16px;border:0;border-radius:6px;background:var(--accent);color:white;font-weight:700}
    main{max-width:1800px;margin:auto;padding:18px}article{margin:0 0 24px;padding:18px;background:var(--card);border:1px solid var(--line);border-radius:10px}
    header{display:flex;justify-content:space-between;gap:12px}.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}figure{margin:0}figcaption{font-weight:700;margin-bottom:6px}
    img{display:block;width:100%;height:auto;background:white;border:1px solid var(--line)}fieldset{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:10px 16px;margin-top:14px;border:1px solid var(--line)}
    label{display:flex;gap:8px;align-items:center}label input[type=checkbox],label input[type=radio]{width:22px;height:22px}.decision{font-weight:700}.notes{grid-column:1/-1}.notes input{flex:1;padding:8px}.warning{color:var(--danger);font-weight:700}
    .pages{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px}.pages a{padding:10px;background:white;border:1px solid var(--line);border-radius:6px;text-align:center;text-decoration:none}.muted{color:var(--muted)}
    @media(max-width:1000px){.images{grid-template-columns:1fr}nav{position:static}}
    </style>'''


def storage_script(manifest_hash: str, page_rows: list[dict[str, Any]]) -> str:
    rows = json.dumps(
        [{"id": row["id"], "sourceSha256": row["sourceSha256"],
          "cleanedSha256": row["cleanedSha256"],
          "removedOverlaySha256": row["removedOverlaySha256"]} for row in page_rows],
        ensure_ascii=False,
    ).replace("</", "<\\/")
    checks = json.dumps([key for key, _ in CHECKS])
    return f'''<script>'use strict';
    const manifestHash={json.dumps(manifest_hash)};const rows={rows};const checks={checks};
    const key=id=>`matha-clean-review:${{manifestHash}}:${{id}}`;
    for(const row of rows){{const card=document.querySelector(`article[data-id="${{CSS.escape(row.id)}}"]`);const saved=JSON.parse(localStorage.getItem(key(row.id))||'null');
      if(saved){{const radio=card.querySelector(`input[type=radio][value="${{saved.decision}}"]`);if(radio)radio.checked=true;for(const name of checks){{const box=card.querySelector(`[data-check="${{name}}"]`);box.checked=!!saved.visual?.[name]}}card.querySelector('[data-notes]').value=saved.notes||''}}
      card.addEventListener('change',()=>{{const decision=card.querySelector('input[type=radio]:checked')?.value||'';const visual=Object.fromEntries(checks.map(name=>[name,!!card.querySelector(`[data-check="${{name}}"]`).checked]));localStorage.setItem(key(row.id),JSON.stringify({{...row,decision,visual,notes:card.querySelector('[data-notes]').value.trim()}}));update()}});
      card.querySelector('[data-notes]').addEventListener('input',()=>card.dispatchEvent(new Event('change')));
    }}
    function update(){{let done=0;for(const row of rows){{if(JSON.parse(localStorage.getItem(key(row.id))||'null')?.decision)done++}}document.getElementById('progress').textContent=`本頁 ${{done}}/${{rows.length}}`}}update();
    </script>'''


def page_document(manifest_hash: str, rows: list[dict[str, Any]], number: int,
                  page_count: int) -> str:
    previous = f"page-{number - 1:04d}.html" if number > 1 else "../review.html"
    following = f"page-{number + 1:04d}.html" if number < page_count else "../review.html"
    nav = (f'<nav><a href="../review.html">索引</a><a href="{previous}">上一頁</a>'
           f'<b>{number}/{page_count}</b><a href="{following}">下一頁</a><span id="progress"></span></nav>')
    return ("<!doctype html><html lang='zh-Hant'><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>去筆跡像素 QA {number}/{page_count}</title>{common_style()}</head><body>{nav}"
            f"<main>{''.join(card(row) for row in rows)}</main>"
            f"{storage_script(manifest_hash, rows)}</body></html>")


def index_document(manifest_hash: str, rows: list[dict[str, Any]], page_count: int,
                   page_size: int, template: dict[str, Any]) -> str:
    links = "".join(
        f'<a href="review-pages/page-{number:04d}.html">{number}</a>'
        for number in range(1, page_count + 1)
    )
    row_data = json.dumps(
        [{"id": row["id"], "sourceSha256": row["sourceSha256"],
          "cleanedSha256": row["cleanedSha256"],
          "removedOverlaySha256": row["removedOverlaySha256"]} for row in rows],
        ensure_ascii=False,
    ).replace("</", "<\\/")
    base = json.dumps(
        {key: value for key, value in template.items() if key != "questions"},
        ensure_ascii=False,
    ).replace("</", "<\\/")
    checks = json.dumps([key for key, _ in CHECKS])
    return f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>去筆跡像素 QA 索引</title>{common_style()}</head><body><nav><b>去筆跡像素 QA</b><label>審核者 <input id="reviewer" autocomplete="off"></label><button id="export">下載審核 JSON</button><span id="progress"></span></nav>
    <main><h1>{len(rows):,} 題發布前人工像素 QA</h1><p>每頁 {page_size} 題。必須逐題對照原圖、清理圖與紅色移除區。通過這一關仍不代表可發布；答案與數學正確性另行驗證。</p><p class="warning">請先在本資料夾執行 <code>python serve-review.py</code>，再開啟 <code>http://127.0.0.1:8765/review.html</code>。不要直接雙擊 HTML；<code>file://</code> 的跨頁儲存不可靠。</p><div class="pages">{links}</div></main>
    <script>'use strict';const manifestHash={json.dumps(manifest_hash)};const rows={row_data};const base={base};const checks={checks};const key=id=>`matha-clean-review:${{manifestHash}}:${{id}}`;const reviewerKey=`matha-clean-review:${{manifestHash}}:reviewer`;const reviewer=document.getElementById('reviewer');reviewer.value=localStorage.getItem(reviewerKey)||'';reviewer.addEventListener('input',()=>localStorage.setItem(reviewerKey,reviewer.value));
    function decisions(){{return rows.map(row=>JSON.parse(localStorage.getItem(key(row.id))||'null')).filter(Boolean)}}function update(){{const done=decisions().filter(row=>row.decision).length;document.getElementById('progress').textContent=`已決定 ${{done}}/${{rows.length}}`}}update();window.addEventListener('focus',update);
    document.getElementById('export').addEventListener('click',()=>{{const name=reviewer.value.trim();if(name.length<3){{alert('請填可辨識的真人審核者名稱');return}}const questions=[];let passed=0,rejected=0;for(const row of rows){{const saved=JSON.parse(localStorage.getItem(key(row.id))||'null');if(!saved?.decision){{alert(`尚未決定：${{row.id}}`);return}}if(saved.decision==='pass'&&!checks.every(name=>saved.visual?.[name]===true)){{alert(`通過題仍有未確認項目：${{row.id}}`);return}}saved.decision==='pass'?passed++:rejected++;questions.push(saved)}}const output={{...base,reviewer:name,reviewedAt:new Date().toISOString(),summary:{{passed,rejected,unreviewed:0}},questions}};const blob=new Blob([JSON.stringify(output,null,2)+'\n'],{{type:'application/json'}});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='cleaned-handwriting-human-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}});
    </script></body></html>'''


def prepare(manifest_file: Path, page_cleanup_manifest: Path,
            fallback_cleanup_manifest: Path, output: Path,
            page_size: int = 20) -> dict[str, Any]:
    manifest_file = ensure_outside_repo(manifest_file)
    output = ensure_outside_repo(output)
    if page_size < 1 or page_size > 100:
        raise ReviewPacketError("Page size must be between 1 and 100")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    items = manifest.get("items")
    if (manifest.get("kind") != "cleaned-page-question-candidates"
            or manifest.get("releaseAuthority") is not False
            or manifest.get("humanPixelReviewRequired") is not True
            or not isinstance(items, list) or not items):
        raise ReviewPacketError("Input is not a non-empty review-only cleaned candidate manifest")
    page_items = cleanup_items(
        page_cleanup_manifest, manifest.get("cleanupManifestSha256"), "full-page cleanup"
    )
    fallback_items = cleanup_items(
        fallback_cleanup_manifest,
        manifest.get("fallbackCleanupManifestSha256"),
        "question fallback cleanup",
    )
    if output.exists() and any(output.iterdir()):
        raise ReviewPacketError("Review output must be empty to prevent stale QA evidence")
    output.mkdir(parents=True, exist_ok=True)
    artifacts = output / "removed-overlays"
    assets = output / "assets"
    pages = output / "review-pages"
    artifacts.mkdir()
    assets.mkdir()
    pages.mkdir()
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for item in items:
        qid = item.get("id")
        if (not isinstance(qid, str) or not SAFE_ID_RE.fullmatch(qid)
                or qid in seen):
            raise ReviewPacketError("Candidate ids must be non-empty and unique")
        seen.add(qid)
        source = checked_artifact(item, "source", "sourceSha256")
        cleaned = checked_artifact(item, "cleaned", "cleanedSha256")
        with Image.open(source) as before, Image.open(cleaned) as after:
            if before.size != after.size:
                raise ReviewPacketError(f"{qid}: cleaned image geometry does not match source")
            source_size = before.size
        overlay, changed_fraction, evidence_source = canonical_overlay(
            item, source_size, page_items, fallback_items
        )
        overlay_path = artifacts / f"{qid}.png"
        overlay.save(overlay_path, format="PNG", optimize=True)
        source_asset = assets / qid / "source.png"
        cleaned_asset = assets / qid / "cleaned.png"
        materialize_asset(source, source_asset, item["sourceSha256"])
        materialize_asset(cleaned, cleaned_asset, item["cleanedSha256"])
        rows.append({
            "id": qid,
            "bookId": str(item.get("bookId") or ""),
            "pdfPage": item.get("pdfPage"),
            "cleanupMode": str(item.get("cleanupMode") or ""),
            "sourceSha256": item["sourceSha256"],
            "cleanedSha256": item["cleanedSha256"],
            "removedOverlaySha256": sha256(overlay_path),
            "changedFraction": changed_fraction,
            "evidenceSource": evidence_source,
            "sourceUri": f"../assets/{qid}/source.png",
            "cleanedUri": f"../assets/{qid}/cleaned.png",
            "overlayUri": f"../removed-overlays/{qid}.png",
        })
        overlay.close()
    manifest_hash = sha256(manifest_file)
    template = review_template(
        manifest_hash, str(manifest.get("cleanupManifestSha256")),
        str(manifest.get("fallbackCleanupManifestSha256")), rows,
    )
    (output / "cleaned-handwriting-human-review.template.json").write_text(
        json.dumps(template, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    page_count = (len(rows) + page_size - 1) // page_size
    for offset in range(0, len(rows), page_size):
        number = offset // page_size + 1
        (pages / f"page-{number:04d}.html").write_text(
            page_document(manifest_hash, rows[offset:offset + page_size], number, page_count),
            encoding="utf-8",
        )
    (output / "review.html").write_text(
        index_document(manifest_hash, rows, page_count, page_size, template),
        encoding="utf-8",
    )
    (output / "serve-review.py").write_text(
        """#!/usr/bin/env python3
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser(description=\"Serve the offline MathA pixel review packet\")
parser.add_argument(\"--port\", type=int, default=8765)
args = parser.parse_args()
root = Path(__file__).resolve().parent
handler = partial(SimpleHTTPRequestHandler, directory=str(root))
server = ThreadingHTTPServer((\"127.0.0.1\", args.port), handler)
print(f\"Pixel review: http://127.0.0.1:{args.port}/review.html\", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
""",
        encoding="utf-8",
    )
    packet = {
        "kind": "cleaned-handwriting-review-packet",
        "version": 1,
        "releaseAuthority": False,
        "candidateManifest": str(manifest_file),
        "candidateManifestSha256": manifest_hash,
        "pageCleanupManifestSha256": manifest.get("cleanupManifestSha256"),
        "fallbackCleanupManifestSha256": manifest.get("fallbackCleanupManifestSha256"),
        "questions": len(rows),
        "pages": page_count,
        "pageSize": page_size,
        "review": str((output / "review.html").resolve()),
        "serveCommand": "python serve-review.py",
        "localUrl": "http://127.0.0.1:8765/review.html",
        "template": str((output / "cleaned-handwriting-human-review.template.json").resolve()),
    }
    (output / "review-packet.json").write_text(
        json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return packet


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--page-cleanup-manifest", type=Path, required=True)
    parser.add_argument("--fallback-cleanup-manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--page-size", type=int, default=20)
    args = parser.parse_args(argv)
    try:
        result = prepare(
            args.manifest, args.page_cleanup_manifest,
            args.fallback_cleanup_manifest, args.out, args.page_size,
        )
    except (ReviewPacketError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"prepare-cleaned-handwriting-review: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
