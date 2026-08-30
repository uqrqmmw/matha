# Paper submit attempt protocol

This protocol arbitrates the instant a full-paper run becomes submitted. It is
database-only, authenticated, append-only, and fail-closed. The browser may
retry the same attempt after a timeout without creating a second accepted run.

## RPCs

All three functions require an approved authenticated MathA user. They return
one JSON object (or `null` for an unknown lookup) with:

`attempt_id`, `run_id`, `source_id`, `status`, `remaining_ms`,
`ink_snapshot_sha256`, `page_manifest`, `submitted_at`, `accepted_at`, `canceled_at`, and
`run_created_app_version`, plus `decision_reason`, `winner_attempt_id`, and a
nested `winner` accepted receipt when another device already won the run.

### Accept

```text
matha_paper_submit_accept(
  p_attempt_id text,
  p_run_id text,
  p_source_id text,
  p_remaining_ms bigint,
  p_ink_snapshot_sha256 text,
  p_submitted_at bigint,
  p_run_created_app_version text,
  p_page_manifest jsonb
) -> jsonb
```

- The first valid attempt for `(user_id, run_id)` becomes `accepted`.
- `p_page_manifest` is not browser authority. While holding the same per-user
  advisory lock used by ink writes, the RPC reloads every referenced cloud
  `ink_sessions` row, verifies page/qid/client/revision/server-updated-at and
  the stored stroke digest, and stores the canonical result in the accepted
  receipt. Missing, duplicate, stale, foreign, or non-contiguous pages fail
  closed.
- A retry with the same attempt and identical payload returns the same row.
- Reusing an accepted attempt ID with changed payload fails closed.
- A different attempt after a winner exists becomes an immutable `canceled`
  tombstone with `decision_reason = superseded-by-accepted-attempt`, the
  `winner_attempt_id`, and the complete accepted `winner` receipt. The losing
  device must remain locked and continue through the winner's grading/result;
  it must never restore the paper to active.
- An attempt previously canceled never becomes accepted.

### Lookup

```text
matha_paper_submit_lookup(p_attempt_id text, p_run_id text) -> jsonb | null
```

Lookup is always scoped to `auth.uid()`. A caller cannot discover another
learner's attempts, even when the IDs are known.

### Cancel

```text
matha_paper_submit_cancel(
  p_attempt_id text,
  p_run_id text,
  p_source_id text,
  p_remaining_ms bigint,
  p_ink_snapshot_sha256 text,
  p_submitted_at bigint,
  p_run_created_app_version text
) -> jsonb
```

Cancel is atomic even when the server has never seen the attempt. It receives
the exact same immutable payload as accept and seals the complete payload into
a canceled tombstone. If another device already accepted the run, even an
unknown cancellation becomes `superseded-by-accepted-attempt` and returns that
winner receipt; it cannot reopen ink. If the same attempt was already accepted,
cancel with the same payload returns the accepted decision unchanged; a
committed submission is not rolled back. A payload mismatch fails closed. A
new attempt ID for the same run may still be accepted if no attempt for that
run has been accepted. Only a row whose reason is exactly
`client-canceled-before-accept` authorizes a client to restore the local paper
to active.

## Concurrency and security invariants

- Accept and cancel take the same per-user transaction advisory lock.
- A partial unique index permits only one accepted row per user/run.
- Rows cannot be updated; a trigger rejects every update. Normal app roles have
  no direct delete grant or policy, while the declared `auth.users` foreign-key
  cascade remains usable for account deletion.
- RLS permits authenticated users to select only their own rows and only while
  present in `app_users`.
- `anon`, `authenticated`, and `service_role` have no direct write grants.
- Only `authenticated` receives RPC execution. `service_role` is explicitly
  not granted these learner-decision RPCs, but it has table `SELECT` so the
  Edge grading authority can verify the accepted user/run/attempt receipt. It
  receives no table `INSERT`, `UPDATE`, or `DELETE`.

The base protocol is in
`supabase/migrations/202608300002_create_paper_submit_attempts.sql`; the exact
accepted-page binding is added by
`supabase/migrations/202608300005_bind_accepted_paper_manifest.sql`. Both are
mirrored in `supabase/schema.sql`.

## Browser durability gate

The browser never fabricates an accepted receipt, including for sources that
already have a local answer key. After either its own attempt or another
device's winner is accepted, it keeps ink locked, persists `status = grading`,
awaits `syncPush()`, and reads `app_state` back. The answer key and grader are
not called until the remote run contains the same accepted attempt payload and
a grading-or-later status. Restore, grading, correction, result view, and PDF
generation load only the exact immutable winner manifest; another device's
ink is preserved for rescue but never mixed into the official artifact. A
timeout or mismatched readback stays locked on a retry screen. Cross-device
merge flattens a superseded receipt's nested winner into attempt history, so
only `client-canceled-before-accept` can reopen ink.
