#!/usr/bin/env python3
"""Build one-question-at-a-time UI for both starter-bank human QA gates.

The combined UI does not merge or weaken the gates.  It exports the exact
pixel-review and answer-review JSON formats consumed by the existing
fail-closed intersection validator, while avoiding two separate review passes.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[2]
VALIDATOR_PATH = Path(__file__).with_name("validate-starter-review-packets.py")
SPEC = importlib.util.spec_from_file_location("starter_packet_validator", VALIDATOR_PATH)
validator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(validator)


class CombinedReviewError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CombinedReviewError(f"cannot read {path}: {error}") from error
    if not isinstance(value, dict):
        raise CombinedReviewError(f"expected JSON object: {path}")
    return value


def relative_url(source: Path, output: Path) -> str:
    return quote(Path(os.path.relpath(source, output)).as_posix(), safe="/._-")


def safe_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def page_html(rows: list[dict[str, Any]], pixel_base: dict[str, Any],
              answer_base: dict[str, Any], packet_hash: str) -> str:
    pixel_checks = list(rows[0]["pixel"]["visual"])
    answer_checks = list(rows[0]["answer"]["visual"])
    labels = {
        "printedContentIntact": "印刷題目沒有被刪改",
        "allHandwritingRemoved": "手寫筆跡已全部清除",
        "noAnswerOrSolutionLeak": "題面沒有答案或詳解洩漏",
        "fullQuestionAndOptions": "題幹、選項與所有小題完整",
        "figuresAndGreyLinesIntact": "圖形、表格與灰線完整",
        "chineseTextIntact": "中文字完整可讀",
        "mathSymbolsAndFormulasIntact": "公式、負號與數學符號完整",
        "questionAnswerIdentityVerified": "答案確實屬於本題",
        "allSubpartsCovered": "答案涵蓋所有小題",
        "answerLegible": "官方答案像素清晰可讀",
        "noAdjacentAnswerConfusion": "沒有誤綁相鄰題答案",
        "figureConditionsHandled": "有圖條件與答案互相一致",
        "mathematicallyCorrect": "已獨立確認數學答案正確",
    }
    style = """
<style>
:root{color-scheme:light;--bg:#f3f1eb;--paper:#fffefa;--ink:#393a36;--muted:#74766e;--line:#d9d5ca;--accent:#6d7464;--bad:#9a625c;--good:#61725e}*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,"Noto Sans TC",sans-serif}button,input,textarea{font:inherit}header{position:sticky;top:0;z-index:5;display:flex;gap:12px;align-items:center;padding:10px 16px;background:rgba(255,254,250,.96);border-bottom:1px solid var(--line)}header b{font-size:18px}header label{margin-left:auto;display:flex;gap:8px;align-items:center;color:var(--muted)}input{min-height:46px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:white}.progress{font-variant-numeric:tabular-nums;color:var(--muted)}main{max-width:1500px;margin:auto;padding:16px}.meta{display:flex;gap:16px;align-items:baseline;margin-bottom:12px}.meta h1{font-size:24px;margin:0}.meta span{color:var(--muted)}.compare{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.answer-compare{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:12px}.panel{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:10px;min-width:0}.panel h2{font-size:15px;margin:0 0 8px;color:var(--muted)}.image-button{display:block;width:100%;border:0;padding:0;background:white;cursor:zoom-in;touch-action:pan-x pan-y pinch-zoom}.image-button img{display:block;width:100%;height:auto}.checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin:14px 0}.checks label{display:flex;gap:8px;align-items:flex-start;min-height:38px;padding:6px;border-radius:7px}.checks input{min-height:auto;width:22px;height:22px;flex:0 0 auto}textarea{width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;padding:9px;background:white}.actions,.nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.actions button,.nav button,.export{min-height:50px;border:1px solid var(--line);border-radius:8px;padding:10px 16px;background:white;color:var(--ink)}.actions .pass{background:var(--good);color:white;border-color:var(--good)}.actions .reject{color:var(--bad);border-color:#c9aaa6}.nav{justify-content:space-between}.decision{margin-top:10px;font-weight:650}.decision[data-kind=pass]{color:var(--good)}.decision[data-kind=reject]{color:var(--bad)}.exports{display:flex;gap:8px}.zoom{position:fixed;inset:0;z-index:20;background:rgba(34,35,32,.92);display:none;align-items:center;justify-content:center;padding:12px}.zoom.open{display:flex}.zoom img{max-width:100%;max-height:100%;object-fit:contain;touch-action:pan-x pan-y pinch-zoom}.zoom button{position:absolute;right:16px;top:16px;min-width:52px;min-height:52px;border:0;border-radius:50%;background:var(--paper)}
@media(max-width:900px){.compare,.answer-compare{grid-template-columns:1fr}.checks{grid-template-columns:1fr}header{flex-wrap:wrap}header label{margin-left:0}.exports{width:100%}}
</style>"""
    return f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=6,user-scalable=yes"><title>Starter 雙關卡複核</title>{style}</head><body>
<header><b>Starter 雙關卡複核</b><span class="progress" id="progress"></span><label>審核者 <input id="reviewer" autocomplete="name" placeholder="可辨識的真人姓名"></label><div class="exports"><button class="export" id="backupCheckpoint">備份目前進度</button><button class="export" id="restoreCheckpoint">恢復進度</button><input id="checkpointFile" type="file" accept=".json,application/json" hidden><button class="export" id="exportPixel">下載去筆跡審核</button><button class="export" id="exportAnswer">下載答案審核</button></div></header>
<main><div class="meta"><h1 id="title"></h1><span id="source"></span></div><section class="compare" id="pixelPanels"></section><section class="checks" id="pixelChecks"></section><textarea id="pixelNotes" placeholder="去筆跡退件時，寫明缺字、殘留筆跡或圖形受損位置"></textarea><div class="decision" id="pixelDecision"></div>
<section class="compare answer-compare" id="answerPanels"></section><section class="checks" id="answerChecks"></section><textarea id="answerNotes" placeholder="答案退件時，寫明錯綁、漏小題或數學疑點"></textarea><div class="decision" id="answerDecision"></div>
<div class="actions"><button class="pass" id="passBoth">兩關都通過並到下一題</button><button class="reject" id="rejectPixel">去筆跡退件</button><button class="reject" id="rejectAnswer">答案退件</button><button class="reject" id="rejectBoth">兩關都退件</button></div><div class="nav"><button id="prev">上一題</button><button id="next">下一題</button></div></main>
<div class="zoom" id="zoom"><button aria-label="關閉放大圖">關閉</button><img alt="放大檢視"></div>
<script>'use strict';const rows={safe_json(rows)},pixelBase={safe_json(pixel_base)},answerBase={safe_json(answer_base)},labels={safe_json(labels)},pixelChecks={safe_json(pixel_checks)},answerChecks={safe_json(answer_checks)},packetHash={safe_json(packet_hash)};let index=0;const key=id=>`matha-combined-review:${{packetHash}}:${{id}}`;const reviewerKey=`matha-combined-review:${{packetHash}}:reviewer`;const byId=id=>document.getElementById(id);const reviewer=byId('reviewer');reviewer.value=localStorage.getItem(reviewerKey)||'';reviewer.oninput=()=>localStorage.setItem(reviewerKey,reviewer.value);function state(row){{return JSON.parse(localStorage.getItem(key(row.id))||'null')||{{pixelDecision:'',answerDecision:'',pixelVisual:Object.fromEntries(pixelChecks.map(x=>[x,false])),answerVisual:Object.fromEntries(answerChecks.map(x=>[x,false])),pixelNotes:'',answerNotes:''}}}}function save(row,value){{localStorage.setItem(key(row.id),JSON.stringify(value));render()}}function panels(target,items){{byId(target).innerHTML=items.map(x=>`<article class="panel"><h2>${{x.label}}</h2><button class="image-button" data-src="${{x.src}}"><img src="${{x.src}}" alt="${{x.label}}" loading="eager"></button></article>`).join('');document.querySelectorAll('.image-button').forEach(btn=>btn.onclick=()=>zoom(btn.dataset.src))}}function checks(target,names,values,prefix){{byId(target).innerHTML=names.map(name=>`<label><input type="checkbox" data-check="${{prefix}}:${{name}}" ${{values[name]?'checked':''}}><span>${{labels[name]||name}}</span></label>`).join('');document.querySelectorAll(`[data-check^="${{prefix}}:"]`).forEach(input=>input.onchange=()=>{{const row=rows[index],s=state(row),name=input.dataset.check.split(':')[1];s[prefix+'Visual'][name]=input.checked;save(row,s)}})}}function progress(){{let p=0,a=0;for(const row of rows){{const s=state(row);if(s.pixelDecision)p++;if(s.answerDecision)a++}}byId('progress').textContent=`第 ${{index+1}}/${{rows.length}} 題｜去筆跡 ${{p}}/${{rows.length}}｜答案 ${{a}}/${{rows.length}}`}}function decision(target,value){{const el=byId(target);el.dataset.kind=value||'';el.textContent=value==='pass'?'本關已通過':value==='reject'?'本關已退件':'本關尚未決定'}}function render(){{const row=rows[index],s=state(row);byId('title').textContent=`第 ${{index+1}} 題｜${{row.id}}`;byId('source').textContent=`${{row.bookId}}｜PDF 第 ${{row.pdfPage}} 頁｜${{row.role||''}}`;panels('pixelPanels',[{{label:'原始題面',src:row.source}},{{label:'去筆跡題面',src:row.cleaned}},{{label:'移除區標紅',src:row.overlay}}]);panels('answerPanels',[{{label:'去筆跡題面',src:row.answerQuestion}},{{label:'原書官方答案',src:row.officialAnswer}}]);checks('pixelChecks',pixelChecks,s.pixelVisual,'pixel');checks('answerChecks',answerChecks,s.answerVisual,'answer');byId('pixelNotes').value=s.pixelNotes;byId('answerNotes').value=s.answerNotes;decision('pixelDecision',s.pixelDecision);decision('answerDecision',s.answerDecision);byId('prev').disabled=index===0;byId('next').disabled=index===rows.length-1;progress()}}function mark(kind,value,allSafe=false){{const row=rows[index],s=state(row);s[kind+'Decision']=value;if(allSafe)for(const name of kind==='pixel'?pixelChecks:answerChecks)s[kind+'Visual'][name]=true;s[kind+'Notes']=byId(kind+'Notes').value.trim();save(row,s)}}byId('pixelNotes').onchange=()=>mark('pixel',state(rows[index]).pixelDecision);byId('answerNotes').onchange=()=>mark('answer',state(rows[index]).answerDecision);byId('passBoth').onclick=()=>{{mark('pixel','pass',true);mark('answer','pass',true);if(index<rows.length-1){{index++;render()}}}};byId('rejectPixel').onclick=()=>mark('pixel','reject');byId('rejectAnswer').onclick=()=>mark('answer','reject');byId('rejectBoth').onclick=()=>{{mark('pixel','reject');mark('answer','reject')}};byId('prev').onclick=()=>{{if(index>0){{index--;render()}}}};byId('next').onclick=()=>{{if(index<rows.length-1){{index++;render()}}}};function exportReview(kind){{const name=reviewer.value.trim();if(name.length<3){{alert('請填可辨識的真人姓名');return}}const checks=kind==='pixel'?pixelChecks:answerChecks,questions=[];let passed=0,rejected=0;for(const row of rows){{const s=state(row),decision=s[kind+'Decision'],visual=s[kind+'Visual'];if(!decision){{alert(`尚未決定：${{row.id}}`);return}}if(decision==='pass'&&!checks.every(x=>visual[x]===true)){{alert(`通過題仍有未確認項目：${{row.id}}`);return}}decision==='pass'?passed++:rejected++;questions.push({{...(kind==='pixel'?row.pixel:row.answer),decision,visual,notes:s[kind+'Notes']||''}})}}const base=kind==='pixel'?pixelBase:answerBase;const output={{...base,reviewer:name,reviewedAt:new Date().toISOString(),summary:{{passed,rejected,unreviewed:0}},questions}};const blob=new Blob([JSON.stringify(output,null,2)+'\\n'],{{type:'application/json'}}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=kind==='pixel'?'cleaned-handwriting-human-review.json':'cleaned-answer-human-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}}byId('exportPixel').onclick=()=>exportReview('pixel');byId('exportAnswer').onclick=()=>exportReview('answer');const zoomBox=byId('zoom');function zoom(src){{zoomBox.querySelector('img').src=src;zoomBox.classList.add('open')}}zoomBox.querySelector('button').onclick=()=>zoomBox.classList.remove('open');zoomBox.onclick=e=>{{if(e.target===zoomBox)zoomBox.classList.remove('open')}};render();</script></body></html>'''


def page_html_v2(rows: list[dict[str, Any]], pixel_base: dict[str, Any],
                 answer_base: dict[str, Any], packet_hash: str) -> str:
    """Render the review UI with mandatory human answer transcription.

    The original page renderer is intentionally left readable above as the
    v1 format reference.  V2 adds the missing release-boundary field: a human
    must convert the official answer pixels into the minimal structure the app
    can grade.  The image remains the source of truth; no OCR is trusted here.
    """
    pixel_checks = list(rows[0]["pixel"]["visual"])
    answer_checks = list(rows[0]["answer"]["visual"])
    labels = {
        "printedContentIntact": "印刷題目沒有被刪改",
        "allHandwritingRemoved": "手寫筆跡已全部清除",
        "noAnswerOrSolutionLeak": "題面沒有答案或詳解洩漏",
        "fullQuestionAndOptions": "題幹、選項與所有小題完整",
        "figuresAndGreyLinesIntact": "圖形、表格與灰線完整",
        "chineseTextIntact": "中文字完整可讀",
        "mathSymbolsAndFormulasIntact": "公式、負號與數學符號完整",
        "questionAnswerIdentityVerified": "答案確實屬於本題",
        "allSubpartsCovered": "答案涵蓋所有小題",
        "answerLegible": "官方答案像素清晰可讀",
        "noAdjacentAnswerConfusion": "沒有誤綁相鄰題答案",
        "figureConditionsHandled": "有圖條件與答案互相一致",
        "mathematicallyCorrect": "已獨立確認數學答案正確",
    }
    style = """<style>
:root{color-scheme:light;--bg:#f3f1eb;--paper:#fffefa;--ink:#393a36;--muted:#74766e;--line:#d9d5ca;--bad:#9a625c;--good:#61725e}*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,"Noto Sans TC",sans-serif}button,input,textarea,select{font:inherit}header{position:sticky;top:0;z-index:5;display:flex;gap:12px;align-items:center;padding:10px 16px;background:rgba(255,254,250,.96);border-bottom:1px solid var(--line)}header b{font-size:18px}header label{margin-left:auto;display:flex;gap:8px;align-items:center;color:var(--muted)}input,select{min-height:46px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:white}.progress{font-variant-numeric:tabular-nums;color:var(--muted)}main{max-width:1500px;margin:auto;padding:16px}.meta{display:flex;gap:16px;align-items:baseline;margin-bottom:12px}.meta h1{font-size:24px;margin:0}.meta span{color:var(--muted)}.compare{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.answer-compare{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:12px}.panel{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:10px;min-width:0}.panel h2{font-size:15px;margin:0 0 8px;color:var(--muted)}.image-button{display:block;width:100%;border:0;padding:0;background:white;cursor:zoom-in;touch-action:pan-x pan-y pinch-zoom}.image-button img{display:block;width:100%;height:auto}.answer-entry{display:grid;grid-template-columns:180px 150px minmax(220px,1fr);gap:10px;margin:14px 0;padding:12px;background:var(--paper);border:1px solid var(--line);border-radius:10px}.answer-entry label{display:flex;flex-direction:column;gap:5px;color:var(--muted)}.answer-entry .wide,.answer-entry p{grid-column:1/-1}.answer-entry p{margin:0;color:var(--muted)}.checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px;margin:14px 0}.checks label{display:flex;gap:8px;align-items:flex-start;min-height:38px;padding:6px;border-radius:7px}.checks input{min-height:auto;width:22px;height:22px;flex:0 0 auto}textarea{width:100%;min-height:70px;border:1px solid var(--line);border-radius:8px;padding:9px;background:white}.actions,.nav{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}.actions button,.nav button,.export{min-height:50px;border:1px solid var(--line);border-radius:8px;padding:10px 16px;background:white;color:var(--ink)}.actions .pass{background:var(--good);color:white;border-color:var(--good)}.actions .reject{color:var(--bad);border-color:#c9aaa6}.nav{justify-content:space-between}.decision{margin-top:10px;font-weight:650}.decision[data-kind=pass]{color:var(--good)}.decision[data-kind=reject]{color:var(--bad)}.exports{display:flex;gap:8px}.zoom{position:fixed;inset:0;z-index:20;background:rgba(34,35,32,.92);display:none;align-items:center;justify-content:center;padding:12px}.zoom.open{display:flex}.zoom img{max-width:100%;max-height:100%;object-fit:contain;touch-action:pan-x pan-y pinch-zoom}.zoom button{position:absolute;right:16px;top:16px;min-width:52px;min-height:52px;border:0;border-radius:50%;background:var(--paper)}
@media(max-width:900px){.compare,.answer-compare,.answer-entry{grid-template-columns:1fr}.answer-entry .wide,.answer-entry p{grid-column:auto}.checks{grid-template-columns:1fr}header{flex-wrap:wrap}header label{margin-left:0}.exports{width:100%}}
</style>"""
    body = f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=6,user-scalable=yes"><title>Starter 雙關卡複核</title>{style}</head><body>
<header><b>Starter 雙關卡複核</b><span class="progress" id="progress"></span><label>審核者 <input id="reviewer" autocomplete="name" placeholder="可辨識的真人姓名"></label><div class="exports"><button class="export" id="exportPixel">下載去筆跡審核</button><button class="export" id="exportAnswer">下載答案審核</button></div></header>
<main><div class="meta"><h1 id="title"></h1><span id="source"></span></div><section class="compare" id="pixelPanels"></section><section class="checks" id="pixelChecks"></section><textarea id="pixelNotes" placeholder="去筆跡退件時，寫明缺字、殘留筆跡或圖形受損位置"></textarea><div class="decision" id="pixelDecision"></div>
<section class="compare answer-compare" id="answerPanels"></section><section class="answer-entry"><label>App 作答型態<select id="answerMode"><option value="single">單選</option><option value="multi">多選</option><option value="text">非選／計算／證明</option></select></label><label id="optionCountWrap">選項總數<input id="optionCount" inputmode="numeric" placeholder="例如 5"></label><label id="correctOptionsWrap">正確選項編號<input id="correctOptions" inputmode="numeric" placeholder="單選 2；多選 1,3,5"></label><label class="wide" id="officialTextWrap">正式答案文字<textarea id="officialText" placeholder="照官方答案輸入最終答案與所有小題；不要自行補詳解"></textarea></label><p>這不是 OCR。通過答案關卡前，必須由正在看官方答案裁圖的真人輸入 App 可判分的答案；否則題目會在發布時被拒絕。</p></section><section class="checks" id="answerChecks"></section><textarea id="answerNotes" placeholder="答案退件時，寫明錯綁、漏小題或數學疑點"></textarea><div class="decision" id="answerDecision"></div>
<div class="actions"><button class="pass" id="passBoth">兩關都通過並到下一題</button><button class="reject" id="rejectPixel">去筆跡退件</button><button class="reject" id="rejectAnswer">答案退件</button><button class="reject" id="rejectBoth">兩關都退件</button></div><div class="nav"><button id="prev">上一題</button><button id="next">下一題</button></div></main>
<div class="zoom" id="zoom"><button aria-label="關閉放大圖">關閉</button><img alt="放大檢視"></div>
<script>'use strict';
const rows={safe_json(rows)},pixelBase={safe_json(pixel_base)},answerBase={safe_json(answer_base)},labels={safe_json(labels)},pixelChecks={safe_json(pixel_checks)},answerChecks={safe_json(answer_checks)},packetHash={safe_json(packet_hash)};
let index=0;const key=id=>`matha-combined-review:${{packetHash}}:${{id}}`,reviewerKey=`matha-combined-review:${{packetHash}}:reviewer`,byId=id=>document.getElementById(id),reviewer=byId('reviewer');
reviewer.value=localStorage.getItem(reviewerKey)||'';reviewer.oninput=()=>localStorage.setItem(reviewerKey,reviewer.value);
function defaultState(row){{return {{pixelDecision:'',answerDecision:'',pixelVisual:Object.fromEntries(pixelChecks.map(x=>[x,false])),answerVisual:Object.fromEntries(answerChecks.map(x=>[x,false])),pixelNotes:'',answerNotes:'',answerMode:row.answerDefault.mode,optionCount:'',correctOptions:'',officialAnswerText:''}}}}
function shortText(value,max=4000){{return typeof value==='string'?value.slice(0,max):''}}
function sanitizeState(row,value){{const base=defaultState(row),source=value&&typeof value==='object'&&!Array.isArray(value)?value:{{}},decision=value=>['pass','reject'].includes(value)?value:'';base.pixelDecision=decision(source.pixelDecision);base.answerDecision=decision(source.answerDecision);for(const name of pixelChecks)base.pixelVisual[name]=source.pixelVisual?.[name]===true;for(const name of answerChecks)base.answerVisual[name]=source.answerVisual?.[name]===true;base.pixelNotes=shortText(source.pixelNotes);base.answerNotes=shortText(source.answerNotes);base.answerMode=['single','multi','text'].includes(source.answerMode)?source.answerMode:row.answerDefault.mode;base.optionCount=shortText(source.optionCount,8);base.correctOptions=shortText(source.correctOptions,80);base.officialAnswerText=shortText(source.officialAnswerText);return base}}
function state(row){{try{{return sanitizeState(row,JSON.parse(localStorage.getItem(key(row.id))||'null'))}}catch(_error){{return defaultState(row)}}}}
function save(row,value,rerender=true){{localStorage.setItem(key(row.id),JSON.stringify(value));if(rerender)render()}}
function downloadJson(name,value){{const blob=new Blob([JSON.stringify(value,null,2)+'\\n'],{{type:'application/json'}}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}}
function backupCheckpoint(){{downloadJson(`starter-review-checkpoint-${{packetHash.slice(0,12)}}.json`,{{kind:'starter-combined-review-checkpoint',version:1,packetSha256:packetHash,savedAt:new Date().toISOString(),reviewer:reviewer.value.trim(),states:rows.map(row=>({{id:row.id,state:state(row)}}))}})}}
async function importCheckpoint(file){{let value;try{{value=JSON.parse(await file.text())}}catch(_error){{alert('進度檔不是有效 JSON');return}}if(value?.kind!=='starter-combined-review-checkpoint'||value?.version!==1||value?.packetSha256!==packetHash||!Array.isArray(value.states)){{alert('進度檔不屬於這一批或版本不相符');return}}const known=new Map(rows.map(row=>[row.id,row])),seen=new Set();for(const item of value.states){{if(!item||typeof item.id!=='string'||!known.has(item.id)||seen.has(item.id)){{alert('進度檔含未知或重複題號，已拒絕匯入');return}}seen.add(item.id)}}if(seen.size!==rows.length){{alert('進度檔題數不完整，已拒絕匯入');return}}for(const item of value.states)localStorage.setItem(key(item.id),JSON.stringify(sanitizeState(known.get(item.id),item.state)));if(typeof value.reviewer==='string'&&value.reviewer.trim()){{reviewer.value=value.reviewer.trim().slice(0,120);localStorage.setItem(reviewerKey,reviewer.value)}}render();alert('進度已恢復，請抽查目前題目後繼續')}}
function panels(target,items){{byId(target).innerHTML=items.map(x=>`<article class="panel"><h2>${{x.label}}</h2><button class="image-button" data-src="${{x.src}}"><img src="${{x.src}}" alt="${{x.label}}" loading="eager"></button></article>`).join('');document.querySelectorAll('.image-button').forEach(btn=>btn.onclick=()=>zoom(btn.dataset.src))}}
function checks(target,names,values,prefix){{byId(target).innerHTML=names.map(name=>`<label><input type="checkbox" data-check="${{prefix}}:${{name}}" ${{values[name]?'checked':''}}><span>${{labels[name]||name}}</span></label>`).join('');document.querySelectorAll(`[data-check^="${{prefix}}:"]`).forEach(input=>input.onchange=()=>{{const row=rows[index],s=state(row),name=input.dataset.check.split(':')[1];s[prefix+'Visual'][name]=input.checked;save(row,s)}})}}
function progress(){{let p=0,a=0;for(const row of rows){{const s=state(row);if(s.pixelDecision)p++;if(s.answerDecision)a++}}byId('progress').textContent=`第 ${{index+1}}/${{rows.length}} 題｜去筆跡 ${{p}}/${{rows.length}}｜答案 ${{a}}/${{rows.length}}`}}
function decision(target,value){{const el=byId(target);el.dataset.kind=value||'';el.textContent=value==='pass'?'本關已通過':value==='reject'?'本關已退件':'本關尚未決定'}}
function parseOptions(value){{return [...new Set(String(value||'').split(/[^0-9]+/).filter(Boolean).map(Number))]}}
function structuredAnswer(row,s,showError=false){{const mode=s.answerMode,count=Number(s.optionCount),numbers=parseOptions(s.correctOptions),text=String(s.officialAnswerText||'').trim();let error='';if(!['single','multi','text'].includes(mode))error='請選 App 作答型態';else if(mode==='text'&&!text)error='請照官方答案輸入正式答案文字';else if(mode!=='text'&&(!Number.isInteger(count)||count<2||count>12))error='請填 2 到 12 的選項總數';else if(mode==='single'&&numbers.length!==1)error='單選題必須填一個正確選項編號';else if(mode==='multi'&&!numbers.length)error='多選題至少填一個正確選項編號';else if(mode!=='text'&&numbers.some(n=>n<1||n>count))error='正確選項編號超出選項總數';if(error){{if(showError)alert(`${{row.id}}：${{error}}`);return null}}return mode==='text'?{{schema:1,mode,officialAnswerText:text}}:{{schema:1,mode,optionCount:count,correctOptionNumbers:numbers}}}}
function render(){{const row=rows[index],s=state(row);byId('title').textContent=`第 ${{index+1}} 題｜${{row.id}}`;byId('source').textContent=`${{row.bookId}}｜PDF 第 ${{row.pdfPage}} 頁｜${{row.role||''}}｜原分類 ${{row.questionType||'未分類'}}`;panels('pixelPanels',[{{label:'原始題面',src:row.source}},{{label:'去筆跡題面',src:row.cleaned}},{{label:'移除區標紅',src:row.overlay}}]);panels('answerPanels',[{{label:'去筆跡題面',src:row.answerQuestion}},{{label:'原書官方答案',src:row.officialAnswer}}]);checks('pixelChecks',pixelChecks,s.pixelVisual,'pixel');checks('answerChecks',answerChecks,s.answerVisual,'answer');byId('answerMode').value=s.answerMode;byId('optionCount').value=s.optionCount;byId('correctOptions').value=s.correctOptions;byId('officialText').value=s.officialAnswerText;const textMode=s.answerMode==='text';byId('optionCountWrap').hidden=textMode;byId('correctOptionsWrap').hidden=textMode;byId('officialTextWrap').hidden=!textMode;byId('pixelNotes').value=s.pixelNotes;byId('answerNotes').value=s.answerNotes;decision('pixelDecision',s.pixelDecision);decision('answerDecision',s.answerDecision);byId('prev').disabled=index===0;byId('next').disabled=index===rows.length-1;progress()}}
function readAnswerFields(row,s){{s.answerMode=byId('answerMode').value;s.optionCount=byId('optionCount').value.trim();s.correctOptions=byId('correctOptions').value.trim();s.officialAnswerText=byId('officialText').value.trim();save(row,s,false)}}
for(const id of ['answerMode','optionCount','correctOptions','officialText'])byId(id).onchange=()=>{{const row=rows[index],s=state(row);readAnswerFields(row,s);render()}};
function mark(kind,value,allSafe=false){{const row=rows[index],s=state(row);readAnswerFields(row,s);if(kind==='answer'&&value==='pass'&&!structuredAnswer(row,s,true))return false;s[kind+'Decision']=value;if(allSafe)for(const name of kind==='pixel'?pixelChecks:answerChecks)s[kind+'Visual'][name]=true;s[kind+'Notes']=byId(kind+'Notes').value.trim();save(row,s);return true}}
byId('pixelNotes').onchange=()=>mark('pixel',state(rows[index]).pixelDecision);byId('answerNotes').onchange=()=>mark('answer',state(rows[index]).answerDecision);byId('passBoth').onclick=()=>{{const row=rows[index],s=state(row);readAnswerFields(row,s);if(!structuredAnswer(row,s,true))return;mark('pixel','pass',true);if(!mark('answer','pass',true))return;if(index<rows.length-1){{index++;render()}}}};byId('rejectPixel').onclick=()=>mark('pixel','reject');byId('rejectAnswer').onclick=()=>mark('answer','reject');byId('rejectBoth').onclick=()=>{{mark('pixel','reject');mark('answer','reject')}};byId('prev').onclick=()=>{{if(index>0){{index--;render()}}}};byId('next').onclick=()=>{{if(index<rows.length-1){{index++;render()}}}};
function exportReview(kind){{const name=reviewer.value.trim();if(name.length<3){{alert('請填可辨識的真人姓名');return}}const required=kind==='pixel'?pixelChecks:answerChecks,questions=[];let passed=0,rejected=0;for(const row of rows){{const s=state(row),decision=s[kind+'Decision'],visual=s[kind+'Visual'];if(!decision){{alert(`尚未決定：${{row.id}}`);return}}if(decision==='pass'&&!required.every(x=>visual[x]===true)){{alert(`通過題仍有未確認項目：${{row.id}}`);return}}const normalized=kind==='answer'&&decision==='pass'?structuredAnswer(row,s,true):null;if(kind==='answer'&&decision==='pass'&&!normalized)return;decision==='pass'?passed++:rejected++;questions.push({{...(kind==='pixel'?row.pixel:row.answer),decision,visual,notes:s[kind+'Notes']||'',...(normalized?{{structuredAnswer:normalized}}:{{}})}})}}const base=kind==='pixel'?pixelBase:answerBase;const output={{...base,...(kind==='answer'?{{structuredAnswerRequired:true}}:{{}}),reviewer:name,reviewedAt:new Date().toISOString(),summary:{{passed,rejected,unreviewed:0}},questions}};downloadJson(kind==='pixel'?'cleaned-handwriting-human-review.json':'cleaned-answer-human-review.json',output)}}
byId('backupCheckpoint').onclick=backupCheckpoint;byId('restoreCheckpoint').onclick=()=>byId('checkpointFile').click();byId('checkpointFile').onchange=async event=>{{const file=event.target.files?.[0];event.target.value='';if(file)await importCheckpoint(file)}};byId('exportPixel').onclick=()=>exportReview('pixel');byId('exportAnswer').onclick=()=>exportReview('answer');const zoomBox=byId('zoom');function zoom(src){{zoomBox.querySelector('img').src=src;zoomBox.classList.add('open')}}zoomBox.querySelector('button').onclick=()=>zoomBox.classList.remove('open');zoomBox.onclick=e=>{{if(e.target===zoomBox)zoomBox.classList.remove('open')}};render();
</script></body></html>'''
    return body


def build(batch_manifest: Path, pixel_dir: Path, answer_dir: Path,
          output: Path, port: int) -> dict[str, Any]:
    for source in (batch_manifest, pixel_dir, answer_dir):
        if not source.exists():
            raise CombinedReviewError(f"missing input: {source}")
    resolved_output = output.resolve()
    try:
        resolved_output.relative_to(REPO_ROOT.resolve())
    except ValueError:
        pass
    else:
        raise CombinedReviewError("private review output must stay outside the Git repository")

    validator.validate_batch(batch_manifest, pixel_dir, answer_dir)
    batch = load_json(batch_manifest)
    pixel_template_path = pixel_dir / "cleaned-handwriting-human-review.template.json"
    answer_template_path = answer_dir / "cleaned-answer-human-review.template.json"
    binding_path = answer_dir / "answer-binding-candidates.json"
    pixel_template = load_json(pixel_template_path)
    answer_template = load_json(answer_template_path)
    bindings = load_json(binding_path)
    batch_by_id = {row["id"]: row for row in batch["items"]}
    pixel_by_id = {row["id"]: row for row in pixel_template["questions"]}
    answer_by_id = {row["id"]: row for row in answer_template["questions"]}
    binding_by_id = {row["id"]: row for row in bindings["items"]}

    output.mkdir(parents=True, exist_ok=False)
    rows = []
    for question_id, row in batch_by_id.items():
        binding = binding_by_id[question_id]
        rows.append({
            "id": question_id,
            "bookId": binding.get("bookId", row.get("bookId", "")),
            "pdfPage": binding.get("pdfPage", row.get("pdfPage", "")),
            "role": binding.get("role", ""),
            "questionType": binding.get("questionType", ""),
            "answerDefault": {
                "mode": (
                    "single" if binding.get("questionType") == "single"
                    else "multi" if binding.get("questionType") == "multi"
                    else "text"
                )
            },
            "source": relative_url(pixel_dir / "assets" / question_id / "source.png", output),
            "cleaned": relative_url(pixel_dir / "assets" / question_id / "cleaned.png", output),
            "overlay": relative_url(pixel_dir / "removed-overlays" / f"{question_id}.png", output),
            "answerQuestion": relative_url(answer_dir / "assets" / question_id / "question.png", output),
            "officialAnswer": relative_url(answer_dir / "assets" / question_id / "answer.png", output),
            "pixel": pixel_by_id[question_id],
            "answer": answer_by_id[question_id],
        })

    pixel_base = {key: value for key, value in pixel_template.items()
                  if key not in {"questions", "summary", "reviewer", "reviewedAt"}}
    answer_base = {key: value for key, value in answer_template.items()
                   if key not in {"questions", "summary", "reviewer", "reviewedAt"}}
    packet_identity = {
        "combinedReviewVersion": 2,
        "structuredAnswerRequired": True,
        "batchManifestSha256": sha256(batch_manifest),
        "pixelTemplateSha256": sha256(pixel_template_path),
        "answerTemplateSha256": sha256(answer_template_path),
        "answerBindingSha256": sha256(binding_path),
    }
    packet_hash = hashlib.sha256(
        json.dumps(packet_identity, sort_keys=True).encode("utf-8")).hexdigest()
    (output / "review.html").write_text(
        page_html_v2(rows, pixel_base, answer_base, packet_hash), encoding="utf-8")

    common_root = Path(os.path.commonpath([
        str(output.resolve()), str(pixel_dir.resolve()), str(answer_dir.resolve())
    ]))
    review_relative = output.resolve().relative_to(common_root).as_posix() + "/review.html"
    local_url = f"http://127.0.0.1:{port}/{quote(review_relative, safe='/._-')}"
    serve = f'''from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler\nfrom functools import partial\nROOT = {str(common_root)!r}\nPORT = {port}\nprint("Combined starter review: {local_url}", flush=True)\nThreadingHTTPServer(("127.0.0.1", PORT), partial(SimpleHTTPRequestHandler, directory=ROOT)).serve_forever()\n'''
    (output / "serve-review.py").write_text(serve, encoding="utf-8")
    packet = {
        "kind": "starter-combined-human-review-packet",
        "version": 2,
        "releaseAuthority": False,
        "questions": len(rows),
        **packet_identity,
        "packetSha256": packet_hash,
        "review": str((output / "review.html").resolve()),
        "serveCommand": "python serve-review.py",
        "localUrl": local_url,
        "exports": ["cleaned-handwriting-human-review.json", "cleaned-answer-human-review.json"],
        "structuredAnswerRequired": True,
    }
    (output / "review-packet.json").write_text(
        json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return packet


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-manifest", required=True, type=Path)
    parser.add_argument("--pixel-dir", required=True, type=Path)
    parser.add_argument("--answer-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8769)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise CombinedReviewError("port must be between 1024 and 65535")
    packet = build(args.batch_manifest.resolve(), args.pixel_dir.resolve(),
                   args.answer_dir.resolve(), args.out.resolve(), args.port)
    print(json.dumps(packet, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CombinedReviewError, validator.PacketValidationError) as error:
        print(f"prepare-starter-combined-review: {error}", file=sys.stderr)
        raise SystemExit(1)
