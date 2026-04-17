-- Stage 2 qualifying answers — saved separately from the stage 1 `submissions` row.
-- Loose link by email + company; no hard FK so anon can insert without RLS gymnastics.

create table if not exists public.deep_reviews (
  id                   uuid primary key default gen_random_uuid(),
  created_at           timestamptz not null default now(),

  -- Lead identity (copied from stage 1 client-side)
  first_name           text,
  email                text,
  company              text,

  -- Reporting snapshot (so Slack can show it without a join)
  score                integer,
  total_gbp_per_year   integer,

  -- Stage 2 answers
  pain_category        text,
  renewal_window       text,
  tech_spend_band      text,
  decision_maker       text,
  growth_goal          text,
  growth_goal_other    text,
  open_to_intro        text
);

create index if not exists deep_reviews_created_at_idx on public.deep_reviews (created_at desc);
create index if not exists deep_reviews_email_idx      on public.deep_reviews (email);

alter table public.deep_reviews enable row level security;

drop policy if exists "anon can insert deep_reviews" on public.deep_reviews;
create policy "anon can insert deep_reviews"
  on public.deep_reviews
  for insert
  to anon
  with check (true);

-- Trigger: forward new deep_reviews rows to the slack-notify edge function.
-- Reuses the same WEBHOOK_SECRET as submissions. The edge function branches
-- on the `table` field in the payload to render the right Slack message.
create or replace function public.notify_deep_review_to_slack()
returns trigger
language plpgsql
security definer
as $fn$
declare
  req_id bigint;
begin
  select net.http_post(
    url := 'https://kohnakdevwfudzgfjmab.supabase.co/functions/v1/slack-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <WEBHOOK_SECRET>'
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'deep_reviews',
      'schema', 'public',
      'record', row_to_json(NEW)
    )
  ) into req_id;
  return NEW;
end;
$fn$;

drop trigger if exists deep_reviews_to_slack on public.deep_reviews;
create trigger deep_reviews_to_slack
  after insert on public.deep_reviews
  for each row
  execute function public.notify_deep_review_to_slack();
