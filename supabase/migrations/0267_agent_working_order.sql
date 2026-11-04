-- 0267 - The agent builds an order where the till can see it
--
-- "The chat misses out on the order I sent. Store Manager has an online draft order the chat should
-- use, to keep the order, the price and the quantity, because the AI cannot keep that without
-- hallucinating. The draft solves it, and helps build the order before it is committed, and it has a
-- share code to follow the order."
--
-- A model's memory of a long order is a guess that grows with the order. So an order built in a chat
-- is an open order on the till from its first item: every change is saved there, read back from there,
-- and finished there. The chat only remembers WHICH order it is working on.

alter table public.whatsapp_links
  add column working_draft_id uuid references public.draft_orders(id) on delete set null;

notify pgrst, 'reload schema';
