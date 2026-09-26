-- =====================================================================================
-- 0179 — A cancelled receipt can be opened again
--
-- Asked for as «even void, even in void open back, with version and permission and then history».
-- The reasoning behind it is the one this whole database is built on: there is a ledger, a
-- permission gate and a version history, so an action can be UNDONE in the open rather than being
-- forbidden in case somebody gets it wrong.
--
-- Cancelling a receipt by mistake is ordinary. Until now the only way back was to key the whole
-- sale again, which produces a second document with a different number while the customer holds
-- the first — exactly the mess `amend_sale` exists to avoid for corrections.
--
-- THIS IS THE EXACT INVERSE OF `void_sale`, step for step, and written against its body rather
-- than from memory of it:
--
--     void                                  reopen
--     ----                                  ------
--     stock back on the shelf               stock off the shelf again
--     containers no longer owed             containers owed again
--     deposit holding reversed              deposit holding restored
--     status = 'voided', revision + 1       status = 'posted', revision + 1
--     payments untouched, become credit     payments untouched, go back against the receipt
--
-- Every one of them an APPEND. Nothing is deleted and nothing is edited: the void is still in the
-- ledger, the reopen sits after it, and six weeks later the trail reads as what happened rather
-- than as what somebody wishes had happened.
--
-- WHY NO STOCK GUARD. Putting the goods back out can take the shelf negative if they have since
-- been sold to somebody else. That is refused nowhere else in this database either — `amend_sale`
-- re-applies lines the same way — because the shelf is a LEDGER, not a gate: it records what
-- happened, and what happened is that the shop is now short. A refusal here would leave a shop
-- unable to undo a mistake precisely when it is busiest.
-- =====================================================================================

create or replace function public.reopen_sale(p_sale_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale  record;
  v_line  record;
  v_total money_amt := 0;
  v_paid  money_amt := 0;
  v_n     int;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'that sale does not exist' using errcode = 'P0002';
  end if;

  -- The same gate as voiding and correcting. Undoing a cancellation is the same kind of act.
  if not public.has_permission(v_sale.store_id, 'sales.amend') then
    raise exception 'you do not have permission to reopen a sale' using errcode = '42501';
  end if;

  if v_sale.status <> 'voided' then
    raise exception 'that receipt is %, so there is nothing to reopen', v_sale.status
      using errcode = '22023';
  end if;

  -- A reason, always. "Why is this back" is asked by somebody who was not there, and a reopen with
  -- no reason is indistinguishable from someone quietly undoing a decision they were overruled on.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say why this receipt is being reopened' using errcode = '22023';
  end if;

  /*
   * ─── WHAT IT SAID, KEPT BEFORE ANYTHING CHANGES ────────────────────────────
   *
   * The same ledger `amend_sale` writes to, so "what has this receipt been" is one list rather
   * than two that have to be interleaved by timestamp. The document recorded is the CANCELLED one,
   * because that is the state being left.
   */
  insert into public.sale_revisions (sale_id, store_id, revision, document, reason)
  values (p_sale_id, v_sale.store_id, coalesce(v_sale.revision, 1),
          public.sale_document(p_sale_id),
          'receipt reopened: ' || btrim(p_reason));

  -- ─── The stock goes back out ────────────────────────────────────────────────
  --
  -- As a movement, never by editing the one that put it back. The void is a fact about Tuesday and
  -- stays one.
  for v_line in select * from public.sale_lines where sale_id = p_sale_id
  loop
    if v_line.base_qty <> 0 then
      insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                          ref_table, ref_id, occurred_at, note)
      values (v_sale.store_id, v_line.product_id, 'adjustment', -v_line.base_qty,
              v_line.unit_cost_at_sale, 'sales', p_sale_id, now(),
              'receipt reopened: ' || btrim(p_reason));
    end if;

    -- A count in progress must see the stock leave again, or it reports a variance nobody caused.
    perform public.refresh_period(public.ensure_open_period(v_line.product_id));
    v_total := v_total + coalesce(v_line.line_total, 0);
  end loop;

  /*
   * ─── AND THE CONTAINERS ARE OUT AGAIN ──────────────────────────────────────
   *
   * `void_sale` did not delete the rows saying the crates went out; it APPENDED rows saying they
   * came back, tagged `sale_void` and pointing at the row each one cancels. So the inverse is
   * another append — an 'out' row against each of those, tagged `sale_reopen` — and the net is the
   * customer owing them again.
   *
   * The `not exists` guard is what makes reopening twice harmless: a second call finds a
   * `sale_reopen` row already pointing at each void row and writes nothing.
   */
  insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                       direction, qty, reason, ref_table, ref_id, occurred_at)
  select back.store_id, back.store_customer_id, back.product_id, back.product_unit_id,
         'out', back.qty,
         'The receipt was reopened: ' || btrim(p_reason),
         'sale_reopen', back.id, now()
    from public.customer_empties back
    join public.customer_empties went on went.id = back.ref_id
    join public.sale_lines sl on sl.id = went.ref_id
   where back.ref_table = 'sale_void'
     and went.ref_table = 'sale_lines'
     and sl.sale_id = p_sale_id
     and not exists (
       select 1 from public.customer_empties again
        where again.ref_table = 'sale_reopen' and again.ref_id = back.id
     );
  get diagnostics v_n = row_count;

  /*
   * And the deposit the shop was holding against them. `void_sale` wrote a NEGATIVE row rather than
   * deleting the original, so this writes a positive one to match — the claim comes back, and the
   * trail shows it going, coming back and going again, which is what happened.
   */
  insert into public.deposit_holdings (store_id, store_customer_id, amount, reason,
                                       ref_table, ref_id, note, occurred_at)
  select h.store_id, h.store_customer_id, -h.amount, 'sale_reopened',
         'sales', p_sale_id, btrim(p_reason), now()
    from public.deposit_holdings h
   where h.ref_table = 'sales' and h.ref_id = p_sale_id
     and h.reason = 'sale_voided'
     and h.amount < 0;

  -- ─── And the receipt is live again ──────────────────────────────────────────
  --
  -- `customer_balance` sums only `status = 'posted'`, so this alone puts the bill back on what they
  -- owe — and the payments, which were never unmade, stop reading as loose credit and go back
  -- against this receipt.
  update public.sales
     set status       = 'posted',
         amend_reason = btrim(p_reason),
         revision     = coalesce(revision, 0) + 1,
         updated_at   = now()
   where id = p_sale_id;

  v_total := v_total + coalesce(v_sale.fee_amount, 0);

  select coalesce(sum(a.amount), 0) into v_paid
    from public.payment_allocations a
   where a.sale_id = p_sale_id;

  return jsonb_build_object(
    'sale_id',    p_sale_id,
    'revision',   coalesce(v_sale.revision, 0) + 1,
    'total',      v_total,
    'paid',       v_paid,
    'owing',      v_total - v_paid,
    'containers', v_n
  );
end;
$$;

grant execute on function public.reopen_sale(uuid, text) to authenticated;

comment on function public.reopen_sale(uuid, text) is
  'Undo a cancellation: stock out again, containers owed again, deposit restored, posted again. Every step an append. Requires sales.amend and a reason, and records the cancelled document in sale_revisions.';
