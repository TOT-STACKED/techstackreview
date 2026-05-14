-- Captures the single yes/no comms question added between the category steps
-- and the gate ("Do you use WhatsApp for team communications?"). Three states:
-- null = not answered (legacy / older submissions), true / false = explicit
-- answer collected at submit time.
alter table public.submissions add column if not exists uses_whatsapp boolean;
