-- =====================================================================================
-- 0166 — An order has an ANSWER, and the answer has a history
--
-- Accepting an order left it exactly as it was: `status = 'open'`, because that is what a draft at
-- the till is. So the queue went on listing it, the badge went on counting it, and it could be
-- accepted again — a second claim, a second customer record, and nobody able to say from the data
-- whether the shop had answered at all.
--
-- The mistake was reading the SALE's lifecycle as the shop's answer. They are different things and
-- they end at different times:
--
--   THE ANSWER is what the shop said when it read the order: accepted, or declined. It happens once,
--   in a moment, and after it the order is no longer waiting on anybody.
--
--   THE SALE is what happens next — quantities confirmed at the till, money taken, stock moved — and
--   an accepted order sits at `status = 'open'` for as long as that takes, which may be an hour.
--
-- So `answer` is its own column, and the queue is the orders with no answer yet.
--
-- REOPENING IS A REAL EVENT, NOT AN UNDO. A shop that declined by mistake needs a way back, and the
-- way back must leave a mark: who reopened it, when, and why. It asks for `sales.amend` — the same
-- permission as changing a sale after the fact, and for the same reason. Every answer, including
-- every reopening, is appended to a log that is never updated and never deleted, so "this order was
-- accepted, then reopened, then declined" is a question the data can answer.
-- =====================================================================================

-- ── The answer ──────────────────────────────────────────────────────────────────────

alter table public.draft_orders
  add column if not exists answer      text check (answer in ('accepted', 'declined')),
  add column if not exists answered_at timestamptz,
  add column if not exists answered_by uuid references auth.users(id);

comment on column public.draft_orders.answer is
  'For source=online: what the shop said when it read this order. NULL means it is still waiting on an answer — which is what the queue and the badge count. Distinct from `status`, which follows the SALE: an accepted order stays open until it is settled at the till.';

create index if not exists draft_orders_waiting_idx
  on public.draft_orders (store_id)
  where source = 'online' and answer is null and status = 'open';

-- ── The history ─────────────────────────────────────────────────────────────────────

/*
 * APPEND-ONLY, like every other record of what a shop did. No updates and no deletes: the point of
 * this table is the sequence, and a sequence you can edit is a sequence that proves nothing.
 */
create table if not exists public.online_order_events (
  id             uuid primary key default gen_random_uuid(),
  draft_order_id uuid not null references public.draft_orders(id) on delete cascade,
  store_id       uuid not null references public.stores(id) on delete cascade,
  action         text not null check (action in ('placed', 'accepted', 'declined', 'reopened')),
  -- Null for `placed`: that one is the shopper's doing, and they are not a member of this shop.
  actor          uuid references auth.users(id),
  reason         text,
  at             timestamptz not null default now()
);

comment on table public.online_order_events is
  'Every answer a shop gave to a marketplace order, in order, including reopenings. Append-only: read to show a history, never updated.';

create index if not exists online_order_events_order_idx
  on public.online_order_events (draft_order_id, at);

alter table public.online_order_events enable row level security;

drop policy if exists online_order_events_read on public.online_order_events;
create policy online_order_events_read on public.online_order_events
  for select using (public.has_permission(store_id, 'sales.record'));

/*
 * Written only by the functions below, which is why there is no INSERT policy. A client that could
 * append to this directly could write a history that never happened, which is worse than no history
 * at all.
 */

-- ── Placing records itself ──────────────────────────────────────────────────────────

create or replace function public.place_online_order(
  p_store_code text,
  p_lines      jsonb,
  p_note       text default null
)
returns table (code text, total money_amt, repriced integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store_id   uuid;
  v_account    public.customer_accounts%rowtype;
  v_draft_id   uuid;
  v_code       text;
  v_line       jsonb;
  v_position   integer := 0;
  v_repriced   integer := 0;
  v_total      numeric := 0;
  v_product    record;
  v_tier_price numeric;
  v_unit_price numeric;
  v_qty        numeric;
  v_shown      numeric;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send this order';
  end if;

  select * into v_account from public.customer_accounts where user_id = auth.uid();
  if v_account.user_id is null then
    raise exception 'Finish your shopper account first';
  end if;

  select s.id into v_store_id
  from public.stores s
  where s.code = upper(btrim(p_store_code))
    and s.is_public
    and s.onboarded_at is not null;

  if v_store_id is null then
    raise exception 'That shop is not open on the marketplace';
  end if;

  if public.is_store_member(v_store_id) then
    raise exception 'You work at this shop — start this sale at the till instead';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception 'There is nothing in this order';
  end if;

  v_code := public.generate_draft_code(v_store_id);

  insert into public.draft_orders (
    store_id, label, code, status, source, note, online_name, online_phone
  )
  values (
    v_store_id,
    v_account.display_name || ' · ' || v_account.phone,
    v_code,
    'open',
    'online',
    nullif(btrim(coalesce(p_note, '')), ''),
    v_account.display_name,
    v_account.phone
  )
  returning id into v_draft_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := coalesce((v_line ->> 'qty')::numeric, 0);
    if v_qty <= 0 then
      continue;
    end if;

    select p.id,
           coalesce(su.price, pr.price) as price,
           su.id as sale_unit_id
      into v_product
    from public.products p
    join public.stores s on s.id = p.store_id
    left join lateral (
      select su2.id, su2.price from public.product_sale_units su2
      where su2.product_id = p.id order by su2.sort_order, su2.base_qty desc limit 1
    ) su on true
    left join lateral (
      select pp.price from public.product_prices pp
      where pp.product_id = p.id order by (pp.pack_id is null) limit 1
    ) pr on true
    where p.id = (v_line ->> 'product_id')::uuid
      and p.store_id = v_store_id
      and p.status = 'active'
      and p.confirmed_at is not null
      and s.is_public;

    if v_product.id is null then
      continue;
    end if;

    v_unit_price := coalesce(v_product.price, 0);

    -- The bulk band they have earned, by the same rule the till uses.
    select t.price into v_tier_price
    from public.product_price_tiers t
    where t.product_id = v_product.id
      and t.sale_unit_id is not distinct from v_product.sale_unit_id
      and v_qty >= t.min_qty
      and (t.max_qty is null or v_qty <= t.max_qty)
    order by t.min_qty desc
    limit 1;

    if v_tier_price is not null then
      v_unit_price := v_tier_price;
    end if;

    v_shown := nullif(v_line ->> 'shown_price', '')::numeric;
    if v_shown is not null and v_shown <> v_unit_price then
      v_repriced := v_repriced + 1;
    end if;

    insert into public.draft_order_lines (
      draft_order_id, product_id, entered_qty, unit_price, line_total, position, sale_unit_id
    )
    values (
      v_draft_id, v_product.id, v_qty, v_unit_price, v_unit_price * v_qty,
      v_position, v_product.sale_unit_id
    );

    v_total := v_total + (v_unit_price * v_qty);
    v_position := v_position + 1;
    v_tier_price := null;
  end loop;

  if v_position = 0 then
    delete from public.draft_orders where id = v_draft_id;
    raise exception 'None of these are still for sale at that shop';
  end if;

  -- The first entry in this order's history. `actor` is null: the shopper is not a member here.
  insert into public.online_order_events (draft_order_id, store_id, action, actor)
  values (v_draft_id, v_store_id, 'placed', null);

  return query select v_code, v_total::money_amt, v_repriced;
end;
$$;

-- ── The queue is what has no answer ─────────────────────────────────────────────────

drop function if exists public.pending_online_orders(uuid);

create or replace function public.pending_online_orders(p_store_id uuid)
returns table (
  id            uuid,
  code          text,
  label         text,
  customer_name text,
  lines         bigint,
  total         money_amt,
  created_at    timestamptz,
  preview       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.code, d.label,
         coalesce(d.online_name, sc.display_name, sc.business_name),
         (select count(*) from public.draft_order_lines l where l.draft_order_id = d.id),
         coalesce((select sum(l.line_total) from public.draft_order_lines l where l.draft_order_id = d.id), 0)
           + d.fee_amount,
         d.created_at,
         (
           select string_agg(x.bit, ', ' order by x.position)
           from (
             select l.position,
                    trim(to_char(l.entered_qty, 'FM999999990.999')) || ' × ' || p.name as bit
             from public.draft_order_lines l
             join public.products p on p.id = l.product_id
             where l.draft_order_id = d.id
             order by l.position
             limit 3
           ) x
         )
  from public.draft_orders d
  left join public.store_customers sc on sc.id = d.store_customer_id
  where d.store_id = p_store_id
    and d.source = 'online'
    -- WAITING means unanswered. Not `status`, which follows the sale: an accepted order stays open
    -- at the till until it is settled, and went on being offered for acceptance the whole time.
    and d.answer is null
    and d.status = 'open'
    and public.has_permission(p_store_id, 'sales.record')
  order by d.created_at asc
$$;

create or replace function public.pending_online_orders_count(p_store_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from public.draft_orders d
  where d.store_id = p_store_id
    and d.source = 'online'
    and d.answer is null
    and d.status = 'open'
    and public.has_permission(p_store_id, 'sales.record')
$$;

-- ── Every order, filtered and searched ──────────────────────────────────────────────

/*
 * THE WHOLE LIST, for the tabs above the queue.
 *
 * `p_answer` is 'waiting', 'accepted', 'declined' or null for all. `p_since` bounds it by when the
 * order was PLACED — a shop asking "today" means orders that came in today, not orders it happened
 * to answer today. `p_query` matches the code, the shopper, or a product on it: those are the three
 * things somebody has in their hand when they go looking for an order.
 */
create or replace function public.online_orders(
  p_store_id uuid,
  p_answer   text default null,
  p_since    timestamptz default null,
  p_query    text default null,
  p_limit    integer default 60
)
returns table (
  id            uuid,
  code          text,
  customer_name text,
  answer        text,
  answered_at   timestamptz,
  status        text,
  lines         bigint,
  total         money_amt,
  created_at    timestamptz,
  preview       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.code,
         coalesce(d.online_name, sc.display_name, sc.business_name),
         d.answer, d.answered_at, d.status,
         (select count(*) from public.draft_order_lines l where l.draft_order_id = d.id),
         coalesce((select sum(l.line_total) from public.draft_order_lines l where l.draft_order_id = d.id), 0)
           + d.fee_amount,
         d.created_at,
         (
           select string_agg(x.bit, ', ' order by x.position)
           from (
             select l.position,
                    trim(to_char(l.entered_qty, 'FM999999990.999')) || ' × ' || p.name as bit
             from public.draft_order_lines l
             join public.products p on p.id = l.product_id
             where l.draft_order_id = d.id
             order by l.position
             limit 3
           ) x
         )
  from public.draft_orders d
  left join public.store_customers sc on sc.id = d.store_customer_id
  where d.store_id = p_store_id
    and d.source = 'online'
    and public.has_permission(p_store_id, 'sales.record')
    and (
      p_answer is null
      or (p_answer = 'waiting'  and d.answer is null)
      or (p_answer = 'accepted' and d.answer = 'accepted')
      or (p_answer = 'declined' and d.answer = 'declined')
    )
    and (p_since is null or d.created_at >= p_since)
    and (
      coalesce(btrim(p_query), '') = ''
      or d.code ilike '%' || btrim(p_query) || '%'
      or coalesce(d.online_name, '') ilike '%' || btrim(p_query) || '%'
      or coalesce(d.online_phone, '') ilike '%' || btrim(p_query) || '%'
      or exists (
        select 1 from public.draft_order_lines l
        join public.products p on p.id = l.product_id
        where l.draft_order_id = d.id and p.name ilike '%' || btrim(p_query) || '%'
      )
    )
  -- Newest first: a list somebody is searching is a list they are looking back through.
  order by d.created_at desc
  limit greatest(1, least(coalesce(p_limit, 60), 200))
$$;

comment on function public.online_orders(uuid, text, timestamptz, text, integer) is
  'Marketplace orders for one shop, filtered by answer and by when they were placed, searched by code, shopper or product. Sell permission required.';

-- ── Answering, and changing the answer ──────────────────────────────────────────────

create or replace function public.accept_online_order(p_draft_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order    public.draft_orders%rowtype;
  v_customer uuid;
begin
  select * into v_order from public.draft_orders where id = p_draft_id;

  if v_order.id is null or v_order.source <> 'online' then
    raise exception 'No such order';
  end if;
  if not public.has_permission(v_order.store_id, 'sales.record') then
    raise exception 'Not allowed to take sales at this shop';
  end if;

  /*
   * ANSWERED ONCE. This checked `status`, which is the sale's business and stays 'open' while an
   * accepted order sits at the till — so an order could be accepted again and again, each time
   * claiming it afresh and each time creating another customer record.
   */
  if v_order.answer is not null then
    raise exception 'That order has already been answered';
  end if;
  if v_order.status <> 'open' then
    raise exception 'That order is no longer open';
  end if;

  if v_order.store_customer_id is null and coalesce(btrim(v_order.online_phone), '') <> '' then
    v_customer := public.upsert_customer(
      v_order.store_id,
      v_order.online_phone,
      coalesce(nullif(btrim(v_order.online_name), ''), 'Marketplace shopper'),
      null
    );
    update public.draft_orders set store_customer_id = v_customer where id = p_draft_id;
  end if;

  update public.draft_orders
     set answer = 'accepted', answered_at = now(), answered_by = auth.uid()
   where id = p_draft_id;

  insert into public.online_order_events (draft_order_id, store_id, action, actor)
  values (p_draft_id, v_order.store_id, 'accepted', auth.uid());

  perform public.claim_draft_order(v_order.store_id, v_order.code);

  return p_draft_id;
end;
$$;

/*
 * TURNING ONE DOWN is an answer too, and it is recorded as one.
 *
 * `cancel_draft_order` closes the draft, which is right — nothing was sold and no stock moved — but
 * it says nothing about who decided that or when. This wraps it so the answer and the history are
 * written in the same breath as the cancellation.
 */
create or replace function public.decline_online_order(p_draft_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.draft_orders%rowtype;
begin
  select * into v_order from public.draft_orders where id = p_draft_id;

  if v_order.id is null or v_order.source <> 'online' then
    raise exception 'No such order';
  end if;
  if not public.has_permission(v_order.store_id, 'sales.record') then
    raise exception 'Not allowed to answer orders at this shop';
  end if;
  if v_order.answer is not null then
    raise exception 'That order has already been answered';
  end if;

  update public.draft_orders
     set answer = 'declined', answered_at = now(), answered_by = auth.uid()
   where id = p_draft_id;

  insert into public.online_order_events (draft_order_id, store_id, action, actor, reason)
  values (p_draft_id, v_order.store_id, 'declined', auth.uid(), nullif(btrim(coalesce(p_reason, '')), ''));

  perform public.cancel_draft_order(p_draft_id);
end;
$$;

/*
 * REOPENING: putting an answered order back in the queue.
 *
 * Not an undo — the answer that was given still happened, and the log keeps it. This adds an entry
 * saying it was taken back, by whom and why, and clears the answer so the order is waiting again.
 *
 * `sales.amend`, the same permission as changing a sale after the fact. Answering an order is
 * something a seller does; changing an answer already given is a correction, and corrections are
 * the owner's and the manager's business. A REASON is required for the same reason `amend_reason`
 * is: a correction nobody explained is a correction nobody can review.
 *
 * An order that has already become a SALE cannot be reopened here. That is a sale now, and undoing
 * a sale is `void`, which has its own path, its own ledger entries and its own permission.
 */
create or replace function public.reopen_online_order(p_draft_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.draft_orders%rowtype;
begin
  select * into v_order from public.draft_orders where id = p_draft_id;

  if v_order.id is null or v_order.source <> 'online' then
    raise exception 'No such order';
  end if;
  if not public.has_permission(v_order.store_id, 'sales.amend') then
    raise exception 'Only an owner or manager can reopen an answered order';
  end if;
  if v_order.answer is null then
    raise exception 'That order is already waiting for an answer';
  end if;
  if v_order.status = 'settled' then
    raise exception 'That order has been sold. Void the sale instead.';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why this order is being reopened';
  end if;

  update public.draft_orders
     set answer = null,
         answered_at = null,
         answered_by = null,
         -- A declined order was cancelled; it has to be open again to be answerable.
         status = 'open',
         held_by = null
   where id = p_draft_id;

  insert into public.online_order_events (draft_order_id, store_id, action, actor, reason)
  values (p_draft_id, v_order.store_id, 'reopened', auth.uid(), btrim(p_reason));
end;
$$;

comment on function public.reopen_online_order(uuid, text) is
  'Put an answered marketplace order back in the queue, with a reason, recorded in its history. Requires sales.amend. Refuses an order that has become a sale — that is a void.';

-- ── The order itself, now carrying its answer ───────────────────────────────────────

/*
 * Dropped first: the row has gained columns and `create or replace` cannot change a function's
 * shape. Dropping a `security definer` function takes its grants with it, so the grant is restated
 * below — without it every caller gets "permission denied" and the screen goes blank.
 */
drop function if exists public.online_order_detail(uuid);

create or replace function public.online_order_detail(p_draft_id uuid)
returns table (
  id             uuid,
  code           text,
  customer_name  text,
  customer_phone text,
  note           text,
  status         text,
  answer         text,
  answered_at    timestamptz,
  created_at     timestamptz,
  total          money_amt,
  lines          jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.code,
         coalesce(d.online_name, d.label),
         d.online_phone,
         d.note,
         d.status,
         d.answer,
         d.answered_at,
         d.created_at,
         coalesce((select sum(l.line_total) from public.draft_order_lines l
                    where l.draft_order_id = d.id), 0) + d.fee_amount,
         coalesce((
           select jsonb_agg(
                    jsonb_build_object(
                      'product_id', l.product_id,
                      'name',       p.name,
                      'unit',       coalesce(su.name, p.base_unit),
                      'qty',        l.entered_qty,
                      'unit_price', l.unit_price,
                      'line_total', l.line_total,
                      'in_stock',   coalesce((select sum(m.qty_delta) from public.stock_movements m
                                               where m.product_id = l.product_id), 0)
                    ) order by l.position
                  )
           from public.draft_order_lines l
           join public.products p on p.id = l.product_id
           left join public.product_sale_units su on su.id = l.sale_unit_id
           where l.draft_order_id = d.id
         ), '[]'::jsonb)
  from public.draft_orders d
  where d.id = p_draft_id
    and d.source = 'online'
    and public.has_permission(d.store_id, 'sales.record')
$$;

grant execute on function public.online_order_detail(uuid) to authenticated;

-- ── One order's history ─────────────────────────────────────────────────────────────

create or replace function public.online_order_history(p_draft_id uuid)
returns table (action text, actor_name text, reason text, at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.action,
         -- `store_members` keeps a first and last name, not one display name.
         coalesce(
           nullif(btrim(coalesce(m.first_name, '') || ' ' || coalesce(m.last_name, '')), ''),
           case when e.actor is null then 'The shopper' else 'Someone at this shop' end
         ),
         e.reason,
         e.at
  from public.online_order_events e
  join public.draft_orders d on d.id = e.draft_order_id
  left join public.store_members m on m.user_id = e.actor and m.store_id = e.store_id
  where e.draft_order_id = p_draft_id
    and public.has_permission(d.store_id, 'sales.record')
  order by e.at
$$;

grant execute on function public.pending_online_orders(uuid) to authenticated;
grant execute on function public.online_orders(uuid, text, timestamptz, text, integer) to authenticated;
grant execute on function public.decline_online_order(uuid, text) to authenticated;
grant execute on function public.reopen_online_order(uuid, text) to authenticated;
grant execute on function public.online_order_history(uuid) to authenticated;
