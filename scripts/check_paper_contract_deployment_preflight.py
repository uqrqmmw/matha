"""Fail-closed preflight for the historical 006 server timestamp ambiguity."""
from __future__ import annotations
import argparse, json, re, subprocess, sys
from pathlib import Path

TARGET = "202608300006"

def verify(output: str) -> None:
    try:
        payload=json.loads(output)
        if isinstance(payload,dict) and isinstance(payload.get("migrations"),list):
            remote=[str(row.get("remote") or "") for row in payload["migrations"] if row.get("remote")]
            if TARGET in remote: raise RuntimeError("BLOCKED: migration 006 was remotely applied; old server_updated_at provenance is ambiguous")
            if remote: raise RuntimeError("BLOCKED: remote migration history is not empty; require explicit operator review")
            return
    except json.JSONDecodeError: pass
    rows=[]
    for line in output.splitlines():
        if re.search(r"\d{12}",line): rows.append(line)
    remote=[]
    for line in rows:
        parts=[part.strip() for part in line.split("|")]
        if len(parts)>=2 and re.fullmatch(r"\d{12,14}",parts[1]): remote.append(parts[1])
    if TARGET in remote:
        raise RuntimeError("BLOCKED: migration 006 was remotely applied; old server_updated_at provenance is ambiguous")
    if remote:
        raise RuntimeError("BLOCKED: remote migration history is not empty; require explicit operator review")

def main() -> int:
    parser=argparse.ArgumentParser()
    parser.add_argument("--input",type=Path)
    args=parser.parse_args()
    if args.input: output=args.input.read_text(encoding="utf-8")
    else:
        proc=subprocess.run(["npx.cmd","--yes","supabase","migration","list","--linked"],text=True,
                            capture_output=True,check=False)
        if proc.returncode: raise RuntimeError("cannot prove remote migration history: "+proc.stderr.strip())
        output=proc.stdout
    verify(output)
    print("PASS: remote migration column is empty; corrected 006 has not been applied remotely")
    return 0
if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exception as exc:
        print(str(exc),file=sys.stderr); raise SystemExit(2)
