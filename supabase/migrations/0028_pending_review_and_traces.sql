-- =====================================================================================
-- 0028 — Add-as-you-go with review, and a trace on every movement
--
-- THE FRICTION: entering 1,000 products before the shop can sell anything is a wall nobody
-- climbs, and it is the wrong shape of work — one person typing a catalogue while customers wait.
--
-- THE RESOLUTION, from the domain expert: let anyone add what they need in the moment, mark it
-- UNCONFIRMED, and let a higher role confirm it afterwards. Work spreads across whoever is
-- there, nobody is blocked, and nothing enters the books unreviewed. Staff can add a product
-- mid-receipt; a manager accepts it later, along with the stock claimed for it.
--
-- So "pending" is not a lesser record — it is a real one, usable immediately, carrying an honest
-- label about who vouched for it. That is the difference between a system people work around and
-- one they work with.
--
-- ALSO HERE: every stock movement records the balance BEFORE and AFTER it. Asked for directly —
-- "every sale has a trace to show what was there before that sale and after" — and it turns the
-- history from a list of deltas into something a person can actually read.
-- =====================================================================================

-- ─── Confirmation on the records staff can create ───────────────────────────────────

alter table public.products
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references auth.users (id);

alter table public.store_customers
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references auth.users (id);

-- Everything that exists today was created before this workflow, so treat it as confirmed rather
-- than dropping a shop into a review queue of its entire catalogue.
update public.products        set confirmed_at = now() where confirmed_at is null;
update public.store_customers set confirmed_at = now() where confirmed_at is null;

create index if not exists products_pending_idx
  on public.products (store_id) where confirmed_at is null;
create index if not exists customers_pending_idx
  on public.store_customers (store_id) where confirmed_at is null;

-- ─── Reviewing a stock movement ─────────────────────────────────────────────────────
--
-- A separate table because stock_movements is append-only: marking one "reviewed" by UPDATE is
-- exactly what that guarantee forbids. A review is its own fact, with its own timestamp and its
-- own author — which is also more honest, since reviewing is a distinct act from recording.

create table if not exists public.movement_reviews (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete cascade,
  movement_id uuid not null references public.stock_movements (id) on delete cascade,
  accepted    boolean not null,
  note        text,
  reviewed_by uuid default auth.uid(),
  reviewed_at timestamptz not null default now(),
  unique (movement_id)
);

create index if not exists movement_reviews_store_idx on public.movement_reviews (store_id, reviewed_at desc);

create trigger no_mutation before update or delete on public.movement_reviews
  for each row execute function public.tg_append_only();

alter table public.movement_reviews enable row level security;

create policy movement_reviews_read on public.movement_reviews
  for select to authenticated using (public.is_store_member(store_id));
create policy movement_reviews_insert on public.movement_reviews
  for insert to authenticated
  with check (public.has_permission(store_id, 'stock.count'));

-- ─── Balance before / after, on every movement ──────────────────────────────────────

alter table public.stock_movements
  add column if not exists balance_before qty,
  add column if not exists balance_after  qty;

/**
 * Stamp the running balance as each movement is written.
 *
 * Honest about what this is: a SNAPSHOT for reading, not the source of truth. On-hand is still
 * sum(qty_delta) — that is the figure that cannot drift, and it stays authoritative. Two
 * concurrent inserts could compute the same `balance_before`, and if that ever happens the sum
 * is unaffected and CRODS is exactly the mechanism that surfaces it.
 *
 * The value is legibility: "there were 1,200, this sale took 24, 1,176 remained" is a sentence a
 * shop owner can check. A column of signed deltas is not.
 */
create or replace function public.tg_stamp_balance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before qty;
begin
  select coalesce(sum(m.qty_delta), 0) into v_before
  from public.stock_movements m
  where m.product_id = new.product_id;

  new.balance_before := v_before;
  new.balance_after  := v_before + new.qty_delta;
  return new;
end;
$$;

drop trigger if exists stamp_balance on public.stock_movements;
create trigger stamp_balance before insert on public.stock_movements
  for each row execute function public.tg_stamp_balance();

-- Backfill in movement order so existing history reads correctly too.
do $$
declare
  r record;
  v_running qty;
  v_product uuid := null;
begin
  for r in
    select id, product_id, qty_delta
    from public.stock_movements
    order by product_id, occurred_at, created_at, id
  loop
    if v_product is distinct from r.product_id then
      v_product := r.product_id;
      v_running := 0;
    end if;

    update public.stock_movements
       set balance_before = v_running,
           balance_after  = v_running + r.qty_delta
     where id = r.id;

    v_running := v_running + r.qty_delta;
  end loop;
end;
$$;

-- ─── Creating things mid-sale ───────────────────────────────────────────────────────

/**
 * Add a product without leaving the sale.
 *
 * `p_confirmed` is decided by permission, never by the caller: someone with products.manage
 * vouches for what they create, anyone else creates something pending. Passing that decision to
 * the client would make the review queue a formality.
 */
create or replace function public.quick_add_product(
  p_store_id   uuid,
  p_name       text,
  p_base_unit  text default 'piece',
  p_pack_name  text default null,
  p_pack_qty   qty  default null,
  p_price      money_amt default null,
  p_open_qty   qty  default null,
  p_unit_cost  unit_cost default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product   uuid;
  v_pack      uuid;
  v_confirmed boolean := public.has_permission(p_store_id, 'products.manage');
begin
  -- Anyone who may record a sale may add what they are selling. Blocking that is the friction
  -- this whole migration exists to remove.
  if not (v_confirmed or public.has_permission(p_store_id, 'sales.record')) then
    raise exception 'you do not have permission to add products' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'a product needs a name' using errcode = '22023';
  end if;

  insert into public.products (store_id, name, base_unit, confirmed_at, confirmed_by)
  values (p_store_id, trim(p_name), p_base_unit,
          case when v_confirmed then now() end,
          case when v_confirmed then auth.uid() end)
  returning id into v_product;

  if coalesce(trim(p_pack_name), '') <> '' and coalesce(p_pack_qty, 0) > 0 then
    insert into public.product_packs (product_id, name, base_unit_qty)
    values (v_product, trim(p_pack_name), p_pack_qty)
    returning id into v_pack;
    update public.products set default_display_pack_id = v_pack where id = v_product;
  end if;

  if p_price is not null then
    insert into public.product_prices (product_id, pack_id, price)
    values (v_product, v_pack, p_price);
  end if;

  if p_open_qty is not null and p_open_qty > 0 then
    perform public.initialise_stock(p_store_id, v_product, p_open_qty, p_unit_cost);
  end if;

  return jsonb_build_object(
    'product_id', v_product,
    'pack_id', v_pack,
    'confirmed', v_confirmed
  );
end;
$$;

/** The same idea for customers, so credit can be extended without waiting for a manager. */
create or replace function public.quick_add_customer(
  p_store_id     uuid,
  p_phone        text,
  p_display_name text,
  p_business_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id        uuid;
  v_confirmed boolean := public.has_permission(p_store_id, 'customers.manage');
begin
  if not (v_confirmed or public.has_permission(p_store_id, 'sales.record')) then
    raise exception 'you do not have permission to add customers' using errcode = '42501';
  end if;

  v_id := public.upsert_customer(p_store_id, p_phone, p_display_name, p_business_name);

  if v_confirmed then
    update public.store_customers
       set confirmed_at = coalesce(confirmed_at, now()),
           confirmed_by = coalesce(confirmed_by, auth.uid())
     where id = v_id;
  end if;

  return jsonb_build_object('customer_id', v_id, 'confirmed', v_confirmed);
end;
$$;

-- ─── Confirming ─────────────────────────────────────────────────────────────────────

create or replace function public.confirm_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_store uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'only a manager or owner can confirm a product' using errcode = '42501';
  end if;

  update public.products
     set confirmed_at = now(), confirmed_by = auth.uid(),
         amend_reason = 'confirmed'
   where id = p_product_id and confirmed_at is null;
end;
$$;

create or replace function public.confirm_customer(p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_store uuid;
begin
  select store_id into v_store from public.store_customers where id = p_customer_id;
  if not public.has_permission(v_store, 'customers.manage') then
    raise exception 'only a manager or owner can confirm a customer' using errcode = '42501';
  end if;

  update public.store_customers
     set confirmed_at = now(), confirmed_by = auth.uid(),
         amend_reason = 'confirmed'
   where id = p_customer_id and confirmed_at is null;
end;
$$;

/**
 * Accept or reject a stock entry someone else recorded.
 *
 * Rejecting does not delete it — the movement is append-only and it did happen, someone recorded
 * it. A rejection appends a reversing movement, so the trace shows both the claim and the
 * correction. Erasing it would hide exactly the thing a review exists to surface.
 */
create or replace function public.review_movement(
  p_movement_id uuid,
  p_accepted    boolean,
  p_note        text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m record;
begin
  select * into v_m from public.stock_movements where id = p_movement_id;
  if not found then
    raise exception 'that entry no longer exists' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_m.store_id, 'stock.count') then
    raise exception 'only a manager or owner can sign off stock' using errcode = '42501';
  end if;

  insert into public.movement_reviews (store_id, movement_id, accepted, note)
  values (v_m.store_id, p_movement_id, p_accepted, p_note);

  if not p_accepted then
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, reverses_id, note)
    values (v_m.store_id, v_m.product_id, 'adjustment', -v_m.qty_delta, v_m.unit_cost,
            'movement_reviews', p_movement_id, p_movement_id,
            coalesce(p_note, 'entry rejected on review'));
  end if;
end;
$$;

-- ─── The review queue ───────────────────────────────────────────────────────────────

create or replace function public.pending_review(p_store_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'base_unit', p.base_unit,
        'on_hand', coalesce((select sum(m.qty_delta) from public.stock_movements m
                              where m.product_id = p.id), 0),
        'created_at', p.created_at
      ) order by p.created_at)
      from public.products p
      where p.store_id = p_store_id and p.confirmed_at is null and p.status = 'active'
    ), '[]'::jsonb),

    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sc.id, 'name', sc.display_name, 'phone', i.phone, 'created_at', sc.created_at
      ) order by sc.created_at)
      from public.store_customers sc
      join public.identities i on i.id = sc.identity_id
      where sc.store_id = p_store_id and sc.confirmed_at is null
    ), '[]'::jsonb),

    -- Stock claimed but not yet signed off. Sales are excluded: a sale is evidenced by its
    -- receipt and its money, and putting every one of them in a queue would drown the entries
    -- that genuinely need a second pair of eyes.
    'stock_entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'product_id', m.product_id, 'product', p.name, 'kind', m.kind,
        'qty', m.qty_delta, 'balance_before', m.balance_before, 'balance_after', m.balance_after,
        'created_by', m.created_by, 'occurred_at', m.occurred_at
      ) order by m.occurred_at)
      from public.stock_movements m
      join public.products p on p.id = m.product_id
      where m.store_id = p_store_id
        and m.kind in ('opening', 'adjustment', 'damage', 'repack_loss')
        and not exists (select 1 from public.movement_reviews r where r.movement_id = m.id)
    ), '[]'::jsonb)
  );
$$;

grant execute on function public.quick_add_product(uuid, text, text, text, qty, money_amt, qty, unit_cost) to authenticated;
grant execute on function public.quick_add_customer(uuid, text, text, text) to authenticated;
grant execute on function public.confirm_product(uuid)   to authenticated;
grant execute on function public.confirm_customer(uuid)  to authenticated;
grant execute on function public.review_movement(uuid, boolean, text) to authenticated;
grant execute on function public.pending_review(uuid)    to authenticated;
