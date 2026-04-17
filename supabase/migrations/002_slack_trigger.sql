-- Database trigger that forwards each new submission to the `slack-notify` edge function.
-- Requires:
--   - pg_net extension enabled (handled below)
--   - Edge function `slack-notify` deployed
--   - WEBHOOK_SECRET set in Edge Function secrets (Supabase → Project Settings → Edge Functions → Secrets)
--
-- IMPORTANT: replace <WEBHOOK_SECRET> below with the actual secret value before running,
-- or use a Postgres setting/vault entry in production. The secret lives in the function body
-- so keep it out of source control for real deployments — this file exists as a reproducible
-- template only.

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_submission_to_slack()
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
      'table', 'submissions',
      'schema', 'public',
      'record', row_to_json(NEW)
    )
  ) into req_id;
  return NEW;
end;
$fn$;

drop trigger if exists submissions_to_slack on public.submissions;
create trigger submissions_to_slack
  after insert on public.submissions
  for each row
  execute function public.notify_submission_to_slack();
