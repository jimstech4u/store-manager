-- 0260 - The WhatsApp assistant proposes; the person's YES does it
--
-- "Make it full capabilities, less going to the app for anything." The assistant may now record
-- sales, payments, deliveries, charges, deposits, empties, expenses and counts — and it does none of
-- them itself. A model can only write a row here: the action, fully worked out by the server (ids,
-- shapes, prices, totals) and the exact summary shown to the person. Only that person's YES, read by
-- the server and not by the model, runs it — as them, through the same functions the app calls, so
-- their permissions and every rule in the database still apply.
--
-- One open action per number; a new proposal replaces the last, and they lapse after 10 minutes, so
-- a stray "yes" tomorrow does nothing. `done_at` is claimed in one UPDATE, so two YESes run it once.
-- Server only: no policy lets the app or a browser see or write these.

create table if not exists public.whatsapp_pending (
  id          uuid primary key default gen_random_uuid(),
  wa_phone    text not null,
  store_id    uuid not null references public.stores(id),
  user_id     uuid not null,
  action      text not null,
  args        jsonb not null,
  summary     text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes',
  done_at     timestamptz,
  outcome     text        -- 'done', 'cancelled', 'replaced', or what went wrong
);
create index if not exists whatsapp_pending_open
  on public.whatsapp_pending (wa_phone, created_at desc) where done_at is null;

alter table public.whatsapp_pending enable row level security;
