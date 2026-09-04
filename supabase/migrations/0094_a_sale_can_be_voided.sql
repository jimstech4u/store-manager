-- 0094 — A settled sale can be voided, and the books put back
--
-- «sale with void or editing sale when items changed when settled behind role permitted and also
--  good accounting»
--
-- There has never been a way. A seller who keys three crates as thirty, or bills the wrong
-- customer, or settles a sale the customer then walks away from, has no correction path at all —
-- and every one of those happens in a shop, on a busy Friday, more than once.
--
-- The schema saw it coming and stopped short: `sales.status`, `sales.revision` and
-- `sales.amend_reason` are all there, `sales.amend` is a real permission handed to managers, and
-- `customer_balance` already sums only `status = 'posted'`. Everything was in place except the
-- function.
--
-- NOTHING IS DELETED. Every ledger here is append-only and this does not fight that: the stock goes
-- back as a movement, the containers go back as a ledger entry, and the sale is marked voided
-- rather than removed. A voided sale stays readable for ever, because "why is this receipt
-- cancelled" is a question somebody asks weeks later and the answer has to be somewhere.
--
-- THE MONEY IS NOT TAKEN BACK. If a customer handed over ₦21,300 they handed it over, and voiding
-- the sale does not unhappen that. The payment stays and becomes credit on their account — which is
-- what it is, and what the shop owes them. Deleting it would make the drawer disagree with the
-- books, and the drawer is right.

create or replace function public.void_sale(p_sale_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sale record;
  v_line record;
  v_dep  record;
  v_back qty;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'that sale does not exist' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_sale.store_id, 'sales.amend') then
    raise exception 'you do not have permission to void a sale' using errcode = '42501';
  end if;

  if v_sale.status <> 'posted' then
    raise exception 'that sale is already %', v_sale.status using errcode = '22023';
  end if;

  -- A reason, always. "Why is this cancelled" is asked weeks later by somebody who was not there,
  -- and a void with no reason is indistinguishable from a mistake or a theft.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say why this sale is being voided' using errcode = '22023';
  end if;

  /*
   * NOT IF THE EMPTIES HAVE ALREADY STARTED COMING BACK.
   *
   * If a customer took four crates and has brought three, the containers are half settled and
   * reversing the sale's four would leave them owing minus one — a number that means nothing and
   * cannot be chased. Told plainly, because the way out is to finish settling first, and a shop
   * that is refused without being told why will do something worse.
   */
  select coalesce(sum(case when d.direction = 'collected' then d.qty_units else 0 end), 0)
    into v_back
    from public.deposit_ledger d
   where d.ref_table = 'sales'
     and d.ref_id = p_sale_id
     and d.qty_units < 0;

  if v_back <> 0 then
    raise exception
      'Some of the containers on this sale have already come back. Settle the rest first, then void.'
      using errcode = '22023';
  end if;

  -- ─── The stock goes back on the shelf ─────────────────────────────────────────────
  --
  -- As a movement, not by editing the one that took it off. The original is a fact about what
  -- happened; this is a second fact about what happened next, and both belong in the ledger.
  for v_line in
    select * from public.sale_lines where sale_id = p_sale_id
  loop
    if v_line.base_qty <> 0 then
      insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                          ref_table, ref_id, occurred_at, note)
      values (v_sale.store_id, v_line.product_id, 'adjustment', v_line.base_qty,
              v_line.unit_cost_at_sale, 'sales', p_sale_id, now(),
              'sale voided: ' || btrim(p_reason));
    end if;

    -- A count in progress must see the stock come back, or it will report a variance for it.
    perform public.refresh_period(public.ensure_open_period(v_line.product_id));
  end loop;

  -- ─── The containers were never sent out ───────────────────────────────────────────
  for v_dep in
    select * from public.deposit_ledger
     where ref_table = 'sales' and ref_id = p_sale_id and qty_units > 0
  loop
    insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                       direction, qty_units, deposit_per_unit,
                                       ref_table, ref_id, occurred_at, note)
    values (v_dep.store_id, v_dep.store_customer_id, v_dep.empties_category_id,
            v_dep.direction, -v_dep.qty_units, v_dep.deposit_per_unit,
            'sales', p_sale_id, now(), 'sale voided: ' || btrim(p_reason));
  end loop;

  /*
   * And the deposit money the shop was holding against them.
   *
   * `deposit_holdings` is what the shop is sitting on for this receipt. The containers are no
   * longer out, so it is not holding anything against them — but the CASH stays, as credit, for the
   * same reason the payment does. What is reversed is the claim, not the money.
   */
  insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                       ref_table, ref_id, note, occurred_at)
  select h.store_id, h.store_customer_id, -h.amount, 'sale_voided',
         'sales', p_sale_id, btrim(p_reason), now()
    from public.deposit_holdings h
   where h.ref_table = 'sales' and h.ref_id = p_sale_id
     and h.amount > 0;

  -- ─── And the sale is marked, not removed ──────────────────────────────────────────
  --
  -- `customer_balance` sums only `status = 'posted'`, so this alone takes the bill off what they
  -- owe. The payments are untouched and become credit — the customer really did hand the money
  -- over, and the drawer is right.
  update public.sales
     set status      = 'voided',
         amend_reason = btrim(p_reason),
         revision    = coalesce(revision, 0) + 1,
         updated_at  = now()
   where id = p_sale_id;
end;
$fn$;

comment on function public.void_sale(uuid, text) is
  'Void a settled sale: stock back as a movement, containers back as a ledger entry, the sale '
  'marked rather than deleted, and the MONEY LEFT ALONE — a payment that was made was made, and it '
  'becomes credit. Refuses once any of the sale''s containers have started coming back, because '
  'reversing four against three returned leaves an obligation of minus one.';

revoke all on function public.void_sale(uuid, text) from public;
grant execute on function public.void_sale(uuid, text) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'void_sale';
  if n <> 1 then
    raise exception 'void_sale has % overloads', n;
  end if;
end;
$check$;
