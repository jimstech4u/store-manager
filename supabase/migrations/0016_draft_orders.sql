-- =====================================================================================
-- 0016 — Draft orders: unsettled receipts, shareable between staff by code
--
-- REVERSES a decision recorded in STORE_MANAGER_PLAN.md §12.
--
-- That section said open orders would live on the device (state-stack → IndexedDB) and become a
-- sale only when settled. The reasoning was sound for what was known then — offline first, and
-- keep unsettled drafts out of the ledger CRODS reads.
--
-- It cannot survive the sharing requirement: a salesman with five pending orders must be able to
-- hand one to a colleague by reading out a code, and a code that exists only on the first
-- salesman's phone cannot be claimed on the second's. Sharing needs a server-side record.
--
-- What is kept from the original reasoning: drafts are their OWN tables, never `sales` rows with
-- a draft status. They move no stock, create no obligation, and appear in no ledger. CRODS never
-- has to learn to ignore them, because they are not there. A draft becomes real exactly once, at
-- settle, through settle_sale.
--
-- Offline is preserved rather than lost: the device keeps its local copy as before and pushes it
-- when a connection exists. What requires the network is SHARING, which is honest — you cannot
-- hand something to a colleague's phone with no network between them either.
-- =====================================================================================

create table if not exists public.draft_orders (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  store_customer_id uuid references public.store_customers (id) on delete set null,
  /** Shown when no customer is attached — a walk-in still needs a name on the tab. */
  label             text,

  /**
   * The share code. Short enough to read aloud across a counter, and drawn from an alphabet with
   * no 0/O or 1/I/L, because it WILL be read aloud and mis-heard characters would send a
   * colleague to the wrong order — or to none, which is the better failure of the two.
   */
  code              text not null,

  status            text not null default 'open'
                      check (status in ('open', 'settled', 'cancelled')),

  fee_amount        money_amt not null default 0 check (fee_amount >= 0),
  fee_label         text,
  note              text,

  /** Who is currently holding it. Changes when a colleague claims the code. */
  held_by           uuid references auth.users (id),
  created_by        uuid default auth.uid(),

  /**
   * Who actually took the money. The requirement is explicit: the person who settled is the last
   * person who confirmed it, not whoever started the order — that is who the till is reconciled
   * against.
   */
  settled_by        uuid references auth.users (id),
  settled_at        timestamptz,
  settled_sale_id   uuid references public.sales (id),

  client_uuid       uuid unique,
  amend_reason      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- A code only needs to be unique among the codes currently in play. Reusing one whose order was
-- settled last month is fine and keeps codes short.
create unique index if not exists draft_orders_open_code
  on public.draft_orders (store_id, code) where status = 'open';
create index if not exists draft_orders_store_status_idx
  on public.draft_orders (store_id, status, created_at desc);
create index if not exists draft_orders_held_by_idx on public.draft_orders (held_by);

create trigger touch_updated_at before update on public.draft_orders
  for each row execute function public.tg_touch_updated_at();
create trigger audit after insert or update or delete on public.draft_orders
  for each row execute function public.tg_audit();

create table if not exists public.draft_order_lines (
  id              uuid primary key default gen_random_uuid(),
  draft_order_id  uuid not null references public.draft_orders (id) on delete cascade,
  product_id      uuid not null references public.products (id) on delete restrict,
  entered_qty     qty  not null check (entered_qty > 0),
  entered_pack_id uuid references public.product_packs (id),
  unit_price      money_amt not null check (unit_price >= 0),
  line_total      money_amt not null check (line_total >= 0),
  containers_out  qty not null default 0,
  position        int not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists draft_order_lines_order_idx
  on public.draft_order_lines (draft_order_id, position);

alter table public.draft_orders      enable row level security;
alter table public.draft_order_lines enable row level security;

-- Every member of the store can see and work on drafts. Deliberately not restricted to the
-- holder: a counter is a shared workspace, and a customer whose salesman stepped away must still
-- be servable by whoever is there.
create policy drafts_read on public.draft_orders
  for select to authenticated using (public.is_store_member(store_id));
create policy drafts_write on public.draft_orders
  for all to authenticated
  using (public.has_permission(store_id, 'sales.record'))
  with check (public.has_permission(store_id, 'sales.record'));

create policy draft_lines_rw on public.draft_order_lines
  for all to authenticated
  using (exists (select 1 from public.draft_orders d
                 where d.id = draft_order_id and public.is_store_member(d.store_id)))
  with check (exists (select 1 from public.draft_orders d
                 where d.id = draft_order_id
                   and public.has_permission(d.store_id, 'sales.record')));

-- ─── Code generation ────────────────────────────────────────────────────────────────

create or replace function public.generate_draft_code(p_store_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- No 0/O, 1/I/L. These codes get read aloud across a noisy counter.
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code     text;
  v_try      int := 0;
begin
  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;

    exit when not exists (
      select 1 from public.draft_orders
       where store_id = p_store_id and code = v_code and status = 'open'
    );

    v_try := v_try + 1;
    if v_try > 50 then
      -- 31^5 is ~28 million; 50 collisions means something is wrong with the assumption, not
      -- with luck. Fail rather than loop forever.
      raise exception 'could not allocate a share code' using errcode = '55000';
    end if;
  end loop;

  return v_code;
end;
$$;

-- ─── Save a draft (create or replace its lines) ─────────────────────────────────────
--
-- Whole-order upsert rather than per-line calls. The client holds the order in memory and pushes
-- the current state; sending each edit separately would mean a dropped connection could leave a
-- draft half-updated, showing a quantity nobody typed.
--
-- p_lines: [{product_id, qty, pack_id, unit_price, line_total, containers_out}]

create or replace function public.save_draft_order(
  p_store_id    uuid,
  p_lines       jsonb,
  p_draft_id    uuid default null,
  p_customer_id uuid default null,
  p_label       text default null,
  p_fee_amount  money_amt default 0,
  p_fee_label   text default null,
  p_note        text default null,
  p_client_uuid uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid := p_draft_id;
  v_line jsonb;
  v_pos  int := 0;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to record sales' using errcode = '42501';
  end if;

  if v_id is null and p_client_uuid is not null then
    select id into v_id from public.draft_orders where client_uuid = p_client_uuid;
  end if;

  if v_id is null then
    insert into public.draft_orders (store_id, store_customer_id, label, code,
                                     fee_amount, fee_label, note, held_by, client_uuid)
    values (p_store_id, p_customer_id, nullif(trim(p_label), ''),
            public.generate_draft_code(p_store_id),
            coalesce(p_fee_amount, 0), nullif(trim(p_fee_label), ''),
            nullif(trim(p_note), ''), auth.uid(), p_client_uuid)
    returning id into v_id;
  else
    update public.draft_orders
       set store_customer_id = p_customer_id,
           label      = nullif(trim(p_label), ''),
           fee_amount = coalesce(p_fee_amount, 0),
           fee_label  = nullif(trim(p_fee_label), ''),
           note       = nullif(trim(p_note), '')
     where id = v_id and status = 'open';

    if not found then
      raise exception 'that order is no longer open' using errcode = '22023';
    end if;
  end if;

  -- Replace the lines wholesale: the client's copy is the truth for an open draft, and merging
  -- would need conflict rules for a workspace that has no concurrent editors by design.
  delete from public.draft_order_lines where draft_order_id = v_id;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.draft_order_lines (draft_order_id, product_id, entered_qty,
                                          entered_pack_id, unit_price, line_total,
                                          containers_out, position)
    values (v_id,
            (v_line ->> 'product_id')::uuid,
            (v_line ->> 'qty')::qty,
            nullif(v_line ->> 'pack_id', '')::uuid,
            (v_line ->> 'unit_price')::money_amt,
            (v_line ->> 'line_total')::money_amt,
            coalesce((v_line ->> 'containers_out')::qty, 0),
            v_pos);
    v_pos := v_pos + 1;
  end loop;

  return v_id;
end;
$$;

-- ─── Claim a shared order ───────────────────────────────────────────────────────────

create or replace function public.claim_draft_order(p_store_id uuid, p_code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to take over an order' using errcode = '42501';
  end if;

  update public.draft_orders
     set held_by = auth.uid()
   where store_id = p_store_id
     and upper(trim(p_code)) = code
     and status = 'open'
  returning id into v_id;

  if v_id is null then
    raise exception 'no open order with that code' using errcode = 'P0002';
  end if;

  return v_id;
end;
$$;

-- ─── Settle a draft ─────────────────────────────────────────────────────────────────
--
-- The one moment a draft becomes real: stock moves, obligations are created, money is recorded.
-- `settled_by` is the caller — the last person to confirm it, which is who the till is
-- reconciled against, not whoever first started the order.

create or replace function public.settle_draft_order(
  p_draft_id    uuid,
  p_payments    jsonb default '[]'::jsonb,
  p_occurred_at timestamptz default now(),
  p_client_uuid uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_draft record;
  v_lines jsonb;
  v_sale  uuid;
begin
  select * into v_draft from public.draft_orders where id = p_draft_id;
  if not found then
    raise exception 'that order no longer exists' using errcode = 'P0002';
  end if;

  if v_draft.status = 'settled' then
    return v_draft.settled_sale_id;      -- already done; a retry must not sell twice
  end if;
  if v_draft.status <> 'open' then
    raise exception 'that order was cancelled' using errcode = '22023';
  end if;

  if not public.has_permission(v_draft.store_id, 'sales.record') then
    raise exception 'you do not have permission to settle an order' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id',     l.product_id,
           'qty',            l.entered_qty,
           'pack_id',        l.entered_pack_id,
           'unit_price',     l.unit_price,
           'line_total',     l.line_total,
           'containers_out', l.containers_out
         ) order by l.position), '[]'::jsonb)
    into v_lines
    from public.draft_order_lines l
   where l.draft_order_id = p_draft_id;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'this order has nothing in it' using errcode = '22023';
  end if;

  v_sale := public.settle_sale(
    v_draft.store_id, v_lines, p_payments, v_draft.store_customer_id,
    v_draft.fee_amount, v_draft.fee_label, v_draft.note, p_occurred_at,
    coalesce(p_client_uuid, v_draft.client_uuid)
  );

  update public.draft_orders
     set status = 'settled',
         settled_by = auth.uid(),
         settled_at = now(),
         settled_sale_id = v_sale
   where id = p_draft_id;

  return v_sale;
end;
$$;

-- ─── Open orders, searchable ────────────────────────────────────────────────────────

create or replace function public.search_draft_orders(
  p_store_id uuid,
  p_query    text default null,
  p_limit    int default 50
)
returns table (
  id            uuid,
  code          text,
  label         text,
  customer_id   uuid,
  customer_name text,
  total         money_amt,
  line_count    bigint,
  held_by       uuid,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select d.id,
         d.code,
         d.label,
         d.store_customer_id,
         sc.display_name,
         (coalesce((select sum(l.line_total) from public.draft_order_lines l
                     where l.draft_order_id = d.id), 0) + d.fee_amount)::money_amt,
         (select count(*) from public.draft_order_lines l where l.draft_order_id = d.id),
         d.held_by,
         d.created_at
  from public.draft_orders d
  cross join q
  left join public.store_customers sc on sc.id = d.store_customer_id
  left join public.identities i on i.id = sc.identity_id
  where d.store_id = p_store_id
    and d.status = 'open'
    and public.is_store_member(p_store_id)
    and (
      q.term is null
      or d.code = upper(trim(q.term))
      or d.label ilike '%' || q.term || '%'
      or sc.display_name ilike '%' || q.term || '%'
      or i.phone like '%' || public.normalize_phone(q.term) || '%'
    )
  order by d.created_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

grant execute on function public.generate_draft_code(uuid)                                   to authenticated;
grant execute on function public.save_draft_order(uuid, jsonb, uuid, uuid, text, money_amt, text, text, uuid) to authenticated;
grant execute on function public.claim_draft_order(uuid, text)                               to authenticated;
grant execute on function public.settle_draft_order(uuid, jsonb, timestamptz, uuid)          to authenticated;
grant execute on function public.search_draft_orders(uuid, text, int)                        to authenticated;
