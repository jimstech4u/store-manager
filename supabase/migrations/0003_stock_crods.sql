-- =====================================================================================
-- 0003 — Stock movements, weighted-average cost, CRODS periods
--
-- This is the heart of the product. Decisions implemented (STORE_MANAGER_PLAN.md):
--   C1   movements are APPEND-ONLY, enforced by trigger — a correction appends a reversal
--   C3   moving weighted average, recomputed on receipt
--   GAP 7 a variance must be RESOLVED with a reason, and a period cannot close until it is
--   GAP 8 tolerance, so routine miscounts do not train people to ignore the one real signal
--   GAP 3 repack_loss is its own kind, distinct from damage
-- =====================================================================================

-- ─── Stock movements: the immutable ledger ──────────────────────────────────────────
--
-- Every change in stock is a row here and nothing else moves stock. `qty_delta` is signed:
-- positive adds, negative removes. Storing a signed delta rather than a per-kind sign rule
-- means the on-hand balance is one sum() and can never disagree with itself.

create table public.stock_movements (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores (id) on delete cascade,
  product_id   uuid not null references public.products (id) on delete restrict,
  kind         text not null check (kind in (
                 'opening',      -- backfilled starting position
                 'receive',      -- stock in from a supplier
                 'sale',         -- sold to a customer
                 'return_in',    -- customer brought goods back
                 'damage',       -- broken, spoiled, expired
                 'repack_loss',  -- lost breaking bulk down (GAP 3) — NOT damage: the
                                 -- distinction is what tells a business whether repackaging
                                 -- is wasteful or someone is stealing
                 'adjustment',   -- resolving a CRODS variance
                 'transfer_in',
                 'transfer_out'
               )),
  qty_delta    qty not null check (qty_delta <> 0),
  -- Cost carried at the moment of the movement, so historic margin never silently changes
  -- when today's average cost moves.
  unit_cost    unit_cost not null default 0,
  ref_table    text,                       -- e.g. 'sales' — what caused this
  ref_id       uuid,
  -- Set when this row reverses another. Corrections append; they never edit.
  reverses_id  uuid references public.stock_movements (id),
  note         text,
  occurred_at  timestamptz not null default now(),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

create index on public.stock_movements (store_id, product_id, occurred_at);
create index on public.stock_movements (store_id, occurred_at desc);
create index on public.stock_movements (ref_table, ref_id);

create trigger no_mutation before update or delete on public.stock_movements
  for each row execute function public.tg_append_only();

-- Refuse a fractional quantity for a product whose unit cannot be divided. 3.4 kg of powder is
-- valid; 3.4 bottles is a typo, and catching it here means it can never reach a CRODS variance
-- and be mistaken for shrinkage.
create or replace function public.tg_check_fraction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allows boolean;
begin
  select u.allows_fraction into v_allows
  from public.products p
  join public.units u on u.code = p.base_unit
  where p.id = new.product_id;

  if not coalesce(v_allows, true) and new.qty_delta <> trunc(new.qty_delta) then
    raise exception 'this product is counted in whole units — % is not valid', new.qty_delta
      using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger check_fraction before insert on public.stock_movements
  for each row execute function public.tg_check_fraction();

-- ─── On-hand balance ────────────────────────────────────────────────────────────────
--
-- Derived by summing the ledger, never stored as a mutable counter that could drift away from
-- the movements that produced it. Negative is ALLOWED and meaningful: after an offline sync two
-- devices may both have sold the last pieces, and the goods either existed or they did not.
-- Refusing to record it would discard a sale that physically happened; surfacing it as CRODS
-- variance is the entire design.

create or replace function public.stock_on_hand(p_product_id uuid)
returns qty
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(m.qty_delta), 0)::qty
  from public.stock_movements m
  join public.products p on p.id = m.product_id
  where m.product_id = p_product_id
    and public.is_store_member(p.store_id);
$$;

grant execute on function public.stock_on_hand(uuid) to authenticated;

-- ─── Moving weighted average cost ───────────────────────────────────────────────────
--
--   new_avg = (on_hand × old_avg + received_qty × landed_unit_cost) ÷ (on_hand + received_qty)
--
-- Chosen over FIFO because it survives negative stock (which offline sync makes inevitable),
-- needs no batch tracking, and is explainable to a shop owner as "your average cost".

create or replace function public.apply_weighted_average(
  p_product_id       uuid,
  p_received_qty     qty,
  p_landed_unit_cost unit_cost
)
returns unit_cost
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_on_hand qty;
  v_old_avg unit_cost;
  v_new_avg unit_cost;
begin
  select p.avg_unit_cost into v_old_avg from public.products p where p.id = p_product_id;

  select coalesce(sum(m.qty_delta), 0) into v_on_hand
  from public.stock_movements m where m.product_id = p_product_id;

  -- With non-positive stock on hand there is no meaningful pool to average against — the new
  -- consignment simply becomes the cost basis. Averaging against a negative would produce a
  -- nonsense (possibly negative) unit cost and poison every margin computed afterwards.
  if v_on_hand + p_received_qty <= 0 or v_on_hand <= 0 then
    v_new_avg := p_landed_unit_cost;
  else
    v_new_avg := ((v_on_hand * v_old_avg) + (p_received_qty * p_landed_unit_cost))
                 / (v_on_hand + p_received_qty);
  end if;

  update public.products
     set avg_unit_cost     = v_new_avg,
         cost_is_estimated = false      -- a real receipt supersedes an owner's day-one estimate
   where id = p_product_id;

  return v_new_avg;
end;
$$;

-- ─── CRODS periods ──────────────────────────────────────────────────────────────────
--
-- Cadence is deliberately not fixed: a business closes daily, weekly, per delivery, or whenever
-- it counts. The detection maths must hold at whatever window is chosen, because the point is
-- catching real discrepancies rather than filling in a scheduled report.
--
-- Opening/receiving/sales/damaged are computed FROM the movement ledger, never typed, so they
-- cannot disagree with the transactions that produced them. Only `actual_closing_qty` is
-- entered by a human — and the gap between the two is the whole feature.

create table public.stock_periods (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores (id) on delete cascade,
  product_id   uuid not null references public.products (id) on delete cascade,
  period_start timestamptz not null,
  period_end   timestamptz,
  status       text not null default 'open' check (status in ('open','closed','locked')),

  opening_qty   qty not null default 0,
  receiving_qty qty not null default 0,
  sales_qty     qty not null default 0,
  damaged_qty   qty not null default 0,
  other_qty     qty not null default 0,     -- returns, repack loss, transfers, adjustments

  -- Generated, never typed: Opening + Receiving − Sales − Damages ± other.
  expected_closing_qty qty generated always as
    (opening_qty + receiving_qty - sales_qty - damaged_qty + other_qty) stored,

  actual_closing_qty qty,                   -- entered independently by a physical count
  variance_qty qty generated always as
    (case when actual_closing_qty is null then null
          else actual_closing_qty - (opening_qty + receiving_qty - sales_qty - damaged_qty + other_qty)
     end) stored,

  counted_by   uuid references auth.users (id),
  counted_at   timestamptz,
  closed_by    uuid references auth.users (id),
  closed_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One open period per product at a time: two would make "which one does this sale belong to"
-- unanswerable.
create unique index stock_periods_one_open
  on public.stock_periods (product_id) where status = 'open';
create index on public.stock_periods (store_id, period_start desc);

create trigger touch_updated_at before update on public.stock_periods
  for each row execute function public.tg_touch_updated_at();

-- ─── Variance resolution ────────────────────────────────────────────────────────────
--
-- Detecting the gap is worthless if nobody has to explain it. Each resolution carries a reason
-- that determines the financial treatment, and (except for a miscount) writes an adjustment
-- movement so the ledger and the count agree afterwards.

create table public.variance_resolutions (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores (id) on delete cascade,
  stock_period_id uuid not null references public.stock_periods (id) on delete cascade,
  qty             qty  not null,
  reason          text not null check (reason in (
                    'miscount',         -- the count was wrong; correct it, no financial loss
                    'theft',            -- booked as a loss at average cost
                    'unrecorded_sale',  -- convert to a sale
                    'unlogged_damage',  -- booked as damage
                    'unrecorded_receipt',
                    'other'
                  )),
  note            text,
  value_at_cost   money_amt not null default 0,
  resolved_by     uuid default auth.uid(),
  resolved_at     timestamptz not null default now()
);

create index on public.stock_periods (product_id, status);
create index on public.variance_resolutions (stock_period_id);

create trigger no_mutation before update or delete on public.variance_resolutions
  for each row execute function public.tg_append_only();

-- Is this variance small enough to pass without an explanation? (GAP 8)
create or replace function public.variance_within_tolerance(p_period_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when sp.variance_qty is null then false
    else abs(sp.variance_qty) <= greatest(
      p.variance_tolerance_qty,
      abs(sp.expected_closing_qty) * p.variance_tolerance_pct / 100.0
    )
  end
  from public.stock_periods sp
  join public.products p on p.id = sp.product_id
  where sp.id = p_period_id;
$$;

grant execute on function public.variance_within_tolerance(uuid) to authenticated;

-- ─── RLS ────────────────────────────────────────────────────────────────────────────

alter table public.stock_movements       enable row level security;
alter table public.stock_periods         enable row level security;
alter table public.variance_resolutions  enable row level security;

create policy movements_read on public.stock_movements
  for select to authenticated using (public.is_store_member(store_id));

-- INSERT only. No update/delete policy exists at all, so append-only holds at the policy layer
-- as well as the trigger layer — two independent reasons a correction cannot become an erasure.
create policy movements_insert on public.stock_movements
  for insert to authenticated
  with check (
    public.has_permission(store_id, 'stock.adjust')
    or public.has_permission(store_id, 'stock.receive')
    or public.has_permission(store_id, 'sales.record')
  );

create policy periods_read on public.stock_periods
  for select to authenticated using (public.is_store_member(store_id));
create policy periods_write on public.stock_periods
  for all to authenticated
  using (public.has_permission(store_id, 'stock.count'))
  with check (public.has_permission(store_id, 'stock.count'));

create policy variance_read on public.variance_resolutions
  for select to authenticated using (public.is_store_member(store_id));
create policy variance_insert on public.variance_resolutions
  for insert to authenticated
  with check (public.has_permission(store_id, 'variance.resolve'));
