-- Stacked Field visits with a contact email -> field-notify -> Zoho lead.
--
-- Run AFTER the field-notify edge function is deployed (verify_jwt = false).
-- Paste the whole file into the SQL editor and run it once.
--
-- No secret in this file: the trigger reuses the WEBHOOK_SECRET bearer that is
-- already inside notify_submission_to_slack (002_slack_trigger.sql), copied
-- across inside the database.
--
-- Fires on new visits, and on edits only when the tech or contact details
-- changed. Visits without a contact email are ignored (Chris's call,
-- 31 Oct 2026: Zoho leads are matched on email).

create extension if not exists pg_net with schema extensions;

do $do$
declare
  secret text := (regexp_match(pg_get_functiondef('public.notify_submission_to_slack'::regproc), 'Bearer ([^'']+)'''))[1];
begin
  if secret is null then raise exception 'No WEBHOOK_SECRET found in notify_submission_to_slack'; end if;
  execute format($f$
    create or replace function public.notify_field_visit_to_zoho()
    returns trigger language plpgsql security definer as $fn$
    begin
      if NEW.source <> 'field' or NEW.contact_email is null then return NEW; end if;
      if TG_OP = 'UPDATE' and NEW.stack is not distinct from OLD.stack
         and NEW.contact_email is not distinct from OLD.contact_email
         and NEW.contact_name is not distinct from OLD.contact_name
         and NEW.contact_phone is not distinct from OLD.contact_phone then
        return NEW;
      end if;
      perform net.http_post(
        url := 'https://kohnakdevwfudzgfjmab.supabase.co/functions/v1/field-notify',
        headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', %L),
        body := jsonb_build_object('type', TG_OP, 'table', 'field_visits', 'record', row_to_json(NEW))
      );
      return NEW;
    end;
    $fn$;
  $f$, 'Bearer ' || secret);
end
$do$;

drop trigger if exists field_visits_to_zoho on public.field_visits;
create trigger field_visits_to_zoho
  after insert or update on public.field_visits
  for each row execute function public.notify_field_visit_to_zoho();

-- Back-date: send every existing field visit that has a contact email.
-- (A no-op update fires the trigger only when something changed, so call
-- the function directly.)
do $do$
declare
  secret text := (regexp_match(pg_get_functiondef('public.notify_submission_to_slack'::regproc), 'Bearer ([^'']+)'''))[1];
  v record;
begin
  for v in select * from public.field_visits where source = 'field' and contact_email is not null loop
    perform net.http_post(
      url := 'https://kohnakdevwfudzgfjmab.supabase.co/functions/v1/field-notify',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
      body := jsonb_build_object('type', 'INSERT', 'table', 'field_visits', 'record', row_to_json(v))
    );
  end loop;
end
$do$;
