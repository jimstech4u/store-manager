-- 0076 — Empties, settled against the receipt they went out on
--
-- Everything here already existed one level up: `deposit_ledger` records what must come back per
-- customer per pool, `return_empties` settles it, and 243 of the ledger's rows already carry the
-- sale they came from. What was missing is the shop's own way of asking the question — which is not
-- "how many NBL bottles does Irekanmi owe" but "he took these out on Tuesday; what came back?"
--
-- Two additions, and one of them is a correction.
--
-- 1. `deposit_holdings` — MONEY, separated from the obligation.
--
--    `deposit_ledger.deposit_per_unit` forces a per-unit figure. The shop's actual practice is a
--    lump sum agreed for a whole receipt — "ten thousand for the lot" — or nothing at all, on
--    trust. To record ₦10,000 across half a crate of Goldberg and two of Gulder, the app has to
--    INVENT a split, and that invented number is what it will show during a dispute.
--
--    So a holding points at a RECEIPT and carries no category. The absence is the point: the shop
--    did not break it down, and the schema must not pretend it did. `empties_categories.deposit`
--    survives as the shop's suggested rate — a reference the till proposes and the seller
--    overrides, the same rule pricing already follows.
--
-- 2. `empties_by_receipt` and `settle_empties` — the reader and the writer for that question.

-- ─── Money held, per receipt ────────────────────────────────────────────────────────

create table if not exists public.deposit_holdings (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  store_customer_id uuid references public.store_customers (id) on delete restrict,
  -- Signed. Positive takes money in, negative gives it back or spends it on a shortfall.
  amount            money_amt not null check (amount <> 0),
  reason            text not null check (reason in ('taken', 'refunded', 'applied_to_shortfall')),
  -- The sale it was taken against, so the receipt can be asked what it is holding.
  ref_table         text,
  ref_id            uuid,
  note              text,
  occurred_at       timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now()
);

create index if not exists deposit_holdings_by_ref
  on public.deposit_holdings (ref_table, ref_id);
create index if not exists deposit_holdings_by_customer
  on public.deposit_holdings (store_id, store_customer_id);

drop trigger if exists no_mutation on public.deposit_holdings;
create trigger no_mutation before update or delete on public.deposit_holdings
  for each row execute function public.tg_append_only();

alter table public.deposit_holdings enable row level security;

drop policy if exists holdings_read on public.deposit_holdings;
create policy holdings_read on public.deposit_holdings
  for select using (public.is_store_member(store_id));

drop policy if exists holdings_write on public.deposit_holdings;
create policy holdings_write on public.deposit_holdings
  for insert with check (public.is_store_member(store_id));

-- ─── What each receipt still has out ────────────────────────────────────────────────
--
-- Per receipt rather than per customer, because that is how the shop remembers it: a name, a day,
-- and a stack of crates that went with it.
--
-- A RETURN IS COUNTED AGAINST THIS RECEIPT ONLY IF IT SAYS SO. `return_empties` settles a
-- customer's pool without naming a receipt, and rightly — somebody handing back twelve bottles is
-- not saying which Tuesday they came from. Those returns reduce `pool_outstanding` below and are
-- deliberately NOT subtracted from any single receipt: guessing which one they belonged to would
-- put a number on screen that the shop cannot check. The two figures are shown side by side and
-- the difference is honest.

create or replace function public.empties_by_receipt(
  p_store_id    uuid,
  p_customer_id uuid default null,
  p_limit       int default 50
)
returns table (
  sale_id           uuid,
  occurred_at       timestamptz,
  store_customer_id uuid,
  customer_name     text,
  sale_total        money_amt,
  expected          jsonb,
  outstanding_units qty,
  pool_outstanding  qty,
  held              money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with mine as (
    select d.ref_id as sale_id,
           d.store_customer_id,
           d.empties_category_id,
           sum(d.qty_units) as units
      from public.deposit_ledger d
     where d.store_id = p_store_id
       and d.direction = 'collected'
       and d.ref_table = 'sales'
       and d.ref_id is not null
       and (p_customer_id is null or d.store_customer_id = p_customer_id)
     group by d.ref_id, d.store_customer_id, d.empties_category_id
    having sum(d.qty_units) > 0
  )
  select s.id,
         s.occurred_at,
         m.store_customer_id,
         coalesce(sc.display_name, 'Walk-in'),
         s.total,
         jsonb_agg(
           jsonb_build_object(
             'category_id', ec.id,
             'category', ec.name,
             'kind', ec.kind,
             'units', m.units,
             'suggested_deposit', ec.deposit
           ) order by ec.name
         ),
         sum(m.units)::qty,
         -- What this customer owes across every receipt, so a return recorded at the account level
         -- is visible here instead of silently disagreeing with it.
         coalesce(
           (select sum(public.empties_outstanding(m.store_customer_id, x.empties_category_id))
              from (select distinct empties_category_id from mine m2
                     where m2.store_customer_id = m.store_customer_id) x),
           0
         )::qty,
         coalesce((select sum(h.amount) from public.deposit_holdings h
                    where h.ref_table = 'sales' and h.ref_id = s.id), 0)::money_amt
    from mine m
    join public.sales s on s.id = m.sale_id
    join public.empties_categories ec on ec.id = m.empties_category_id
    left join public.store_customers sc on sc.id = m.store_customer_id
   where public.is_store_member(p_store_id)
   group by s.id, s.occurred_at, m.store_customer_id, sc.display_name, s.total
   order by s.occurred_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$fn$;

revoke all on function public.empties_by_receipt(uuid, uuid, int) from public;
grant execute on function public.empties_by_receipt(uuid, uuid, int) to authenticated;

-- ─── Settling one receipt ───────────────────────────────────────────────────────────
--
-- The shop's worked example, which this exists to record honestly:
--
--   Irekanmi took out half a crate of Goldberg and two of Gulder. ₦10,000 was held for the lot —
--   one figure, no breakdown. He brings back everything except two Goldberg bottles and seven
--   Gulder. The shop decides to keep ₦2,000 of the deposit for what did not come back, and hands
--   ₦8,000 over.
--
-- THE SHOP NAMES THE SHORTFALL AMOUNT. There is no formula, and inventing one would be inventing
-- the per-item breakdown this table exists to avoid. Same reasoning as pricing: the seller decides
-- in the moment and the system records what they decided.
--
-- Append-only throughout. Nothing here edits the original obligation — the history has to show
-- what was owed, what came back, and when.

create or replace function public.settle_empties(
  p_store_id      uuid,
  p_sale_id       uuid,
  -- [{ category_id, qty }] — what physically came back.
  p_returned      jsonb default '[]'::jsonb,
  -- Kept from the holding to cover what did not. Income, recorded as a forfeit.
  p_apply_amount  money_amt default 0,
  -- Handed back. 'cash' pays out; 'credit' comes off what they owe; 'none' leaves it on deposit.
  p_refund_amount money_amt default 0,
  p_refund_mode   text default 'cash',
  p_note          text default null,
  p_occurred_at   timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_customer uuid;
  v_row      jsonb;
  v_cat      uuid;
  v_qty      qty;
  v_out      qty;
  v_returned qty := 0;
  v_held     money_amt;
  v_payment  uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to settle empties' using errcode = '42501';
  end if;

  if p_refund_mode not in ('cash', 'credit', 'none') then
    raise exception 'unknown refund mode %', p_refund_mode using errcode = '22023';
  end if;

  select store_customer_id into v_customer
    from public.sales
   where id = p_sale_id and store_id = p_store_id;

  if v_customer is null then
    raise exception 'that receipt has no customer, so it has no empties account'
      using errcode = '22023';
  end if;

  -- ── What came back ──────────────────────────────────────────────────────────────
  for v_row in select * from jsonb_array_elements(coalesce(p_returned, '[]'::jsonb))
  loop
    v_cat := (v_row ->> 'category_id')::uuid;
    v_qty := (v_row ->> 'qty')::qty;

    if v_qty is null or v_qty <= 0 then
      continue;                      -- a pool nothing came back for is not an error
    end if;

    v_out := public.empties_outstanding(v_customer, v_cat);
    if v_qty > v_out then
      raise exception 'they owe % of that pool but % were offered', v_out, v_qty
        using errcode = '22023';
    end if;

    -- Tagged with the receipt, which is what makes this settle THAT stack of crates rather than
    -- the customer's pool in general.
    insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                       direction, qty_units, deposit_per_unit,
                                       ref_table, ref_id, occurred_at, note)
    values (p_store_id, v_customer, v_cat, 'collected', -v_qty, 0,
            'sales', p_sale_id, p_occurred_at, coalesce(p_note, 'empties returned'));

    v_returned := v_returned + v_qty;
  end loop;

  -- ── The money ───────────────────────────────────────────────────────────────────
  select coalesce(sum(amount), 0) into v_held
    from public.deposit_holdings
   where ref_table = 'sales' and ref_id = p_sale_id;

  if p_apply_amount + p_refund_amount > v_held then
    raise exception 'only % is held against that receipt, but % was accounted for',
      v_held, p_apply_amount + p_refund_amount using errcode = '22023';
  end if;

  if p_apply_amount > 0 then
    insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                         ref_table, ref_id, note, occurred_at)
    values (p_store_id, v_customer, -p_apply_amount, 'applied_to_shortfall',
            'sales', p_sale_id, p_note, p_occurred_at);

    /*
     * NOT ALSO WRITTEN TO `deposit_forfeits`, and the first version was.
     *
     * That table wants `qty_units > 0` and an amount, because it was built for the per-pool case:
     * "nine NBL bottles broke, we kept ₦1,125." This is the other case — the shop names ONE figure
     * for a mixed shortfall and never breaks it down, so there is no honest quantity to put in
     * that column. The first attempt passed 0 and the constraint refused it, which was the
     * database being right.
     *
     * The holding row above IS the income record: append-only, signed, tied to the receipt, and
     * reportable. Two tables recording the same money would be worse than one — reports would have
     * to know which flow produced a figure in order to avoid counting it twice.
     */
  end if;

  if p_refund_amount > 0 and p_refund_mode <> 'none' then
    insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                         ref_table, ref_id, note, occurred_at)
    values (p_store_id, v_customer, -p_refund_amount, 'refunded',
            'sales', p_sale_id, p_note, p_occurred_at);

    -- 'credit' is a payment IN — it reduces what they owe, exactly as cash handed over would.
    -- 'cash' is a payment OUT. Recorded as a payment either way rather than as a silent
    -- adjustment, because this is the line a customer queries and it has to be pointed at.
    insert into public.payments (store_id, store_customer_id, amount, method, direction,
                                 reference, occurred_at)
    values (p_store_id, v_customer, p_refund_amount, 'other',
            case when p_refund_mode = 'credit' then 'in' else 'out' end,
            'Deposit settled on receipt', p_occurred_at)
    returning id into v_payment;
  end if;

  return jsonb_build_object(
    'returned_units', v_returned,
    'applied', p_apply_amount,
    'refunded', p_refund_amount,
    'still_held', v_held - p_apply_amount - p_refund_amount,
    'payment_id', v_payment
  );
end;
$fn$;

revoke all on function
  public.settle_empties(uuid, uuid, jsonb, money_amt, money_amt, text, text, timestamptz) from public;
grant execute on function
  public.settle_empties(uuid, uuid, jsonb, money_amt, money_amt, text, text, timestamptz) to authenticated;

-- ─── Taking a deposit against a receipt ─────────────────────────────────────────────
--
-- One figure for the whole receipt, which is how it is actually agreed at the counter.

create or replace function public.hold_receipt_deposit(
  p_store_id    uuid,
  p_sale_id     uuid,
  p_amount      money_amt,
  p_note        text default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_customer uuid;
  v_id       uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to take a deposit' using errcode = '42501';
  end if;

  if p_amount <= 0 then
    raise exception 'how much is being held?' using errcode = '22023';
  end if;

  select store_customer_id into v_customer
    from public.sales
   where id = p_sale_id and store_id = p_store_id;

  if v_customer is null then
    raise exception 'that receipt has no customer to hold a deposit for' using errcode = '22023';
  end if;

  insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                       ref_table, ref_id, note, occurred_at)
  values (p_store_id, v_customer, p_amount, 'taken', 'sales', p_sale_id, p_note, p_occurred_at)
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function
  public.hold_receipt_deposit(uuid, uuid, money_amt, text, timestamptz) from public;
grant execute on function
  public.hold_receipt_deposit(uuid, uuid, money_amt, text, timestamptz) to authenticated;
