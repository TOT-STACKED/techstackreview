-- Tech Stack Benchmark — per-product NPS collection
-- Adds a flat map of {tool_name: 0..10} per submission plus a rounded average
-- so the approved-reporting dashboard can query sentiment without digging into
-- the nested `stack` JSON. Run after 001_init.sql.

alter table public.submissions
  add column if not exists product_nps jsonb not null default '{}'::jsonb;

alter table public.submissions
  add column if not exists nps_avg integer;

-- Sanity-bound the average to the NPS range.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'submissions_nps_avg_range'
  ) then
    alter table public.submissions
      add constraint submissions_nps_avg_range
      check (nps_avg is null or (nps_avg between 0 and 10));
  end if;
end$$;

-- Index to surface promoters / detractors quickly in the dashboard.
create index if not exists submissions_nps_avg_idx
  on public.submissions (nps_avg);
