-- Require last name and phone number at the gate step. These map to the portal's
-- contact_name (first + last concatenated) and phone_number fields on business_submissions.
alter table public.submissions  add column if not exists last_name    text;
alter table public.submissions  add column if not exists phone_number text;
alter table public.deep_reviews add column if not exists last_name    text;
alter table public.deep_reviews add column if not exists phone_number text;
