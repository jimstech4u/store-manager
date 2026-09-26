-- =====================================================================================
-- 0180 — A reopened receipt can be cancelled again
--
-- 0179 let a cancelled receipt be opened again, and left it impossible to cancel a second time.
--
-- `void_sale` refuses when a sale's containers have started coming back — four went out, three came
-- back, reversing four would leave the customer owing minus one, which is a number nobody can
-- chase. That guard is right and stays.
--
-- What it did not distinguish is the shop's OWN bookkeeping from a customer with crates. Voiding
-- releases the containers by appending 'returned' rows tagged `sale_void`; reopening puts them back
-- by appending 'out' rows tagged `sale_reopen`. Both are this database talking to itself. The guard
-- counted the first kind as a genuine return, so a receipt cancelled in error, reopened, and then
-- genuinely cancelled was refused — and told the shop its crates had come back, about crates
-- sitting in the yard.
--
-- Found by the probe for 0178/0179, which voids its own test receipts on the way out and could not
-- void the one it had reopened. It would otherwise have been found by a shop, months later, in the
-- one state nobody thinks to try.
--
-- The rest of the function is the live definition, unchanged.
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.void_sale(p_sale_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  /*
   * READ FROM `customer_empties`, which is where a sale's containers now go.
   *
   * This read `deposit_ledger`, and sales stopped writing to it in 0119 — so the guard quietly
   * stopped firing and a half-settled sale would void, leaving the customer owing MINUS one crate.
   * A ledger that can go negative is one nobody can chase, and the figure it goes negative against
   * is somebody's crates.
   *
   * Anything CLOSED against a row this sale wrote — brought back or written off — counts.
   */
  select coalesce(count(*), 0)
    into v_back
    from public.customer_empties back
    join public.customer_empties went on went.id = back.ref_id
    join public.sale_lines sl on sl.id = went.ref_id
   where went.ref_table = 'sale_lines'
     and sl.sale_id = p_sale_id
     and back.direction in ('returned', 'damaged')
     /*
      * THE SHOP'S OWN BOOKKEEPING IS NOT A CUSTOMER BRINGING CRATES BACK.
      *
      * This guard exists to stop a sale being reversed while its containers are half settled: four
      * went out, three came back, reversing four leaves the customer owing minus one. A real
      * return.
      *
      * `void_sale` itself writes 'returned' rows to release the containers, tagged `sale_void`, and
      * 0179 writes 'out' rows tagged `sale_reopen` to put them back. So a receipt that was cancelled
      * and then reopened carries this function's OWN rows from the first cancellation — and the
      * guard read them as the customer having returned the crates, and refused to cancel it a
      * second time. A shop that cancelled by mistake, reopened, and then genuinely wanted to cancel
      * was told "some of the containers have already come back" about crates sitting in the yard.
      *
      * Found by a probe that voided its own test receipts on the way out and could not.
      */
     and coalesce(back.ref_table, '') not in ('sale_void', 'sale_reopen');

  if v_back = 0 then
    /*
     * AND THE ORDINARY CASE: a return recorded against the customer rather than against this
     * sale's row, which is how the empties screen records one. If they owe less of a shape than
     * this sale put out, some of it has already come back.
     */
    select coalesce(count(*), 0)
      into v_back
      from (
        select went.product_unit_id, sum(went.qty) as sent
          from public.customer_empties went
          join public.sale_lines sl on sl.id = went.ref_id
         where went.ref_table = 'sale_lines'
           and sl.sale_id = p_sale_id
         group by went.product_unit_id
      ) s
      join lateral (
        select coalesce(sum(case when ce.direction = 'out' then ce.qty else -ce.qty end), 0) as owed
          from public.customer_empties ce
         where ce.store_customer_id = v_sale.store_customer_id
           and ce.product_unit_id = s.product_unit_id
      ) o on true
     where o.owed < s.sent;
  end if;

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
  /*
   * The containers stop being owed — as a ROW, not a deletion.
   *
   * `customer_empties` is append-only on purpose, so the trace shows the crates going out and then
   * coming off, with the reason, rather than a gap where a sale used to be. The old loop reversed
   * `deposit_ledger` rows that no longer exist.
   */
  perform public.unowe_voided_sale(p_sale_id, 'sale voided: ' || btrim(p_reason));

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
$function$
;
