#!/usr/bin/env python3
"""Independently solve and compare one promoted textbook batch with GPT-5.5.

Each group uses two calls so the independent solution cannot see or anchor on
the printed answer.  The second call receives that preserved solution plus the
original stem and official-answer crops, then checks mathematical equivalence.
Progress is saved after every call and is resumable without paying twice.
This command never grants release authority or human sign-off.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MODEL = "gpt-5.5"
API_URL = "https://api.openai.com/v1/responses"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent


class MathVerifyError(RuntimeError):
    """A fail-closed mathematical verification error."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MathVerifyError(f"Cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise MathVerifyError(f"Expected a JSON object: {path}")
    return value


def outside_repo(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError:
        return resolved
    raise MathVerifyError(f"Private mathematical audit must stay outside Git: {resolved}")


def atomic_write(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    temporary.replace(path)


def output_text(response: dict[str, Any]) -> str:
    direct = response.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct
    for item in response.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            if isinstance(content, dict) and content.get("type") == "output_text" \
                    and isinstance(content.get("text"), str) and content["text"].strip():
                return content["text"]
    raise MathVerifyError("GPT-5.5 response had no output_text")


def image_content(path: Path) -> dict[str, str]:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"type": "input_image", "image_url": f"data:image/png;base64,{encoded}", "detail": "high"}


def solution_schema() -> dict[str, Any]:
    item = {
        "type": "object", "additionalProperties": False,
        "required": ["id", "readable", "independentAnswer", "derivation", "confidence", "ambiguity"],
        "properties": {
            "id": {"type": "string"}, "readable": {"type": "boolean"},
            "independentAnswer": {"type": "string"}, "derivation": {"type": "string"},
            "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
            "ambiguity": {"type": "string"},
        },
    }
    return {"type": "object", "additionalProperties": False, "required": ["items"],
            "properties": {"items": {"type": "array", "items": item}}}


def comparison_schema() -> dict[str, Any]:
    item = {
        "type": "object", "additionalProperties": False,
        "required": ["id", "officialAnswerText", "verdict", "checkedAnswer",
                     "equivalenceReason", "discrepancy"],
        "properties": {
            "id": {"type": "string"}, "officialAnswerText": {"type": "string"},
            "verdict": {"type": "string", "enum": ["agree", "disagree", "unclear"]},
            "checkedAnswer": {"type": "string"}, "equivalenceReason": {"type": "string"},
            "discrepancy": {"type": "string"},
        },
    }
    return {"type": "object", "additionalProperties": False, "required": ["items"],
            "properties": {"items": {"type": "array", "items": item}}}


def request(api_key: str, content: list[dict[str, str]], name: str,
            schema: dict[str, Any]) -> dict[str, Any]:
    body = {
        "model": MODEL, "reasoning": {"effort": "high"},
        "input": [{"role": "user", "content": content}],
        "text": {"format": {"type": "json_schema", "name": name,
                              "strict": True, "schema": schema}},
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        message = error.read().decode("utf-8", errors="replace")[:1500]
        raise MathVerifyError(f"OpenAI API HTTP {error.code}: {message}") from error
    try:
        document = json.loads(output_text(payload))
    except json.JSONDecodeError as error:
        raise MathVerifyError(f"GPT-5.5 returned invalid JSON: {error}") from error
    if not isinstance(document, dict) or not isinstance(document.get("items"), list):
        raise MathVerifyError("GPT-5.5 structured result has no items array")
    return {"responseId": payload.get("id"), "model": payload.get("model") or MODEL,
            "usage": payload.get("usage") or {}, "items": document["items"]}


def validate_order(items: list[dict[str, Any]], expected: list[str], stage: str) -> None:
    actual = [row.get("id") for row in items if isinstance(row, dict)]
    if actual != expected:
        raise MathVerifyError(f"{stage} IDs/order do not match requested questions")


def question_assets(question: dict[str, Any], work_root: Path) -> tuple[Path, Path]:
    qid, book_id = str(question.get("id") or ""), str(question.get("bookId") or "")
    stem = work_root / book_id / "crops" / qid / "stem.png"
    answer = work_root / book_id / "crops" / qid / "answer.png"
    if not stem.is_file() or not answer.is_file():
        raise MathVerifyError(f"Missing original stem/answer crop for {qid}")
    asset = question.get("stemAsset") or {}
    if asset.get("sha256") != sha256(stem):
        raise MathVerifyError(f"Promoted stem hash changed for {qid}")
    return stem, answer


def solve_group(api_key: str, questions: list[dict[str, Any]], work_root: Path) -> dict[str, Any]:
    ids = [question["id"] for question in questions]
    prompt = (
        "你是獨立的台灣學測數學 A 驗算員。以下只給原題圖，絕對沒有官方答案。"
        "請逐題自行讀圖、完整解題與交叉檢查，不能使用 OCR 轉錄或猜測。"
        "所有小題、複選選項、矩陣與根式都要完整回答；若圖像或條件真的看不清就 readable=false，不能硬猜。"
        "依指定 ID 順序回傳。\n" + json.dumps(ids, ensure_ascii=False))
    content: list[dict[str, str]] = [{"type": "input_text", "text": prompt}]
    for question in questions:
        stem, _ = question_assets(question, work_root)
        content.append({"type": "input_text", "text": f"{question['id']}｜只看原題，獨立解題"})
        content.append(image_content(stem))
    result = request(api_key, content, "independent_math_solutions", solution_schema())
    validate_order(result["items"], ids, "independent solution")
    return result


def compare_group(api_key: str, questions: list[dict[str, Any]], work_root: Path,
                  solution: dict[str, Any]) -> dict[str, Any]:
    ids = [question["id"] for question in questions]
    validate_order(solution.get("items") or [], ids, "saved independent solution")
    prompt = (
        "你是第二階段數學驗證員。第一階段在完全看不到官方答案時已留下獨立解答。"
        "現在逐題比較該獨立解答與官方答案圖；先精確讀官方答案，再檢查數學等價性。"
        "若不一致，重新核算判斷是官方答案、獨立解答或題圖歧義；不要為了迎合官方答案改口。"
        "只有所有小題與所有複選選項都等價才可 verdict=agree；看不清或無法確定用 unclear。"
        "依指定 ID 順序回傳。第一階段紀錄如下：\n"
        + json.dumps(solution["items"], ensure_ascii=False))
    content: list[dict[str, str]] = [{"type": "input_text", "text": prompt}]
    for question in questions:
        stem, answer = question_assets(question, work_root)
        content.append({"type": "input_text", "text": f"{question['id']}｜原題"})
        content.append(image_content(stem))
        content.append({"type": "input_text", "text": f"{question['id']}｜官方答案"})
        content.append(image_content(answer))
    result = request(api_key, content, "math_answer_comparison", comparison_schema())
    validate_order(result["items"], ids, "answer comparison")
    return result


def run(source_file: Path, work_root: Path, output_file: Path,
        verified_source_file: Path, api_key: str, group_size: int) -> dict[str, Any]:
    work_root, output_file, verified_source_file = (
        outside_repo(work_root), outside_repo(output_file), outside_repo(verified_source_file))
    source = read_json(source_file)
    if source.get("kind") != "private-question-source" or source.get("releaseApprovedBy") is not None:
        raise MathVerifyError("Expected an unsigned promoted private-question-source")
    questions = source.get("questions") or []
    if not questions or len({row.get("id") for row in questions}) != len(questions):
        raise MathVerifyError("Source has no questions or duplicate question ids")
    source_hash = sha256(source_file)
    if output_file.is_file():
        result = read_json(output_file)
        if result.get("sourceSha256") != source_hash or result.get("model") != MODEL:
            raise MathVerifyError("Existing audit belongs to another source/model; use a new output path")
    else:
        result = {
            "kind": "matha-independent-mathematical-verification", "version": 1,
            "releaseAuthority": False, "humanSignoffStillRequired": True,
            "model": MODEL, "method": "blind-solve-then-official-answer-compare-v1",
            "source": str(source_file.resolve()), "sourceSha256": source_hash,
            "completedAt": None, "groups": [], "summary": {},
        }
    prior = {tuple(group.get("questionIds") or []): group for group in result.get("groups") or []}
    groups = [questions[index:index + group_size] for index in range(0, len(questions), group_size)]
    result["groups"] = []
    for index, group in enumerate(groups, 1):
        ids = [row["id"] for row in group]
        saved = prior.get(tuple(ids), {"questionIds": ids})
        if not saved.get("solution"):
            saved["solution"] = solve_group(api_key, group, work_root)
            prior[tuple(ids)] = saved
            result["groups"].append(saved)
            atomic_write(output_file, result)
            print(f"solved {index}/{len(groups)}: {', '.join(ids)}", flush=True)
            result["groups"].pop()
        if not saved.get("comparison"):
            saved["comparison"] = compare_group(api_key, group, work_root, saved["solution"])
            prior[tuple(ids)] = saved
            result["groups"].append(saved)
            atomic_write(output_file, result)
            print(f"compared {index}/{len(groups)}: {', '.join(ids)}", flush=True)
            result["groups"].pop()
        result["groups"].append(saved)
        atomic_write(output_file, result)

    comparisons = [row for group in result["groups"] for row in group["comparison"]["items"]]
    solutions = [row for group in result["groups"] for row in group["solution"]["items"]]
    disagree = [row["id"] for row in comparisons if row.get("verdict") == "disagree"]
    unclear = [row["id"] for row in comparisons if row.get("verdict") == "unclear"]
    unreadable = [row["id"] for row in solutions if row.get("readable") is not True]
    disputed = set(disagree + unclear + unreadable)
    question_by_id = {row["id"]: row for row in questions}
    disputed_ids = sorted(disputed)
    adjudication_groups = [
        [question_by_id[qid] for qid in disputed_ids[index:index + group_size]]
        for index in range(0, len(disputed), group_size)
    ]
    prior_adjudication = {
        tuple(group.get("questionIds") or []): group for group in result.get("adjudication") or []
    }
    result["adjudication"] = []
    for index, group in enumerate(adjudication_groups, 1):
        ids = [row["id"] for row in group]
        saved = prior_adjudication.get(tuple(ids), {"questionIds": ids})
        if not saved.get("solution"):
            saved["solution"] = solve_group(api_key, group, work_root)
            prior_adjudication[tuple(ids)] = saved
            result["adjudication"].append(saved)
            atomic_write(output_file, result)
            print(f"adjudication solved {index}/{len(adjudication_groups)}: {', '.join(ids)}", flush=True)
            result["adjudication"].pop()
        if not saved.get("comparison"):
            saved["comparison"] = compare_group(api_key, group, work_root, saved["solution"])
            prior_adjudication[tuple(ids)] = saved
            result["adjudication"].append(saved)
            atomic_write(output_file, result)
            print(f"adjudication compared {index}/{len(adjudication_groups)}: {', '.join(ids)}", flush=True)
            result["adjudication"].pop()
        result["adjudication"].append(saved)
        atomic_write(output_file, result)

    adjudication_rows = {
        row["id"]: row for group in result["adjudication"]
        for row in group["comparison"]["items"]
    }
    accepted_ids = [
        row["id"] for row in comparisons
        if row.get("verdict") == "agree" or adjudication_rows.get(row["id"], {}).get("verdict") == "agree"
    ]
    excluded_ids = [row["id"] for row in questions if row["id"] not in set(accepted_ids)]
    verified = bool(accepted_ids) and len(accepted_ids) + len(excluded_ids) == len(questions)
    result["completedAt"] = datetime.now(timezone.utc).isoformat()
    result["summary"] = {"questions": len(questions), "firstPassAgree": len(questions) - len(disagree) - len(unclear),
                         "disagree": disagree, "unclear": unclear, "unreadable": unreadable,
                         "acceptedAfterAdjudication": accepted_ids, "excludedAfterAdjudication": excluded_ids,
                         "verifiedQuestionCount": len(accepted_ids),
                         "mathematicalCorrectnessVerifiedForFilteredSource": verified}
    atomic_write(output_file, result)
    if verified:
        verified_questions = [row for row in questions if row["id"] in set(accepted_ids)]
        review_audit = {**(source.get("reviewAudit") or {}),
                        "sourceQuestionCount": len(verified_questions),
                        "approvedQuestionCount": len(verified_questions)}
        verified_source = {**source, "questions": verified_questions,
                           "reviewAudit": review_audit,
                           "mathematicalCorrectnessVerified": True,
                           "mathVerification": {
                               "kind": result["kind"], "version": result["version"],
                               "model": MODEL, "method": result["method"],
                               "completedAt": result["completedAt"],
                               "auditFile": str(output_file.resolve()),
                               "auditSha256": sha256(output_file),
                               "sourceSha256": source_hash,
                               "verifiedQuestionIds": accepted_ids,
                               "excludedQuestionIds": excluded_ids,
                               "releaseAuthority": False,
                           }}
        atomic_write(verified_source_file, verified_source)
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--verified-source", required=True, type=Path)
    parser.add_argument("--group-size", type=int, default=4)
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.group_size <= 4:
            raise MathVerifyError("group-size must be from 1 to 4")
        api_key = os.environ.get("OPENAI_API_KEY", "")
        if not api_key:
            raise MathVerifyError("OPENAI_API_KEY is missing")
        result = run(args.source, args.work, args.out, args.verified_source,
                     api_key, args.group_size)
    except (MathVerifyError, OSError, ValueError) as error:
        print(f"verify-math-openai: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result["summary"], ensure_ascii=False, indent=2))
    return 0 if result["summary"].get("mathematicalCorrectnessVerifiedForFilteredSource") else 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
