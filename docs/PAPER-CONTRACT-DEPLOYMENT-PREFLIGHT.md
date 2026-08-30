# Paper contract deployment preflight

## Historical hazard

Migration `202608300006` must never use its former
`NOT NULL DEFAULT clock_timestamp()` form because that would make historical
ink look new. The old preflight that required every remote migration column to
be empty was only valid before the first deployment; it is not a current
delivery check.

## Current authority

As of 2026-08-31, corrected migrations `202608300001` through
`202608300011` are deployed. Verify current delivery with:

```powershell
python scripts/verify-supabase-runtime-delivery.py --output <repo-external-json>
```

The verifier fails closed unless local and remote migration IDs are exactly
001–011, `openai-proxy` is active at the expected version, every downloaded
production TypeScript file matches the checkout by SHA-256, OPTIONS returns
204, and an unauthenticated POST returns 401. It does not use a browser or call
OpenAI. Keep the evidence outside the public repository.

Before a future migration push, inspect the SQL diff and run the PostgreSQL
integration suite. Do not run the old empty-remote assertion as though an
already-deployed project should still have no remote migrations.
