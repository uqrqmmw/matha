-- Service-role-only Galaxy runtime/capability evidence bucket.
-- Idempotent and deliberately creates no storage.objects policy.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'matha-audit-private',
  'matha-audit-private',
  false,
  14680064,
  array['application/pdf', 'application/json']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated read matha audit private" on storage.objects;
drop policy if exists "approved read matha audit private" on storage.objects;
drop policy if exists "public read matha audit private" on storage.objects;
drop policy if exists "own matha audit private" on storage.objects;
