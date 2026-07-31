-- Add the two fields the form now captures:
--   brand_trading_name: umbrella brand a venue trades under (e.g. "TGI Fridays"
--                       for TGI Fridays Cardiff). Optional — form defaults to
--                       the venue name if the operator doesn't distinguish.
--   site_count:         exact number of physical sites the brand runs. Replaces
--                       the coarse sites band ("1", "2-5", "6-20", "20+") for
--                       new submissions. Legacy `sites` column stays for
--                       backward compat and still carries the bandified value
--                       (auto-derived from site_count on submit).
--
-- Both are nullable — older rows and any submissions from before the form
-- change simply won't have them.

alter table public.submissions
  add column if not exists brand_trading_name text,
  add column if not exists site_count integer check (site_count is null or site_count >= 1);
