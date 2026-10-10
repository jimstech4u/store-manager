-- 0259 - The shop on WhatsApp: who is linked, and everything said
--
-- "A WhatsApp bot that store owners and workers chat with in natural language, to use the store
-- manager in their daily usage, securely." One business number is the bot. A member links their
-- own WhatsApp once, from inside the app (where they are already signed in): the app makes a short
-- code, they send it to the bot from their phone, and Meta's verified sender number is then theirs.
-- Every message after that acts AS THEM — a real session for their own account, so `auth.uid()`,
-- their role and their own permissions decide everything, exactly as in the app.
--
--   whatsapp_link_codes  a one-time code, made by a signed-in member, good for 15 minutes
--   whatsapp_links       a WhatsApp number linked to one member in one shop (revoked, never deleted)
--   whatsapp_sessions    the bot's session for a linked member (server only)
--   whatsapp_messages    every message in and out, and what it did (server only, append-only)
--
-- Only the member's own reads and their link codes are reachable from the app; the rest is the
-- server's, through the service key, and never the browser.

create table if not exists public.whatsapp_link_codes (
  code        text primary key,
  store_id    uuid not null references public.stores(id),
  user_id     uuid not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '15 minutes',
  used_at     timestamptz
);

create table if not exists public.whatsapp_links (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id),
  user_id     uuid not null,
  wa_phone    text not null,          -- E.164 without the +, as Meta sends it
  display     text,                   -- the WhatsApp profile name, when Meta sends one
  linked_at   timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid
);
-- A number speaks for one person at a time.
create unique index if not exists whatsapp_links_one_number
  on public.whatsapp_links (wa_phone) where revoked_at is null;

create table if not exists public.whatsapp_sessions (
  user_id        uuid primary key,
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  updated_at     timestamptz not null default now()
);

create table if not exists public.whatsapp_messages (
  id          uuid primary key default gen_random_uuid(),
  wa_message_id text unique,          -- Meta's id: a retried webhook is the same message
  direction   text not null check (direction in ('in', 'out')),
  wa_phone    text not null,
  store_id    uuid,
  user_id     uuid,
  kind        text not null default 'text',
  body        text,
  tools       jsonb,                  -- what the assistant called, with what, and what came back
  created_at  timestamptz not null default now()
);
create index if not exists whatsapp_messages_phone on public.whatsapp_messages (wa_phone, created_at desc);

alter table public.whatsapp_link_codes enable row level security;
alter table public.whatsapp_links enable row level security;
alter table public.whatsapp_sessions enable row level security;
alter table public.whatsapp_messages enable row level security;

-- A member sees the numbers linked to them; owners and managers see their shop's.
drop policy if exists whatsapp_links_read on public.whatsapp_links;
create policy whatsapp_links_read on public.whatsapp_links
  for select using (user_id = auth.uid() or public.has_permission(store_id, 'store.settings'));

-- ─── From the app ──────────────────────────────────────────────────────────────────────────
-- A code to send to the bot. Six digits: typed on a phone, read off a screen.
create or replace function public.create_whatsapp_link_code(p_store_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_code text;
begin
  if auth.uid() is null or not public.is_store_member(p_store_id) then
    raise exception 'sign in to this shop first' using errcode = '42501';
  end if;
  -- Any earlier unused code of theirs stops working.
  update public.whatsapp_link_codes set used_at = now()
   where user_id = auth.uid() and used_at is null;
  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.whatsapp_link_codes where code = v_code and used_at is null);
  end loop;
  insert into public.whatsapp_link_codes (code, store_id, user_id) values (v_code, p_store_id, auth.uid());
  return v_code;
end;
$function$;
revoke all on function public.create_whatsapp_link_code(uuid) from public, anon;
grant execute on function public.create_whatsapp_link_code(uuid) to authenticated;

-- The numbers linked in this shop: a member's own, or all of them for whoever runs the shop.
create or replace function public.my_whatsapp_links(p_store_id uuid)
returns table(id uuid, wa_phone text, display text, linked_at timestamptz, user_id uuid, mine boolean, member_name text)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select l.id, l.wa_phone, l.display, l.linked_at, l.user_id, l.user_id = auth.uid(),
         coalesce((select coalesce(nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), ''), u.email)
                     from auth.users u where u.id = l.user_id), 'Member')
    from public.whatsapp_links l
   where l.store_id = p_store_id
     and l.revoked_at is null
     and public.is_store_member(p_store_id)
     and (l.user_id = auth.uid() or public.has_permission(p_store_id, 'store.settings'))
   order by l.linked_at desc;
$function$;
revoke all on function public.my_whatsapp_links(uuid) from public, anon;
grant execute on function public.my_whatsapp_links(uuid) to authenticated;

-- Unlinked: a member their own number, an owner or manager anybody's in the shop.
create or replace function public.revoke_whatsapp_link(p_link_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_link record;
begin
  select * into v_link from public.whatsapp_links where id = p_link_id and revoked_at is null;
  if not found then
    return;
  end if;
  if v_link.user_id <> auth.uid() and not public.has_permission(v_link.store_id, 'store.settings') then
    raise exception 'only the member or the owner can unlink this number' using errcode = '42501';
  end if;
  update public.whatsapp_links set revoked_at = now(), revoked_by = auth.uid() where id = p_link_id;
  -- And the bot's session for them goes, so nothing keeps acting on a number that was unlinked.
  delete from public.whatsapp_sessions s
   where s.user_id = v_link.user_id
     and not exists (select 1 from public.whatsapp_links l where l.user_id = v_link.user_id and l.revoked_at is null);
end;
$function$;
revoke all on function public.revoke_whatsapp_link(uuid) from public, anon;
grant execute on function public.revoke_whatsapp_link(uuid) to authenticated;

notify pgrst, 'reload schema';
