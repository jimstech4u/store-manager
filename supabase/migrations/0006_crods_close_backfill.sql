-- =====================================================================================
-- 0006 — CRODS close, variance resolution, opening-balance backfill
--
-- Decisions implemented (STORE_MANAGER_PLAN.md):
--   GAP 7  a period cannot close with an unresolved variance above tolerance — the
--          enforcement is what makes CRODS real rather than decorative
--   GAP 11 backfill covers cost basis AND empties, not just stock and debt
--   C1     closing a period is a CHECKPOINT: later edits behind it become dated adjustments
-- =====================================================================================

-- ─── Enter a physical count ─────────────────────────────────────────────────────────
--
-- Deliberately does NOT close the period. Counting and closing are separate acts: the count is
-- an observation, and closing asserts that any gap has been explained. Collapsing them would
-- let a variance be sealed in the same motion that created it.

create or replace function public.enter_stock_count(
  p_period_id uuid,
  p_counted   qty
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p        record;
  v_within   boolean;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'stock.count') then
    raise exception 'you do not have permission to enter counts' using errcode = '42501';
  end if;
  if v_p.status <> 'open' then
    raise exception 'this period is already %', v_p.status using errcode = '22023';
  end if;

  -- Recompute from the ledger first, so the expectation reflects every movement recorded up to
  -- this moment — including anything that synced from an offline device seconds ago.
  perform public.refresh_period(p_period_id);

  update public.stock_periods
     set actual_closing_qty = p_counted,
         counted_by = auth.uid(),
         counted_at = now()
   where id = p_period_id;

  select * into v_p from public.stock_periods where id = p_period_id;
  v_within := public.variance_within_tolerance(p_period_id);

  return jsonb_build_object(
    'period_id',        p_period_id,
    'opening',          v_p.opening_qty,
    'receiving',        v_p.receiving_qty,
    'sales',            v_p.sales_qty,
    'damaged',          v_p.damaged_qty,
    'other',            v_p.other_qty,
    'expected_closing', v_p.expected_closing_qty,
    'actual_closing',   v_p.actual_closing_qty,
    'variance',         v_p.variance_qty,
    'within_tolerance', v_within,
    'needs_resolution', (v_p.variance_qty is distinct from 0) and not v_within
  );
end;
$$;

-- ─── Resolve a variance ─────────────────────────────────────────────────────────────
--
-- The reason is not a label — it decides the financial treatment. A miscount costs nothing; the
-- others are real value that left the business, and if it is not booked the P&L overstates
-- profit by exactly the amount being stolen.

create or replace function public.resolve_variance(
  p_period_id uuid,
  p_reason    text,
  p_note      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p        record;
  v_avg_cost unit_cost;
  v_value    money_amt;
  v_id       uuid;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'variance.resolve') then
    raise exception 'you do not have permission to resolve variances' using errcode = '42501';
  end if;
  if v_p.variance_qty is null then
    raise exception 'enter a physical count before resolving' using errcode = '22023';
  end if;
  if v_p.status <> 'open' then
    raise exception 'this period is already %', v_p.status using errcode = '22023';
  end if;

  select avg_unit_cost into v_avg_cost from public.products where id = v_p.product_id;
  v_value := abs(v_p.variance_qty) * coalesce(v_avg_cost, 0);

  insert into public.variance_resolutions (store_id, stock_period_id, qty, reason, note,
                                           value_at_cost)
  values (v_p.store_id, p_period_id, v_p.variance_qty, p_reason, p_note,
          case when p_reason = 'miscount' then 0 else v_value end)
  returning id into v_id;

  -- A miscount means the COUNT was wrong, so the ledger stands and the count is corrected to
  -- match it. Every other reason means the STOCK really moved, so the ledger is brought into
  -- line with what was physically counted.
  if p_reason = 'miscount' then
    update public.stock_periods
       set actual_closing_qty = expected_closing_qty
     where id = p_period_id;
  else
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, note)
    values (v_p.store_id, v_p.product_id, 'adjustment', v_p.variance_qty,
            coalesce(v_avg_cost, 0), 'variance_resolutions', v_id,
            coalesce(p_note, p_reason));
  end if;

  return v_id;
end;
$$;

-- ─── Close a period (checkpoint) ────────────────────────────────────────────────────

create or replace function public.close_stock_period(p_period_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p          record;
  v_resolved   int;
  v_next_id    uuid;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'stock.count') then
    raise exception 'you do not have permission to close periods' using errcode = '42501';
  end if;
  if v_p.status <> 'open' then
    raise exception 'this period is already %', v_p.status using errcode = '22023';
  end if;
  if v_p.actual_closing_qty is null then
    raise exception 'enter a physical count before closing' using errcode = '22023';
  end if;

  -- The enforcement that makes CRODS real: an unexplained gap blocks the close.
  if v_p.variance_qty is distinct from 0
     and not public.variance_within_tolerance(p_period_id) then
    select count(*) into v_resolved
      from public.variance_resolutions where stock_period_id = p_period_id;
    if v_resolved = 0 then
      raise exception
        'this period is off by % — record a reason before closing', v_p.variance_qty
        using errcode = '22023';
    end if;
  end if;

  update public.stock_periods
     set status     = 'closed',
         period_end = now(),
         closed_by  = auth.uid(),
         closed_at  = now()
   where id = p_period_id;

  -- Open the next period immediately, carrying the COUNTED closing forward as its opening.
  insert into public.stock_periods (store_id, product_id, period_start, opening_qty)
  values (v_p.store_id, v_p.product_id, now(), v_p.actual_closing_qty)
  returning id into v_next_id;

  return v_next_id;
end;
$$;

-- Breaking a seal is legitimate — real errors surface after a close — but it is privileged and
-- itself audited, so "who reopened the books, and when" is always answerable.
create or replace function public.reopen_stock_period(p_period_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_p record;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'period.reopen') then
    raise exception 'you do not have permission to reopen a closed period' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'a reason is required to reopen a period' using errcode = '22023';
  end if;
  if v_p.status = 'locked' then
    raise exception 'this period is locked and cannot be reopened' using errcode = '22023';
  end if;

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  values (v_p.store_id, 'stock_periods', p_period_id, 'update',
          to_jsonb(v_p), jsonb_build_object('status', 'open'), p_reason);

  update public.stock_periods
     set status = 'open', period_end = null, closed_by = null, closed_at = null
   where id = p_period_id;
end;
$$;

-- ─── Backfill: opening balances ─────────────────────────────────────────────────────
--
-- No real business starts with empty books. These are starting LINES, not transactions: a
-- backfilled stock level is not a purchase and a backfilled debt is not a sale, and recording
-- them as such would inflate the first period's receiving and sales figures — corrupting the
-- very first CRODS reconciliation.

create table public.opening_balances (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references public.stores (id) on delete cascade,
  kind                text not null check (kind in ('stock','debtor','cash','empties')),
  as_of_date          date not null,
  product_id          uuid references public.products (id) on delete cascade,
  store_customer_id   uuid references public.store_customers (id) on delete cascade,
  empties_category_id uuid references public.empties_categories (id) on delete cascade,
  quantity            qty,
  amount              money_amt,
  -- Day-one cost is usually the owner's estimate. Recorded as such so early margins read as
  -- approximate rather than confidently wrong (GAP 11).
  unit_cost           unit_cost,
  cost_is_estimated   boolean not null default true,
  note                text,
  entered_by          uuid default auth.uid(),
  created_at          timestamptz not null default now()
);

create index on public.opening_balances (store_id, kind);

alter table public.opening_balances enable row level security;

create policy opening_read on public.opening_balances
  for select to authenticated using (public.is_store_member(store_id));
create policy opening_write on public.opening_balances
  for all to authenticated
  using (public.has_permission(store_id, 'backfill.manage'))
  with check (public.has_permission(store_id, 'backfill.manage'));

-- Post one opening-stock line: records the balance, seeds the cost basis, and writes the single
-- 'opening' movement the first CRODS period will build from.
create or replace function public.backfill_stock(
  p_store_id   uuid,
  p_product_id uuid,
  p_qty        qty,
  p_unit_cost  unit_cost,
  p_as_of      date default current_date,
  p_estimated  boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'backfill.manage') then
    raise exception 'you do not have permission to enter opening balances' using errcode = '42501';
  end if;

  if exists (select 1 from public.stock_movements
              where product_id = p_product_id and kind = 'opening') then
    raise exception 'this product already has an opening balance' using errcode = '23505';
  end if;

  insert into public.opening_balances (store_id, kind, as_of_date, product_id, quantity,
                                       unit_cost, cost_is_estimated)
  values (p_store_id, 'stock', p_as_of, p_product_id, p_qty, p_unit_cost, p_estimated)
  returning id into v_id;

  update public.products
     set avg_unit_cost = p_unit_cost, cost_is_estimated = p_estimated
   where id = p_product_id;

  if p_qty <> 0 then
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at, note)
    values (p_store_id, p_product_id, 'opening', p_qty, p_unit_cost,
            'opening_balances', v_id, p_as_of::timestamptz, 'opening balance');
  end if;

  perform public.refresh_period(public.ensure_open_period(p_product_id));

  return v_id;
end;
$$;

-- Opening debt: a starting balance, deliberately NOT a fake sale — inventing a sale would put
-- imaginary goods through CRODS and misstate revenue for the first period.
create or replace function public.backfill_debtor(
  p_store_id    uuid,
  p_customer_id uuid,
  p_amount      money_amt,
  p_as_of       date default current_date,
  p_note        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'backfill.manage') then
    raise exception 'you do not have permission to enter opening balances' using errcode = '42501';
  end if;

  insert into public.opening_balances (store_id, kind, as_of_date, store_customer_id, amount, note)
  values (p_store_id, 'debtor', p_as_of, p_customer_id, p_amount, p_note)
  returning id into v_id;

  return v_id;
end;
$$;

-- Opening empties: on day one customers already owe crates and bottles. Without this the first
-- return would be refused as unowed — the tool contradicting the physical reality in front of
-- the person using it, on their first day.
create or replace function public.backfill_empties(
  p_store_id    uuid,
  p_customer_id uuid,
  p_category_id uuid,
  p_qty         qty,
  p_as_of       date default current_date
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'backfill.manage') then
    raise exception 'you do not have permission to enter opening balances' using errcode = '42501';
  end if;

  insert into public.opening_balances (store_id, kind, as_of_date, store_customer_id,
                                       empties_category_id, quantity)
  values (p_store_id, 'empties', p_as_of, p_customer_id, p_category_id, p_qty)
  returning id into v_id;

  insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                     direction, qty_units, ref_table, ref_id,
                                     occurred_at, note)
  values (p_store_id, p_customer_id, p_category_id, 'collected', p_qty,
          'opening_balances', v_id, p_as_of::timestamptz, 'opening balance');

  return v_id;
end;
$$;

-- Customer debt including any backfilled opening balance. The plain sales-minus-payments figure
-- would show a long-standing debtor as owing nothing on the day the business migrates.
create or replace function public.customer_balance_total(p_store_customer_id uuid)
returns money_amt
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    coalesce(public.customer_balance(p_store_customer_id), 0)
    + coalesce((select sum(ob.amount) from public.opening_balances ob
                 where ob.store_customer_id = p_store_customer_id and ob.kind = 'debtor'), 0)
  )::money_amt;
$$;

grant execute on function public.enter_stock_count(uuid, qty)              to authenticated;
grant execute on function public.resolve_variance(uuid, text, text)        to authenticated;
grant execute on function public.close_stock_period(uuid)                  to authenticated;
grant execute on function public.reopen_stock_period(uuid, text)           to authenticated;
grant execute on function public.backfill_stock(uuid, uuid, qty, unit_cost, date, boolean) to authenticated;
grant execute on function public.backfill_debtor(uuid, uuid, money_amt, date, text) to authenticated;
grant execute on function public.backfill_empties(uuid, uuid, uuid, qty, date) to authenticated;
grant execute on function public.customer_balance_total(uuid)              to authenticated;
