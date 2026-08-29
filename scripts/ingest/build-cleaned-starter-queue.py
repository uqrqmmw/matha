#!/usr/bin/env python3
"""Select a fail-closed 14-topic starter review queue from cleaned textbook pixels.

The command never publishes questions. It intersects the hash-bound YesScanner
candidate manifest with the independently bound official-answer packet, maps
topics from book/page evidence (never OCR chapter text), selects a balanced
starter candidate set, and splits it into small human-QA batches.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TOPIC_MAP = Path(__file__).with_name("math-a-topic-map.json")
ROLES = ("example", "chapter-end-easy", "chapter-end-medium", "chapter-end-hard")
ROLE_WEIGHTS = {"example": 0.30, "chapter-end-easy": 0.20,
                "chapter-end-medium": 0.35, "chapter-end-hard": 0.15}
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}\Z")
APP_TOPICS = {
    "num", "poly", "exp", "seq", "trig1", "trig2", "line",
    "vec", "svec", "splane", "mat", "comb", "prob", "data",
}


class StarterQueueError(RuntimeError):
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
    raise StarterQueueError(f"Private output must stay outside Git: {resolved}")


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StarterQueueError(f"Cannot read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise StarterQueueError(f"Expected JSON object: {path}")
    return value


def unique_rows(rows: Any, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(rows, list):
        raise StarterQueueError(f"{label} items must be a list")
    result: dict[str, dict[str, Any]] = {}
    for row in rows:
        qid = str(row.get("id") or "") if isinstance(row, dict) else ""
        if not SAFE_ID.fullmatch(qid) or qid in result:
            raise StarterQueueError(f"{label} has invalid or duplicate id: {qid}")
        result[qid] = row
    return result


def validate_topic_map(document: dict[str, Any]) -> tuple[dict[str, str], dict[str, list[dict[str, Any]]]]:
    topics = document.get("topics")
    books = document.get("books")
    if (document.get("schema") != 1 or not isinstance(topics, dict)
            or set(topics) != APP_TOPICS or not isinstance(books, dict)):
        raise StarterQueueError("Topic map must define the app's exact 14 topics")
    for book_id, ranges in books.items():
        if not SAFE_ID.fullmatch(str(book_id)) or not isinstance(ranges, list) or not ranges:
            raise StarterQueueError(f"Invalid topic ranges for {book_id}")
        occupied: set[int] = set()
        for item in ranges:
            start, end = item.get("fromPdfPage"), item.get("toPdfPage")
            if (not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start
                    or item.get("topic") not in topics
                    or item.get("confidence") not in {"high", "provisional"}):
                raise StarterQueueError(f"Invalid topic range for {book_id}")
            pages = set(range(start, end + 1))
            if occupied & pages:
                raise StarterQueueError(f"Overlapping topic ranges for {book_id}")
            occupied |= pages
    return {str(key): str(value) for key, value in topics.items()}, books


def topic_for(books: dict[str, list[dict[str, Any]]], book_id: str,
              page: int) -> dict[str, Any] | None:
    matched = [row for row in books.get(book_id, [])
               if int(row["fromPdfPage"]) <= page <= int(row["toPdfPage"])]
    if len(matched) != 1:
        return None
    return matched[0]


def checked_asset(path: Path, expected: str, label: str) -> str:
    if not path.is_file() or not re.fullmatch(r"[a-f0-9]{64}", str(expected)):
        raise StarterQueueError(f"{label} missing or unbound: {path}")
    actual = sha256(path)
    if actual != expected:
        raise StarterQueueError(f"{label} hash mismatch: {path}")
    return str(path.resolve())


def balanced_take(rows: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    by_book: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_book[row["bookId"]].append(row)
    for bucket in by_book.values():
        bucket.sort(key=lambda row: (row["figureCount"] == 0, row["pdfPage"], row["id"]))
    selected: list[dict[str, Any]] = []
    book_ids = sorted(by_book)
    while len(selected) < count:
        progressed = False
        for book_id in book_ids:
            if by_book[book_id] and len(selected) < count:
                selected.append(by_book[book_id].pop(0))
                progressed = True
        if not progressed:
            break
    return selected


def role_targets(count: int) -> dict[str, int]:
    """Scale the 3/2/3.5/1.5 mix without making larger queues example-heavy."""
    raw = {role: count * ROLE_WEIGHTS[role] for role in ROLES}
    targets = {role: int(raw[role]) for role in ROLES}
    remaining = count - sum(targets.values())
    order = sorted(ROLES, key=lambda role: (-(raw[role] - targets[role]), ROLES.index(role)))
    for role in order[:remaining]:
        targets[role] += 1
    return targets


def rebalance_books(selected: list[dict[str, Any]], rows: list[dict[str, Any]],
                    count: int) -> list[dict[str, Any]]:
    """Keep one book at <=50% when the available pool can actually support it."""
    available = Counter(row["bookId"] for row in rows)
    if len(available) < 2:
        return selected
    cap = (count + 1) // 2
    used = {row["id"] for row in selected}
    output = list(selected)
    while True:
        counts = Counter(row["bookId"] for row in output)
        dominant, amount = counts.most_common(1)[0]
        if amount <= cap:
            break
        replacements = [row for row in rows if row["id"] not in used and row["bookId"] != dominant]
        if not replacements:
            break
        swapped = False
        for victim_index in reversed(range(len(output))):
            victim = output[victim_index]
            if victim["bookId"] != dominant:
                continue
            replacements.sort(key=lambda row: (
                row["role"] != victim["role"],
                row["figureCount"] == 0,
                counts[row["bookId"]], row["bookId"], row["pdfPage"], row["id"],
            ))
            replacement = replacements[0]
            used.remove(victim["id"])
            used.add(replacement["id"])
            output[victim_index] = replacement
            swapped = True
            break
        if not swapped:
            break
    return output


def select_topic(rows: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    used: set[str] = set()
    targets = role_targets(count)
    for role in ROLES:
        take = min(targets[role], count - len(selected))
        choices = [row for row in rows if row["role"] == role and row["id"] not in used]
        picked = balanced_take(choices, take)
        selected.extend(picked)
        used.update(row["id"] for row in picked)
    if len(selected) < count:
        remaining = [row for row in rows if row["id"] not in used]
        remaining.sort(key=lambda row: (
            row["figureCount"] == 0,
            ("chapter-end-medium", "chapter-end-hard", "example", "chapter-end-easy").index(row["role"]),
            row["bookId"], row["pdfPage"], row["id"],
        ))
        selected.extend(remaining[:count - len(selected)])
    return rebalance_books(selected, rows, count)


def interleave(selected: dict[str, list[dict[str, Any]]], topics: list[str]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    width = max((len(rows) for rows in selected.values()), default=0)
    for index in range(width):
        for topic in topics:
            if index < len(selected.get(topic, [])):
                output.append(selected[topic][index])
    return output


def matrix_rows(rows: list[dict[str, Any]], topics: list[str]) -> list[dict[str, Any]]:
    result = []
    for topic in topics:
        subset = [row for row in rows if row["topic"] == topic]
        high = [row for row in subset if row["topicConfidence"] == "high"]
        role_counts = Counter(row["role"] for row in subset)
        high_roles = Counter(row["role"] for row in high)
        result.append({
            "topic": topic,
            "mapped": len(subset),
            "highConfidence": len(high),
            "withFigure": sum(row["figureCount"] > 0 for row in subset),
            "highConfidenceWithFigure": sum(row["figureCount"] > 0 for row in high),
            "roles": {role: role_counts[role] for role in ROLES},
            "highConfidenceRoles": {role: high_roles[role] for role in ROLES},
            "books": sorted({row["bookId"] for row in subset}),
            "highConfidenceBooks": sorted({row["bookId"] for row in high}),
        })
    return result


def selection_rows(selection_by_topic: dict[str, list[dict[str, Any]]],
                   joined: list[dict[str, Any]], topics: list[str],
                   count: int) -> list[dict[str, Any]]:
    result = []
    targets = role_targets(count)
    for topic in topics:
        rows = selection_by_topic[topic]
        pool = [row for row in joined
                if row["topic"] == topic and row["topicConfidence"] == "high"]
        roles = Counter(row["role"] for row in rows)
        books = Counter(row["bookId"] for row in rows)
        pool_books = Counter(row["bookId"] for row in pool)
        dominant, max_book = books.most_common(1)[0]
        outside_capacity = len(pool) - pool_books[dominant]
        cap = (count + 1) // 2
        if max_book > cap and outside_capacity >= count - cap:
            raise StarterQueueError(
                f"Topic {topic} could satisfy the book cap but selection did not")
        shortfalls = {role: targets[role] - roles[role] for role in ROLES
                      if roles[role] < targets[role]}
        source_segments = sorted({
            f'{row["bookId"]}:{row["topicEvidence"]}' for row in pool
        })
        result.append({
            "topic": topic,
            "selected": len(rows),
            "withFigure": sum(row["figureCount"] > 0 for row in rows),
            "roles": {role: roles[role] for role in ROLES},
            "roleTargets": dict(targets),
            "roleShortfalls": shortfalls,
            "selectedBooks": dict(sorted(books.items())),
            "availableHighConfidenceBooks": dict(sorted(pool_books.items())),
            "maxBook": dominant,
            "maxBookCount": max_book,
            "maxBookShare": round(max_book / len(rows), 6),
            "bookCapStatus": "met" if max_book <= cap else "blocked-by-source-capacity",
            "sourceSegments": source_segments,
            "sourceSegmentStatus": "met" if len(source_segments) >= 3 else "blocked-by-source-inventory",
        })
    return result


def subset_manifest(source: dict[str, Any], items: list[dict[str, Any]],
                    kind: str, parent_hash: str) -> dict[str, Any]:
    copied = {key: value for key, value in source.items() if key not in {"items", "questions"}}
    copied.update({
        "kind": "cleaned-page-question-candidates",
        "releaseAuthority": False,
        "humanPixelReviewRequired": True,
        "selectionKind": kind,
        "parentCandidateManifestSha256": parent_hash,
        "questions": len(items),
        "items": items,
    })
    return copied


def load_exclusions(path: Path | None) -> tuple[set[str], str | None]:
    if path is None:
        return set(), None
    document = read_json(path)
    if document.get("schema") != 1 or document.get("kind") != "matha-starter-review-exclusions":
        raise StarterQueueError("Invalid starter review exclusions manifest")
    rows = unique_rows(document.get("items"), "starter review exclusion")
    for qid, row in rows.items():
        reason = row.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise StarterQueueError(f"Exclusion {qid} must have a reason")
    return set(rows), sha256(path)


def build(candidate_path: Path, binding_path: Path, topic_map_path: Path,
          output: Path, per_topic: int, batch_size: int,
          exclusions_path: Path | None = None) -> dict[str, Any]:
    output = outside_repo(output)
    if per_topic < 1 or batch_size < 1 or batch_size > 50:
        raise StarterQueueError("per-topic must be positive and batch-size must be 1..50")
    if output.exists() and any(output.iterdir()):
        raise StarterQueueError("Output directory must be empty")
    candidate = read_json(candidate_path)
    binding = read_json(binding_path)
    topics, mappings = validate_topic_map(read_json(topic_map_path))
    excluded_ids, exclusions_hash = load_exclusions(exclusions_path)
    if (candidate.get("kind") != "cleaned-page-question-candidates"
            or candidate.get("releaseAuthority") is not False):
        raise StarterQueueError("Candidate manifest is not review-only cleaned pixels")
    candidate_hash = sha256(candidate_path)
    if (binding.get("kind") != "cleaned-answer-binding-candidates"
            or binding.get("releaseAuthority") is not False
            or binding.get("candidateManifestSha256") != candidate_hash):
        raise StarterQueueError("Answer binding does not match candidate manifest")
    candidates = unique_rows(candidate.get("items"), "candidate")
    answers = unique_rows(binding.get("items"), "answer binding")
    unknown_exclusions = excluded_ids - set(candidates)
    if unknown_exclusions:
        raise StarterQueueError(
            "Exclusions reference missing candidates: " + ", ".join(sorted(unknown_exclusions)))
    answer_root = binding_path.resolve().parent
    joined: list[dict[str, Any]] = []
    excluded = Counter()
    for qid, answer in answers.items():
        item = candidates.get(qid)
        if item is None:
            raise StarterQueueError(f"Answer binding references missing candidate: {qid}")
        if (item.get("bookId") != answer.get("bookId")
                or int(item.get("pdfPage") or 0) != int(answer.get("pdfPage") or 0)
                or item.get("sourceSha256") != answer.get("sourceSha256")
                or item.get("cleanedSha256") != answer.get("cleanedSha256")):
            raise StarterQueueError(f"Question/answer identity mismatch: {qid}")
        if qid in excluded_ids:
            excluded["explicit-pixel-or-content-quarantine"] += 1
            continue
        role = str(answer.get("role") or "")
        if role not in ROLES:
            excluded["role-not-in-starter-scope"] += 1
            continue
        mapped = topic_for(mappings, str(item["bookId"]), int(item["pdfPage"]))
        if mapped is None:
            excluded["topic-unmapped-or-ambiguous"] += 1
            continue
        joined.append({
            "id": qid,
            "bookId": str(item["bookId"]),
            "pdfPage": int(item["pdfPage"]),
            "topic": str(mapped["topic"]),
            "topicConfidence": str(mapped["confidence"]),
            "topicEvidence": str(mapped.get("evidence") or ""),
            "role": role,
            "figureCount": int(answer.get("figureCount") or 0),
            "questionType": str(answer.get("questionType") or ""),
            "answerPdfPage": int(answer.get("answerPdfPage") or 0),
            "answerSource": str(answer.get("answerSource") or ""),
            "sourceSha256": str(item["sourceSha256"]),
            "cleanedSha256": str(item["cleanedSha256"]),
            "answerSha256": str(answer["answerSha256"]),
        })
    topic_order = list(topics)
    selection_by_topic: dict[str, list[dict[str, Any]]] = {}
    for topic in topic_order:
        pool = [row for row in joined if row["topic"] == topic and row["topicConfidence"] == "high"]
        selected = select_topic(pool, per_topic)
        if len(selected) != per_topic:
            raise StarterQueueError(f"Topic {topic} has only {len(selected)}/{per_topic} safe candidates")
        selection_by_topic[topic] = selected
    selected = interleave(selection_by_topic, topic_order)
    selected_topics = selection_rows(selection_by_topic, joined, topic_order, per_topic)
    # Revalidate only the selected assets; the full 1,919-item packets already
    # have their own complete hash audit and are not republished here.
    for row in selected:
        item = candidates[row["id"]]
        row["sourcePath"] = checked_asset(Path(str(item["source"])), row["sourceSha256"], "source")
        row["cleanedPath"] = checked_asset(Path(str(item["cleaned"])), row["cleanedSha256"], "cleaned")
        row["answerPath"] = checked_asset(answer_root / "assets" / row["id"] / "answer.png",
                                           row["answerSha256"], "answer")
        checked_asset(answer_root / "assets" / row["id"] / "question.png",
                      row["cleanedSha256"], "answer-packet-question")
    output.mkdir(parents=True, exist_ok=True)
    matrix = {
        "schema": 1, "kind": "matha-cleaned-candidate-coverage-matrix",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "releaseAuthority": False,
        "candidateManifestSha256": candidate_hash,
        "answerBindingSha256": sha256(binding_path),
        "topicMapSha256": sha256(topic_map_path),
        "exclusionsSha256": exclusions_hash,
        "explicitExclusions": len(excluded_ids),
        "reviewableWithOfficialAnswer": len(answers),
        "mappedStarterRoles": len(joined),
        "excluded": dict(sorted(excluded.items())),
        "topics": matrix_rows(joined, topic_order),
        "selectedTopics": selected_topics,
    }
    (output / "coverage-matrix.json").write_text(
        json.dumps(matrix, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    starter = {
        "schema": 1, "kind": "matha-cleaned-starter-review-selection",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "releaseAuthority": False, "studentReady": False,
        "humanPixelReviewRequired": True, "humanAnswerReviewRequired": True,
        "humanReleaseSignoffRequired": True,
        "candidateManifestSha256": candidate_hash,
        "answerBindingSha256": sha256(binding_path),
        "topicMapSha256": sha256(topic_map_path),
        "exclusionsSha256": exclusions_hash,
        "explicitExclusions": len(excluded_ids),
        "perTopic": per_topic, "selected": len(selected),
        "topicSummary": selected_topics,
        "items": selected,
    }
    (output / "starter-review-selection.json").write_text(
        json.dumps(starter, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    source_items = [candidates[row["id"]] for row in selected]
    full_subset = subset_manifest(candidate, source_items, f"starter-{len(selected)}", candidate_hash)
    (output / "starter-cleaned-candidates.json").write_text(
        json.dumps(full_subset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    batches = []
    for offset in range(0, len(selected), batch_size):
        number = offset // batch_size + 1
        rows = selected[offset:offset + batch_size]
        batch_items = [candidates[row["id"]] for row in rows]
        name = f"batch-{number:02d}-cleaned-candidates.json"
        batch = subset_manifest(candidate, batch_items, f"starter-batch-{number:02d}", candidate_hash)
        (output / name).write_text(json.dumps(batch, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        batches.append({"batch": number, "file": name, "questions": len(rows),
                        "topics": dict(Counter(row["topic"] for row in rows))})
    lines = [
        "# 先遣題庫 coverage matrix", "",
        f"- 可綁官方答案：{len(answers):,}",
        f"- 可映射且角色在範圍：{len(joined):,}",
        f"- 本輪平衡候選：{len(selected)}（每單元 {per_topic}）",
        "- 發布權限：false；目前只是人工 QA 佇列", "",
        "| 單元 | 全部 | 高信心 | 高信心有圖 | 例題 | 簡單 | 中等 | 困難 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in matrix["topics"]:
        roles = row["highConfidenceRoles"]
        lines.append(
            f"| {topics[row['topic']]} | {row['mapped']} | {row['highConfidence']} | "
            f"{row['highConfidenceWithFigure']} | {roles['example']} | "
            f"{roles['chapter-end-easy']} | {roles['chapter-end-medium']} | "
            f"{roles['chapter-end-hard']} |"
        )
    lines += ["", "## 本輪實際選取", "",
              "| 單元 | 題數 | 有圖 | 例題 | 簡單 | 中等 | 困難 | 來源書 | 單書最高 |",
              "|---|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for row in selected_topics:
        roles = row["roles"]
        lines.append(
            f"| {topics[row['topic']]} | {row['selected']} | {row['withFigure']} | "
            f"{roles['example']} | {roles['chapter-end-easy']} | "
            f"{roles['chapter-end-medium']} | {roles['chapter-end-hard']} | "
            f"{len(row['selectedBooks'])} | {row['maxBookCount']} ({row['maxBookShare']:.0%}) |"
        )
    role_blockers = [row for row in selected_topics if row["roleShortfalls"]]
    source_blockers = [row for row in selected_topics if row["sourceSegmentStatus"] != "met"]
    lines += ["", "## 明列阻塞", ""]
    lines.append("- 難度／角色素材不足：" + (
        "；".join(f"{topics[row['topic']]}={row['roleShortfalls']}" for row in role_blockers)
        if role_blockers else "無"))
    lines.append("- 少於 3 個高信心來源區段：" + (
        "、".join(topics[row["topic"]] for row in source_blockers)
        if source_blockers else "無"))
    lines += ["", "## 人工 QA 批次", ""]
    lines.extend(f"- Batch {row['batch']:02d}: {row['questions']} 題；14 單元交錯" for row in batches)
    lines += ["", "OCR 章名不參與單元真值；正式發布時仍須逐題確認單元、題面與答案。", ""]
    (output / "coverage-matrix.md").write_text("\n".join(lines), encoding="utf-8")
    summary = {
        "releaseAuthority": False,
        "reviewableWithOfficialAnswer": len(answers),
        "mappedStarterRoles": len(joined),
        "selected": len(selected),
        "perTopic": per_topic,
        "withFigure": sum(row["figureCount"] > 0 for row in selected),
        "roles": dict(Counter(row["role"] for row in selected)),
        "roleShortfallTopics": [row["topic"] for row in role_blockers],
        "sourceDiversityBlockedTopics": [row["topic"] for row in source_blockers],
        "explicitExclusions": len(excluded_ids),
        "exclusionsSha256": exclusions_hash,
        "batches": batches,
        "output": str(output),
    }
    (output / "build-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--answer-binding", type=Path, required=True)
    parser.add_argument("--topic-map", type=Path, default=DEFAULT_TOPIC_MAP)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--exclusions", type=Path)
    parser.add_argument("--per-topic", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=35)
    args = parser.parse_args(argv)
    try:
        result = build(args.candidates, args.answer_binding, args.topic_map,
                       args.out, args.per_topic, args.batch_size, args.exclusions)
    except (StarterQueueError, OSError, ValueError, KeyError) as error:
        print(f"build-cleaned-starter-queue: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
