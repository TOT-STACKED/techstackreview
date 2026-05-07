-- Add a free-text venue location (town or city) collected at the gate step.
-- Mirrored on deep_reviews so stage-2 records carry the same identity fields.
alter table public.submissions  add column if not exists location text;
alter table public.deep_reviews add column if not exists location text;
