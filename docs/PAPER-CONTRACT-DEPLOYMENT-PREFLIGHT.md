# Paper contract deployment preflight

Migration `202608300006` must never be deployed in its former
`NOT NULL DEFAULT clock_timestamp()` form: that form makes historical ink look
new. Before any migration push, run:

```powershell
python scripts/check_paper_contract_deployment_preflight.py
```

The check reads the linked Supabase migration list and fails closed if any
remote migration exists, especially `202608300006`. A non-empty remote column
requires explicit investigation; do not infer safety from local files.

Verified locally on 2026-08-30 (Asia/Taipei): Supabase returned local
`202608300001` through `202608300009` with an empty `remote` value for every
row. The preflight printed:

`PASS: remote migration column is empty; corrected 006 has not been applied remotely`

This evidence is point-in-time only. Re-run immediately before deployment.
