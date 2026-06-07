-- Captures the single yes/no knowledge-base question added between the
-- WhatsApp question and the gate ("Do you have your own knowledge base?").
-- Used to identify operators without a team knowledge base — the natural
-- audience for the free Stacked Chat offering. Three states: null = not
-- answered (legacy / older submissions), true / false = explicit answer.
alter table public.submissions add column if not exists has_knowledge_base boolean;
