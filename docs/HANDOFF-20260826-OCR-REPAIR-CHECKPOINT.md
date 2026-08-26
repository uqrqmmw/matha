# OCR repair checkpoint — 2026-08-26

This checkpoint was written because the Windows desktop session stopped being
able to create any new process (`0xC0000142`).  Work resumed after reboot on
2026-08-27; all 21 core crop rebuilds and the corpus audit are now complete.

## Completed and verified

- No browser or browser automation was used.
- The 25-PDF / 6,720-page Mistral corpus remains immutable and outside Git.
- Eleven visually reviewed whole-page OCR dropouts are now used through a
  fail-closed repair chain:
  - 10 `mistral-ocr-latest` single-page repairs.
  - 1 `gpt-5.5` structured-vision repair for
    `114學測班空間向量與三階行列式.pdf`, PDF page 194.
- The OpenAI repair preserves the requested alias (`gpt-5.5`) and records the
  resolved snapshot (`gpt-5.5-2026-04-23`), raw-response SHA-256, source PDF
  SHA-256, page number and render SHA-256.  It does not overwrite Mistral raw
  output and is still index-only metadata.
- Page 194 was visually checked against the original scan: fill questions 9
  and 10 plus calculation question 1 are faithfully transcribed.  Blank answer
  boxes remain blank.
- `index-mistral-pages.py` now verifies dropout dispositions, candidate/source
  binding, provider/model/method, render hash, raw response hash and normalized
  candidate equivalence before using a repair.
- Mistral page index version is now 2.  It safely splits only consecutive
  paragraph-level numbered items that a provider merged into one large block;
  decimal values and non-consecutive markers are not split.  Boundaries prefer
  blank horizontal rows in the original page render; the original-PDF crop and
  independent review remain the final guard when no clean row is available.
- All 25 books were re-indexed at version 2, single-threaded, without another
  OCR API call.
- Full corpus audit passed after re-indexing:
  - documents: 25
  - pages: 6,720
  - OCR lines after the version-2 rebuild: 117,180
  - verified dropout repairs: 11 (`mistral`: 10, `openai`: 1)
- All 25 question maps were rebuilt.  For the 21 core chapter books:
  - candidates: 7,055
  - remaining reported missing drill numbers: 37
  - quarantined ambiguous answer links: 25
  - missing-answer links: 91
  These unresolved records remain `pending-review` / `needs-repair`; none are
  allowed into the formal student bank.
- Embedded-number recovery correctly produced independent space-vector fill
  questions 5–10, each with its own answer reference; calculation question 1
  on page 194 has a separate answer reference.
- Focused Python tests passed before the full rebuild: 104 tests.

## Core crop rebuild status — complete

The current candidate IDs required fresh original-PDF 300dpi review crops.
All 21 core books completed crop generation and structural audit:

1. `matha-114-data`
2. `matha-114-cubic-ineq`
3. `matha-114-trig-radian`
4. `matha-114-trig-graph`
5. `matha-114-matrix-equation`
6. `matha-114-classical-probability`
7. `matha-114-plane-vector`
8. `matha-114-linear-transform`
9. `matha-114-sine-cosine-law`
10. `matha-114-polynomial-quadratic`
11. `matha-114-cramer-circle`
12. `matha-114-line-inequality`
13. `matha-114-space-plane-line`
14. `matha-114-space-vector`
15. `matha-114-exp-log`
16. `matha-114-permutation`
17. `matha-114-conditional-probability`
18. `matha-114-real-number-line`
19. `matha-114-log-function`
20. `matha-114-sequence`
21. `matha-114-logic-set`

Aggregate crop inventory:

- question/stem crops: 7,055
- answer crops: 6,929
- figure crops: 3,157
- crop refusals: 0
- all 21 structural audits passed with no duplicate stem/answer groups

The audit is fail-closed and explicitly reports
`mathematicalCorrectnessVerified: false`.  The missing 126 answer crops are
not silently filled: they correspond to quarantined missing/ambiguous/source-
absent cases and remain outside the formal student bank.

## Repository changes not yet committed

- `scripts/ingest/repair-dropout-openai.py` (new)
- `scripts/ingest/index-mistral-pages.py`
- `scripts/ingest/audit-mistral-index.py`
- `scripts/ingest/build-book-map.py`
- `tests/test_mistral_ingest.py`
- `tests/test_ingest.py`
- this checkpoint

Post-reboot verification completed:

- Windows process creation recovered and Git contained only the expected files.
- The 10 remaining books were rendered one at a time and audited immediately.
- A second pass audited all 21 crop sets successfully.
- The 25-document / 6,720-page corpus audit passed again with 11 verified
  repairs (`mistral`: 10, `openai`: 1).
- Focused Python suite: 105 tests passed.  The OpenAI repair tool now verifies
  that a supplied JPEG is the requested PDF page before spending an API call;
  the real page-194 render passed with exact dimensions, MAE 0.931961, p99 29
  and ink cosine similarity 0.920972.
- Complete web/app suite: 223 tests passed.
- Complete ingest/figure suite: 126 tests passed.
- Python compilation and `git diff --check` passed.

Remaining before handoff is only final diff review, commit, push to `main`,
and GitHub Actions inspection through `gh`.  Do not use a browser.
