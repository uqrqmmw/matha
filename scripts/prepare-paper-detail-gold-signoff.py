#!/usr/bin/env python3
"""Prepare and finalize a named-human review of private paper-detail gold.

This tool never calls a model.  ``prepare`` creates a localhost review packet
that shows the student pixels, official solution pixels and proposed truth for
all seven cases.  ``finalize`` only promotes the exact unsigned gold after a
named human exported a complete hash-bound signoff.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
REQUIRED_NOS = [3, 4, 11, 12, 13, 14, 16]
CHECK_FIELDS = [
    "studentPixelsVerified", "solutionPixelsVerified", "truthModeVerified",
    "firstErrorEvidenceVerified", "goodWorkEvidenceVerified",
]
STATEMENT = (
    "I personally reviewed every bound student and official-solution image, "
    "and verified the proposed diagnosis or abstention truth for this exact gold hash."
)
NON_HUMAN = re.compile(r"(?:^|\b)(?:ai|bot|agent|codex|claude|chatgpt|openai)(?:\b|$)", re.I)


class DetailSignoffError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path, label: str) -> dict[str, Any]:
    if not path.is_file():
        raise DetailSignoffError(f"{label} does not exist: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DetailSignoffError(f"{label} is not valid JSON: {path}") from error
    if not isinstance(value, dict):
        raise DetailSignoffError(f"{label} must be a JSON object")
    return value


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return resolved
    raise DetailSignoffError(f"private review output must stay outside Git: {resolved}")


def named_human(value: Any) -> str:
    name = str(value or "").strip()
    if len(name) < 3 or NON_HUMAN.search(name):
        raise DetailSignoffError("reviewer must be an identifiable human")
    return name


def timestamp(value: Any) -> str:
    raw = str(value or "")
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise DetailSignoffError("approvedAt is invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise DetailSignoffError("approvedAt must include a timezone")
    return raw


def validate_unsigned_gold(path: Path) -> dict[str, Any]:
    gold = load_json(path, "unsigned detail gold")
    if (gold.get("schema") != 1 or gold.get("releaseAuthority") is not False
            or gold.get("visibility") != "private-local-only"):
        raise DetailSignoffError("gold must be an unsigned private-local-only draft")
    rows = gold.get("cases")
    if not isinstance(rows, list) or [int(row.get("no") or 0) for row in rows] != REQUIRED_NOS:
        raise DetailSignoffError("gold must contain the exact seven cases in order")
    for name, source in (gold.get("sources") or {}).items():
        source_path = Path(str((source or {}).get("path") or ""))
        if (not source_path.is_file()
                or sha256(source_path).upper() != str((source or {}).get("sha256") or "").upper()):
            raise DetailSignoffError(f"gold source is missing or changed: {name}")
    asset_root = Path(str(gold.get("assetRoot") or ""))
    if not asset_root.is_dir():
        raise DetailSignoffError("gold assetRoot does not exist")
    for row in rows:
        if row.get("expectedMode") not in {"diagnose", "abstain"}:
            raise DetailSignoffError(f"case {row.get('no')} has invalid expectedMode")
        if not row.get("officialAnswer") or not row.get("studentEvidence") or not row.get("solutionEvidence"):
            raise DetailSignoffError(f"case {row.get('no')} is missing bound evidence")
        if row.get("expectedMode") == "diagnose" and not row.get("firstErrorEvidenceAliases"):
            raise DetailSignoffError(f"case {row.get('no')} has no first-error truth")
        for asset in [row["studentEvidence"], *row["solutionEvidence"]]:
            asset_path = asset_root / str(asset.get("file") or "")
            if (not asset_path.is_file()
                    or sha256(asset_path).upper() != str(asset.get("sha256") or "").upper()):
                raise DetailSignoffError(f"case {row.get('no')} evidence is missing or changed")
    return gold


def write_server(output: Path) -> None:
    source = """from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
print('http://127.0.0.1:8775/review.html', flush=True)
ThreadingHTTPServer(('127.0.0.1', 8775), SimpleHTTPRequestHandler).serve_forever()
"""
    (output / "serve-review.py").write_text(source, encoding="utf-8")


def render_html(packet: dict[str, Any]) -> str:
    cards = []
    for row in packet["cases"]:
        solutions = "".join(
            f'<figure><figcaption>官方詳解 {index}</figcaption><img src="{escape(path)}" alt="第 {row["no"]} 題官方詳解 {index}"></figure>'
            for index, path in enumerate(row["solutionImages"], 1)
        )
        checks = "".join(
            f'<label><input type="checkbox" data-check="{field}">{label}</label>'
            for field, label in (
                ("studentPixelsVerified", "學生卷面像素與題號正確"),
                ("solutionPixelsVerified", "官方詳解像素與題號正確"),
                ("truthModeVerified", "診斷／保留不確定的真值合理"),
                ("firstErrorEvidenceVerified", "第一錯步證據別名完整且不亂猜"),
                ("goodWorkEvidenceVerified", "做對部分證據完整且不誇大"),
            )
        )
        cards.append(f'''<article data-no="{row["no"]}"><h2>第 {row["no"]} 題｜{escape(row["expectedMode"])}</h2>
<p><b>正解：</b>{escape(row["officialAnswer"])}</p><p>{escape(row["reviewNote"])}</p>
<p><b>第一錯步真值：</b>{escape("；".join(row["firstErrorEvidenceAliases"]) or "必須 abstain")}</p>
<p><b>做對部分真值：</b>{escape("；".join(row["goodWorkEvidenceAliases"]) or "沒有具名證據")}</p>
<div class="pixels"><figure><figcaption>學生卷面</figcaption><img src="{escape(row["studentImage"])}" alt="第 {row["no"]} 題學生卷面"></figure>{solutions}</div>
<div class="checks">{checks}</div></article>''')
    meta = json.dumps({
        "goldId": packet["goldId"], "unsignedGoldSha256": packet["unsignedGoldSha256"],
        "reviewPacketSha256": packet["reviewPacketSha256"],
        "questionNos": packet["questionNos"],
    }, ensure_ascii=False).replace("</", "<\\/")
    statement = json.dumps(STATEMENT)
    return f'''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>數A 詳批 Gold 具名複核</title><style>body{{margin:0;background:#f2f0ea;color:#343a36;font:18px/1.55 system-ui,sans-serif}}header{{position:sticky;top:0;z-index:2;padding:14px 4vw;background:#f8f7f2;border-bottom:1px solid #c9c5ba}}main{{max-width:1500px;margin:auto;padding:22px}}article{{background:#fffefa;border:1px solid #d4d0c5;border-radius:12px;margin:0 0 22px;padding:20px}}.pixels{{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px}}figure{{margin:0}}img{{display:block;width:100%;max-height:75vh;object-fit:contain;background:white;border:1px solid #bbb7ad}}.checks{{display:grid;gap:10px;margin-top:18px}}label{{display:block}}input[type=checkbox]{{width:24px;height:24px;vertical-align:middle;margin-right:10px}}.sign{{position:sticky;bottom:0;background:#f8f7f2;border:1px solid #bcb7ab;padding:16px}}input[type=text]{{font-size:18px;padding:10px;width:min(420px,90%)}}button{{font-size:18px;padding:12px 18px;margin-top:10px;background:#4f584f;color:white;border:0;border-radius:7px}}</style>
<header><b>7 題詳批 Gold 具名複核</b><br>逐題核對學生卷面、官方詳解與人工真值；不得由 AI／agent 簽名。</header><main>{''.join(cards)}
<section class="sign"><label>簽核人真實姓名<br><input id="reviewer" type="text" autocomplete="name"></label><br><button id="export">七題全部核對完成，下載簽核檔</button></section></main>
<script>'use strict';const meta={meta};document.getElementById('export').onclick=()=>{{const approvedBy=document.getElementById('reviewer').value.trim(),cards=[...document.querySelectorAll('article')];if(approvedBy.length<3){{alert('請填可辨識的真人姓名');return}}for(const card of cards)if([...card.querySelectorAll('[data-check]')].some(box=>!box.checked)){{alert(`第 ${{card.dataset.no}} 題尚未全部核對`);return}}const out={{kind:'matha-paper-detail-gold-signoff',version:1,releaseAuthority:true,approvedBy,approvedAt:new Date().toISOString(),statement:{statement},...meta,checks:cards.map(card=>({{no:Number(card.dataset.no),...Object.fromEntries([...card.querySelectorAll('[data-check]')].map(box=>[box.dataset.check,true]))}}))}};const blob=new Blob([JSON.stringify(out,null,2)+'\n'],{{type:'application/json'}}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='paper-detail-gold-signoff.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000)}};</script></html>'''


def prepare(gold_path: Path, output: Path) -> dict[str, Any]:
    output = outside_repo(output)
    if output.exists() and any(output.iterdir()):
        raise DetailSignoffError("review output must be empty")
    gold = validate_unsigned_gold(gold_path)
    output.mkdir(parents=True, exist_ok=True)
    assets = output / "assets"
    assets.mkdir()
    asset_root = Path(gold["assetRoot"])
    cases = []
    for row in gold["cases"]:
        no = int(row["no"])
        student_source = asset_root / row["studentEvidence"]["file"]
        student_target = assets / f"q{no:02d}-student{student_source.suffix.lower()}"
        shutil.copy2(student_source, student_target)
        solutions = []
        for index, item in enumerate(row["solutionEvidence"], 1):
            source = asset_root / item["file"]
            target = assets / f"q{no:02d}-solution-{index}{source.suffix.lower()}"
            shutil.copy2(source, target)
            solutions.append(target.relative_to(output).as_posix())
        cases.append({
            "no": no, "officialAnswer": str(row["officialAnswer"]),
            "expectedMode": str(row["expectedMode"]),
            "reviewNote": str(row.get("reviewNote") or ""),
            "firstErrorEvidenceAliases": list(row.get("firstErrorEvidenceAliases") or []),
            "goodWorkEvidenceAliases": list(row.get("goodWorkEvidenceAliases") or []),
            "studentImage": student_target.relative_to(output).as_posix(),
            "studentImageSha256": sha256(student_target),
            "solutionImages": solutions,
            "solutionImageSha256": [sha256(output / path) for path in solutions],
        })
    packet = {
        "kind": "matha-paper-detail-gold-review-packet", "version": 1,
        "releaseAuthority": False, "goldId": gold["id"],
        "unsignedGoldPath": str(gold_path.resolve()),
        "unsignedGoldSha256": sha256(gold_path),
        "questionNos": REQUIRED_NOS, "cases": cases,
    }
    packet_path = output / "review-packet.json"
    packet_path.write_text(json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    packet["reviewPacketSha256"] = sha256(packet_path)
    (output / "review.html").write_text(render_html(packet), encoding="utf-8")
    write_server(output)
    return {"review": str(output / "review.html"), "packet": str(packet_path),
            "packetSha256": packet["reviewPacketSha256"], "questions": len(cases)}


def finalize(gold_path: Path, packet_path: Path, signoff_path: Path,
             output_path: Path) -> dict[str, Any]:
    output_path = outside_repo(output_path)
    if output_path.exists():
        raise DetailSignoffError("refusing to overwrite signed gold")
    gold = validate_unsigned_gold(gold_path)
    packet = load_json(packet_path, "review packet")
    signoff = load_json(signoff_path, "human signoff")
    if (packet.get("kind") != "matha-paper-detail-gold-review-packet"
            or packet.get("releaseAuthority") is not False
            or packet.get("goldId") != gold.get("id")
            or packet.get("unsignedGoldSha256") != sha256(gold_path)
            or packet.get("questionNos") != REQUIRED_NOS):
        raise DetailSignoffError("review packet is not bound to this gold")
    if (signoff.get("kind") != "matha-paper-detail-gold-signoff"
            or signoff.get("version") != 1 or signoff.get("releaseAuthority") is not True
            or signoff.get("statement") != STATEMENT
            or signoff.get("goldId") != gold.get("id")
            or signoff.get("unsignedGoldSha256") != sha256(gold_path)
            or signoff.get("reviewPacketSha256") != sha256(packet_path)
            or signoff.get("questionNos") != REQUIRED_NOS):
        raise DetailSignoffError("human signoff hash contract is invalid")
    approved_by = named_human(signoff.get("approvedBy"))
    approved_at = timestamp(signoff.get("approvedAt"))
    checks = signoff.get("checks")
    if (not isinstance(checks, list) or len(checks) != len(REQUIRED_NOS)
            or any(not isinstance(row, dict) for row in checks)
            or [int(row.get("no") or 0) for row in checks if isinstance(row, dict)] != REQUIRED_NOS
            or any(set(row) != {"no", *CHECK_FIELDS}
                   or any(row.get(field) is not True for field in CHECK_FIELDS)
                   for row in checks if isinstance(row, dict))):
        raise DetailSignoffError("human signoff does not complete every case and check")
    signed = {
        **gold,
        "releaseAuthority": True,
        "reviewStatus": "named-human-source-bound-approved",
        "releaseApproval": {
            "kind": "named-human-paper-detail-gold-signoff", "version": 1,
            "approvedBy": approved_by, "approvedAt": approved_at,
            "statement": STATEMENT,
            "unsignedGoldPath": str(gold_path.resolve()),
            "unsignedGoldSha256": sha256(gold_path),
            "reviewPacketPath": str(packet_path.resolve()),
            "reviewPacketSha256": sha256(packet_path),
            "signoffPath": str(signoff_path.resolve()),
            "signoffSha256": sha256(signoff_path),
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(signed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"signedGold": str(output_path), "signedGoldSha256": sha256(output_path),
            "approvedBy": approved_by, "questions": len(gold["cases"])}


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--gold", type=Path, required=True)
    prepare_parser.add_argument("--output", type=Path, required=True)
    final_parser = commands.add_parser("finalize")
    final_parser.add_argument("--gold", type=Path, required=True)
    final_parser.add_argument("--packet", type=Path, required=True)
    final_parser.add_argument("--signoff", type=Path, required=True)
    final_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        result = (prepare(args.gold.resolve(), args.output.resolve()) if args.command == "prepare"
                  else finalize(args.gold.resolve(), args.packet.resolve(), args.signoff.resolve(), args.output.resolve()))
    except (DetailSignoffError, OSError, ValueError) as error:
        print(f"prepare-paper-detail-gold-signoff: {error}")
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
