-- Tech Stack Benchmark — initial schema
-- Run this in the Supabase SQL editor (Project → SQL → New query).

create table if not exists public.submissions (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),

  -- Venue profile
  venue_type           text,
  sites                text,
  segment              text,

  -- Stack (full per-category selections, incl "other" free-text)
  stack                jsonb not null default '{}'::jsonb,

  -- Lead details
  first_name           text,
  email                text,
  company              text,
  consent              boolean default false,

  -- Computed report summary (for quick querying & Slack payload)
  score                integer,
  coverage_pct         integer,
  total_gbp_per_year   integer,
  total_hrs_per_week   integer,
  gap_count            integer,
  gap_categories       text[]
);

-- Helpful indexes for dashboards / CRM sync
create index if not exists submissions_created_at_idx on public.submissions (created_at desc);
create index if not exists submissions_email_idx      on public.submissions (email);
create index if not exists submissions_segment_idx    on public.submissions (segment);

-- Enable Row Level Security
alter table public.submissions enable row level security;

-- Allow anonymous INSERT only (what the public frontend needs).
-- Reads are blocked for anon — use the service role key (or a dashboard) to view leads.
drop policy if exists "anon can insert submissions" on public.submissions;
create policy "anon can insert submissions"
  on public.submissions
  for insert
  to anon
  with check (true);

-- Optional: basic sanity check to trim obvious junk
drop policy if exists "reject empty emails" on public.submissions;
-- (No-op separate policy — kept as comment. Enforce in the app or via a trigger if needed.)
