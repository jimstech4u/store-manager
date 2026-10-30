-- 0263 - Stock stays with the shelf
--
-- The owner: "we re-edit a receipt, change quantity many times, and stock is wrong when we cross-check
-- with the physical. Customer money is correct, just stock." Read from the live shop, a correction
-- never miscounts: on all 699 receipts the movements equal the lines. What drifted was around it.
--
--   A correction was always dated now, so a receipt from before a count, corrected after it, put
--   stock back that the count had already seen: Pepsi's 3 crates the customer never took were on the
--   shelf when it was counted on 5 October and were added to the records on the 6th. It is now asked:
--   did the goods move? If they did, nothing changes. If it was only the paperwork, the shelf is what
--   the count said, so the correction may explain a difference still unsettled, and otherwise does
--   not move the stock figure. A cancellation is the same question.
--
--   A difference within tolerance closed the day without reaching the ledger, so the stock figure
--   stayed off the shelf for ever. It is now booked when the day closes.
--
--   A correction, a cancellation, reopening one and a settled count all moved the ledger and never
--   the batches (`stock_layers`), which expiry and dearest-cost read. They do now.
--
-- Every one keeps its arguments and gains an optional last one, so the deployed app and the assistant
-- go on working through the moment this lands: leaving it out means the goods moved, which is what
-- has always happened. The functions are the live definitions with only these lines added.

create function public.stock_into_layers(p_store_id uuid, p_product_id uuid, p_change numeric, p_cost numeric)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_change > 0 then
    perform public.restore_stock_layer(p_store_id, p_product_id, p_change::qty, coalesce(p_cost, 0)::unit_cost);
  elsif p_change < 0 then
    perform public.consume_stock_layers(p_product_id, (-p_change)::qty);
  end if;
end;
$function$;

/*
 * A SMALL DIFFERENCE IS STILL A DIFFERENCE. A count within tolerance needs nobody to explain it, but
 * the shelf is what it is: the next day opened from the count while the ledger kept its own figure,
 * so the stock screen and the count screen disagreed by that much for ever. Dated a millisecond inside
 * the count, for the reason `resolve_variance` gives. Anything already explained is left alone.
 */
create function public.book_small_difference(p_period_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_p    record;
  v_cost unit_cost;
  v_id   uuid;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found or coalesce(v_p.variance_qty, 0) = 0 then
    return;
  end if;
  if exists (select 1 from public.variance_resolutions where stock_period_id = p_period_id) then
    return;
  end if;

  select coalesce(avg_unit_cost, 0) into v_cost from public.products where id = v_p.product_id;

  insert into public.variance_resolutions (store_id, stock_period_id, qty, reason, reason_label, note, value_at_cost)
  values (v_p.store_id, p_period_id, v_p.variance_qty, 'other', 'Small difference at the count',
          'Within tolerance: the stock figure follows the shelf', abs(v_p.variance_qty) * v_cost)
  returning id into v_id;

  insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost, ref_table, ref_id, note, occurred_at)
  values (v_p.store_id, v_p.product_id, 'adjustment', v_p.variance_qty, v_cost, 'variance_resolutions', v_id,
          'Small difference at the count', coalesce(v_p.counted_at - interval '1 millisecond', now()));

  perform public.stock_into_layers(v_p.store_id, v_p.product_id, v_p.variance_qty, v_cost);
  perform public.refresh_period(p_period_id);
end;
$function$;

/*
 * WHAT A CORRECTION MEANS TO THE SHELF. `p_change` is what it did to the stock of one item, all told:
 * more on the shelf is positive. `amend_sale` has already written it to the ledger, dated now.
 *
 * With no count since the sale, or when the goods really moved (`p_goods_moved` not false), that is
 * right and only the batches follow.
 *
 * WHEN IT WAS ONLY THE PAPERWORK and a count has been taken since, the count already saw the shelf
 * as it really was. A difference that count left unsettled, in the same direction, is what this
 * correction explains: that much stays in the ledger, is dated inside the count so the next day does
 * not take it a second time, and comes off the difference. The rest is taken back out, because the
 * shelf did not change. The receipt's own movements are left exactly as written, so they still equal
 * its lines; the taking back is a movement of its own, saying why.
 */
create function public.stock_change_after_count(
  p_sale_id uuid, p_product_id uuid, p_change numeric, p_cost numeric, p_goods_moved boolean, p_reason text
)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sale   record;
  v_count  record;
  v_held   numeric;
  v_absorb numeric := 0;
begin
  if coalesce(p_change, 0) = 0 then
    return;
  end if;

  select store_id, occurred_at into v_sale from public.sales where id = p_sale_id;

  select * into v_count
    from public.stock_periods sp
   where sp.product_id = p_product_id and sp.counted_at > v_sale.occurred_at
   order by sp.counted_at desc
   limit 1;

  if not found or p_goods_moved is not false then
    perform public.stock_into_layers(v_sale.store_id, p_product_id, p_change, p_cost);
    return;
  end if;

  v_held := case when v_count.status = 'open' then coalesce(v_count.variance_qty, 0) else 0 end;
  if sign(v_held) = sign(p_change) then
    v_absorb := sign(p_change) * least(abs(p_change), abs(v_held));
  end if;

  insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost, ref_table, ref_id, occurred_at, note)
  values (v_sale.store_id, p_product_id, 'adjustment', -p_change, coalesce(p_cost, 0), 'sale_revisions', p_sale_id, now(),
          'the count already saw this: ' || p_reason);

  if v_absorb <> 0 then
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost, ref_table, ref_id, occurred_at, note)
    values (v_sale.store_id, p_product_id, 'adjustment', v_absorb, coalesce(p_cost, 0), 'sale_revisions', p_sale_id,
            v_count.counted_at - interval '1 millisecond', 'explains the count: ' || p_reason);

    update public.stock_periods
       set expected_at_count = coalesce(expected_at_count, expected_closing_qty) + v_absorb
     where id = v_count.id;

    perform public.stock_into_layers(v_sale.store_id, p_product_id, v_absorb, p_cost);
  end if;

  perform public.refresh_period(public.ensure_open_period(p_product_id));
end;
$function$;

/* Which items a correction would change that have been counted since the sale: when to ask. */
create function public.correction_touches_a_count(p_sale_id uuid, p_lines jsonb default null)
 returns table(product_id uuid, product_name text, stock_change numeric, counted_at timestamptz)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  with s as (
    select id, store_id, occurred_at from public.sales
     where id = p_sale_id and public.is_store_member(store_id)
  ),
  was as (
    select sl.product_id, sum(sl.base_qty) as qty from public.sale_lines sl join s on s.id = sl.sale_id group by 1
  ),
  now_is as (
    select (l ->> 'product_id')::uuid as product_id, sum((l ->> 'base_qty')::numeric) as qty
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l group by 1
  ),
  change as (
    select coalesce(w.product_id, n.product_id) as product_id, coalesce(w.qty, 0) - coalesce(n.qty, 0) as stock_change
      from was w full join now_is n on n.product_id = w.product_id
  )
  select c.product_id, p.name, c.stock_change, lc.counted_at
    from change c
    join public.products p on p.id = c.product_id
    cross join s
    cross join lateral (select max(sp.counted_at) as counted_at from public.stock_periods sp
                         where sp.product_id = c.product_id and sp.counted_at > s.occurred_at) lc
   where abs(c.stock_change) > 0.0001 and lc.counted_at is not null
   order by p.name;
$function$;

revoke all on function public.stock_into_layers(uuid, uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function public.book_small_difference(uuid) from public, anon, authenticated;
revoke all on function public.stock_change_after_count(uuid, uuid, numeric, numeric, boolean, text) from public, anon, authenticated;
grant execute on function public.correction_touches_a_count(uuid, jsonb) to authenticated, service_role;

drop function public.correct_sale(uuid, text, jsonb, uuid, jsonb, jsonb, money_amt, text, uuid[], boolean);
drop function public.amend_sale(uuid, text, jsonb, uuid, jsonb, jsonb, money_amt, text);
drop function public.void_sale(uuid, text);

CREATE OR REPLACE FUNCTION public.void_sale(p_sale_id uuid, p_reason text, p_goods_moved boolean DEFAULT NULL::boolean)
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
  v_moved record;
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

  -- The batches, and any count taken since the sale (0263).
  for v_moved in
    select sl.product_id, sum(sl.base_qty) as qty, max(sl.unit_cost_at_sale) as cost
      from public.sale_lines sl where sl.sale_id = p_sale_id group by sl.product_id
  loop
    perform public.stock_change_after_count(p_sale_id, v_moved.product_id, v_moved.qty, v_moved.cost,
                                            p_goods_moved, btrim(p_reason));
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
$function$;

CREATE OR REPLACE FUNCTION public.amend_sale(p_sale_id uuid, p_reason text, p_lines jsonb DEFAULT NULL::jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT NULL::jsonb, p_payments jsonb DEFAULT NULL::jsonb, p_deposit money_amt DEFAULT (NULL::numeric)::money_amt, p_deposit_reason text DEFAULT NULL::text, p_goods_moved boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_deposit    money_amt;
  v_sale     record;
  v_line     record;
  v_new      jsonb;
  v_customer uuid;
  v_total    money_amt := 0;
  v_paid     money_amt := 0;
  v_charge   record;
  v_pay      record;
  v_fee      money_amt;
  v_amount   money_amt;
  v_payment  uuid;
  v_sort     int := 0;
  v_owing    money_amt;
  v_out      numeric := 0;
  v_prod     uuid;
  v_unit     uuid;
  v_entered  numeric;
  v_base     numeric;
  v_price    numeric;
  v_ltotal   numeric;
  v_cout     numeric;
  v_cost     unit_cost;
  v_line_id  uuid;
  v_rev      int;
  v_before   jsonb;
  v_moved    record;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'that sale does not exist' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_sale.store_id, 'sales.amend') then
    raise exception 'you do not have permission to correct a sale' using errcode = '42501';
  end if;

  if v_sale.status <> 'posted' then
    raise exception 'that sale is %, so there is nothing to correct', v_sale.status
      using errcode = '22023';
  end if;

  -- A reason, always. "Why does this receipt differ from the one I was given" is asked weeks later
  -- by somebody who was not there, and it is the part that settles the argument.
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say why this receipt is being corrected' using errcode = '22023';
  end if;

  /*
   * NOT IF THE CONTAINERS HAVE STARTED COMING BACK.
   *
   * The same guard `void_sale` keeps, and for the same reason: reversing four crates when three
   * have already been handed in leaves the customer owing minus one, which means nothing and
   * cannot be chased. The way out is to finish settling first, and the message says so.
   */
  if exists (
    select 1 from public.customer_empties
     where ref_table = 'sale_lines'
       and ref_id in (select id from public.sale_lines where sale_id = p_sale_id)
       and direction in ('returned', 'damaged')
  ) then
    raise exception
      'Some of the containers on this receipt have already come back. Settle the rest first, then correct it.'
      using errcode = '22023';
  end if;

  v_customer := coalesce(p_customer_id, v_sale.store_customer_id);
  v_new      := coalesce(p_lines, (public.sale_document(p_sale_id) -> 'lines'));

  /*
   * ─── TAKING EVERYTHING OFF A RECEIPT CANCELS IT ──────────────────────────────────
   *
   * The correction screen is the till: a seller removes the lines that should not be there. Remove
   * the last one and the honest answer is that the sale did not happen — and until now this
   * function would have written it as a POSTED receipt with no lines on it, whose total was
   * whatever transport had been added. A document that says a customer owes ₦2,000 for nothing.
   *
   * Handed to `void_sale` rather than reimplemented, and BEFORE anything here is reversed. Voiding
   * is not "amending to zero": it puts the stock back, releases the containers, unallocates the
   * payments and marks the sale cancelled so the copy the customer is holding reads as cancelled
   * when they open it. Reimplementing a subset of that is how two different cancellations come to
   * exist, and only one of them tells the customer.
   *
   * `void_sale` keeps its own guards — the same `sales.amend` permission, and its refusal when
   * containers have started coming back — so nothing is loosened by arriving through here.
   *
   * WHY NOT REFUSE AND MAKE THEM PRESS VOID: because the seller has already said what they mean.
   * Emptying a receipt and being told to go and do a different thing instead is the software
   * arguing with somebody who is right.
   */
  if v_new is null
     or jsonb_typeof(v_new) <> 'array'
     or not exists (
       select 1 from jsonb_array_elements(v_new) as t(l)
        where coalesce(
                (t.l ->> 'entered_qty')::numeric,
                (t.l ->> 'qty')::numeric,
                0
              ) <> 0
     )
  then
    perform public.void_sale(p_sale_id, btrim(p_reason), p_goods_moved);
    return jsonb_build_object(
      'sale_id',     p_sale_id,
      'revision',    v_sale.revision,
      'total',       0,
      'paid',        0,
      'owing',       0,
      'customer_id', v_sale.store_customer_id,
      -- The caller has to know it was cancelled rather than corrected: it sends the seller to a
      -- cancelled receipt, not to a new revision of a live one.
      'voided',      true
    );
  end if;

  /*
   * AND THE CUSTOMER, IF ONE IS BEING ATTACHED, HAS TO BE THIS SHOP'S.
   *
   * Permission in a store answers "may this person act here", never "is this customer theirs" —
   * the hole 0097 and 0098 closed across the trade writers. Asked where no optional argument can
   * skip it.
   */
  if p_customer_id is not null then
    if not exists (
      select 1 from public.store_customers
       where id = p_customer_id and store_id = v_sale.store_id
    ) then
      raise exception 'that customer is not yours' using errcode = '42501';
    end if;
  end if;

  -- ─── Keep what it says now, before anything changes it ────────────────────────────
  v_rev := coalesce(v_sale.revision, 1);
  insert into public.sale_revisions (sale_id, store_id, revision, document, reason)
  values (p_sale_id, v_sale.store_id, v_rev, public.sale_document(p_sale_id)
                 -- THE RECEIPT AS THE CUSTOMER HELD IT (0257): every line of the paper, Still with you,
                 -- the balance, the deposit and the change, read as at that version.
                 || jsonb_build_object('paper', public.sale_detail(p_sale_id)),
          btrim(p_reason));

  -- ─── Reverse everything the sale did ──────────────────────────────────────────────
  --
  -- Exactly as `void_sale` does it: a second movement saying what happened next, never an edit to
  -- the first. The original is a fact about Tuesday and stays one.
  -- What the receipt took of each item, to weigh against what it takes now (0263).
  select coalesce(jsonb_agg(jsonb_build_object('product_id', b.product_id, 'qty', b.qty, 'cost', b.cost)), '[]'::jsonb)
    into v_before
    from (select sl.product_id, sum(sl.base_qty) as qty, max(sl.unit_cost_at_sale) as cost
            from public.sale_lines sl where sl.sale_id = p_sale_id group by sl.product_id) b;

  for v_line in select * from public.sale_lines where sale_id = p_sale_id
  loop
    if v_line.base_qty <> 0 then
      insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                          ref_table, ref_id, occurred_at, note)
      values (v_sale.store_id, v_line.product_id, 'adjustment', v_line.base_qty,
              v_line.unit_cost_at_sale, 'sales', p_sale_id, now(),
              'receipt corrected: ' || btrim(p_reason));
    end if;

    -- The containers this line owed are no longer owed in that quantity.
    insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                         direction, qty, reason, ref_table, ref_id, side,
                                         occurred_at)
    select ce.store_id, ce.store_customer_id, ce.product_id, ce.product_unit_id,
           'returned', ce.qty, 'receipt corrected: ' || btrim(p_reason), 'sale_lines', ce.ref_id,
           ce.side,
           /*
            * DATED TO THE ROW IT REVERSES, not to the moment of correcting.
            *
            * `sale_detail` prints what a customer still holds AS AT THE SALE, so a receipt
            * reprinted next month says what it said the day it was handed over. Stamped with
            * `now()`, this reversal fell OUTSIDE that window while the line re-inserted below is
            * stamped with the sale's own time and falls inside it — so an as-at view counted the
            * containers twice and missed the cancelling entry.
            *
            * Destiny's receipt: half a crate of 7up sold, half a crate owed on her account, and
            * "Still with you — Seven-Up (SBC) crate 1" on the paper.
            *
            * This is not back-dating a fact. The fact is "that row should not have said what it
            * said", and it is about that moment; the reason and the revision record when it was
            * noticed.
            */
           ce.occurred_at
      from public.customer_empties ce
     where ce.ref_table = 'sale_lines' and ce.ref_id = v_line.id and ce.direction = 'out';

    perform public.refresh_period(public.ensure_open_period(v_line.product_id));
  end loop;

  /*
   * WHAT EACH PRODUCT WAS HOLDING ON DEPOSIT, remembered before the lines are thrown away.
   *
   * This function rewrites `sale_lines` wholesale and never wrote `deposit_charged`, so every
   * correction silently reset it to zero. A shop fixing a quantity on a receipt that carried
   * N400 against the crates lost the N400 from the record — and the customer is still owed it,
   * because the money genuinely changed hands.
   *
   * Kept per PRODUCT rather than per line: the lines are being replaced and their ids are gone,
   * so the product is the only thing that survives the rewrite to match on.
   *
   * This PRESERVES, it does not edit. Changing a deposit is a different act with a different
   * record — it is money held for somebody, so it moves through the customer's ledger, not by
   * being typed over on a correction screen.
   */
  create temporary table if not exists amend_deposit_held (
    product_id uuid primary key,
    amount     numeric not null
  ) on commit drop;
  -- WITH A WHERE CLAUSE. This session runs with safe updates on, so a bare DELETE is refused
  -- outright — and because it sits at the top of `amend_sale`, it refused every correction.
  delete from amend_deposit_held where true;

  insert into amend_deposit_held (product_id, amount)
  select sl.product_id, sum(sl.deposit_charged)
    from public.sale_lines sl
   where sl.sale_id = p_sale_id and coalesce(sl.deposit_charged, 0) > 0
   group by sl.product_id;

  delete from public.sale_lines where sale_id = p_sale_id;

  -- ─── And apply what it should have said ───────────────────────────────────────────
  update public.sales
     set store_customer_id = v_customer
   where id = p_sale_id;

  /*
   * AND THE MONEY ALREADY PAID FOLLOWS IT ONTO THE ACCOUNT.
   *
   * A walk-in's payment carries no customer, because there was nobody to carry. Attach a customer
   * to the receipt and leave the payment behind and `customer_balance` bills them for the whole
   * amount while the ₦8,000 they actually handed over sits against nobody — so somebody who owes
   * ₦4,000 is shown owing ₦12,000, and would be chased for it.
   *
   * Only payments ALLOCATED to this receipt, and only when the sale had no customer before: a
   * payment already belonging to somebody is not this correction's business.
   */
  if v_sale.store_customer_id is null and v_customer is not null then
    update public.payments p
       set store_customer_id = v_customer
      from public.payment_allocations a
     where a.payment_id = p.id
       and a.sale_id = p_sale_id
       and p.store_customer_id is null;
  end if;

  /*
   * MOVED TO ANOTHER CUSTOMER, AND ITS COUNTER MONEY GOES WITH IT (0240).
   *
   * The receipt was on the wrong person. Whatever was handed over for THIS receipt — at the sale,
   * or during one of its corrections — and paid nothing else, was paid by whoever was really
   * there. Left behind, the right customer is billed in full while the wrong one shows credit.
   * A payment that also paid other receipts belongs to its customer and stays.
   */
  if v_sale.store_customer_id is not null and v_customer is distinct from v_sale.store_customer_id then
    update public.payments p
       set store_customer_id = v_customer
     where p.store_customer_id = v_sale.store_customer_id
       and p.reverses_payment_id is null
       and exists (select 1 from public.payment_allocations a
                    where a.payment_id = p.id and a.sale_id = p_sale_id)
       and not exists (select 1 from public.payment_allocations a
                        where a.payment_id = p.id and a.sale_id <> p_sale_id)
       and (p.occurred_at = v_sale.occurred_at
            or p.occurred_at in (select r.amended_at from public.sale_revisions r
                                  where r.sale_id = p_sale_id));
  end if;

  for v_line in select * from jsonb_array_elements(v_new) as t(l)
  loop
    v_prod    := (v_line.l ->> 'product_id')::uuid;
    v_unit    := nullif(v_line.l ->> 'sale_unit_id', '')::uuid;
    v_entered := coalesce((v_line.l ->> 'entered_qty')::numeric, (v_line.l ->> 'qty')::numeric);
    v_base    := (v_line.l ->> 'base_qty')::numeric;
    v_price   := coalesce((v_line.l ->> 'unit_price')::numeric, 0);
    v_ltotal  := coalesce((v_line.l ->> 'line_total')::numeric, v_entered * v_price);
    v_cout    := coalesce((v_line.l ->> 'containers_out')::numeric, 0);

    if not exists (
      select 1 from public.products where id = v_prod and store_id = v_sale.store_id
    ) then
      raise exception 'one of these items is not yours' using errcode = '42501';
    end if;

    -- The shape has to belong to the product; a client-authored id is never trusted, and the base
    -- quantity is derived from it when the caller did not send one.
    if v_unit is not null then
      if not exists (
        select 1 from public.product_units where id = v_unit and product_id = v_prod
      ) then
        raise exception 'that shape does not belong to that item' using errcode = '22023';
      end if;
      if v_base is null then
        select v_entered * base_qty into v_base from public.product_units where id = v_unit;
      end if;
    end if;
    v_base := coalesce(v_base, v_entered);

    select coalesce(avg_unit_cost, 0) into v_cost from public.products where id = v_prod;

    /*
     * The deposit this product was carrying, handed to the first corrected line that replaces it
     * and then spent, so two lines of one product do not each claim the whole of it.
     */
    select coalesce(h.amount, 0) into v_deposit
      from amend_deposit_held h where h.product_id = v_prod;
    delete from amend_deposit_held where product_id = v_prod;

    insert into public.sale_lines (sale_id, product_id, sale_unit_id, entered_qty, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out,
                                   deposit_charged)
    values (p_sale_id, v_prod, v_unit, v_entered, v_base, v_price, v_ltotal, v_cost, v_cout,
            coalesce(v_deposit, 0))
    returning id into v_line_id;

    /*
     * NOT BELOW ZERO (0186), and only HERE.
     *
     * Everything the sale did was reversed above, so the stock is already back on the shelf by
     * this point and the check sees what a corrected sale would really leave. Asking any earlier
     * would refuse a correction that is reducing a quantity — the very thing a shop does to fix
     * an over-sale.
     */
    perform public.assert_stock_available(v_prod, v_base);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at, note)
    values (v_sale.store_id, v_prod, 'sale', -v_base, v_cost, 'sales', p_sale_id, now(),
            'receipt corrected: ' || btrim(p_reason));

    perform public.refresh_period(public.ensure_open_period(v_prod));

    v_total := v_total + v_ltotal;
  end loop;

  /*
   * WHAT THE CORRECTION DID TO EACH ITEM, ALL TOLD (0263). Batches follow it, and a count taken since
   * the sale decides what it means: see `stock_change_after_count`.
   */
  for v_moved in
    select coalesce(o.product_id, n.product_id) as product_id,
           coalesce(o.qty, 0) - coalesce(n.qty, 0) as change,
           coalesce(o.cost, n.cost) as cost
      from jsonb_to_recordset(v_before) as o(product_id uuid, qty numeric, cost numeric)
      full join (select sl.product_id, sum(sl.base_qty) as qty, max(sl.unit_cost_at_sale) as cost
                   from public.sale_lines sl where sl.sale_id = p_sale_id group by sl.product_id) n
        on n.product_id = o.product_id
  loop
    perform public.stock_change_after_count(p_sale_id, v_moved.product_id, v_moved.change, v_moved.cost,
                                            p_goods_moved, btrim(p_reason));
  end loop;

  /*
   * ─── THE NAMED CHARGES, AS THE CORRECTED RECEIPT SHOULD READ THEM ──────────
   *
   * Replaced rather than merged: a seller looking at the correction screen is looking at the list
   * they want the receipt to end up with, and merging would make deleting one impossible.
   *
   * `sales.fee_amount` is kept in step because it is what the TOTAL is built from — the itemised
   * list is what the receipt prints and the sum is what the arithmetic uses, and a receipt whose
   * printed charges do not add up to its total is the one nobody can explain.
   */
  if p_charges is not null then
    delete from public.sale_charges where sale_id = p_sale_id;
    v_fee := 0;
    for v_charge in select * from jsonb_array_elements(p_charges) as t(c)
    loop
      v_amount := coalesce((v_charge.c ->> 'amount')::money_amt, 0);
      if v_amount <> 0 then
        insert into public.sale_charges (sale_id, label, amount, sort_order)
        values (p_sale_id,
                coalesce(nullif(btrim(v_charge.c ->> 'label'), ''), 'Extra charge'),
                v_amount, v_sort);
        v_fee := v_fee + v_amount;
        v_sort := v_sort + 1;
      end if;
    end loop;

    update public.sales
       set fee_amount = v_fee,
           -- One label, for the older readers that show a single lumped charge. The itemised list
           -- above is what the receipt prints.
           fee_label  = case when v_sort = 1
                             then (select label from public.sale_charges where sale_id = p_sale_id)
                             when v_sort > 1 then 'Extra charges'
                             else null end
     where id = p_sale_id;

    v_sale.fee_amount := v_fee;
  end if;

  v_total := v_total + coalesce(v_sale.fee_amount, 0);

  update public.sales
     set total        = v_total,
         revision     = v_rev + 1,
         amend_reason = btrim(p_reason),
         updated_at   = now()
   where id = p_sale_id;

  /*
   * ─── AND AN OBLIGATION NEEDS SOMEBODY TO OWE IT ─────────────────────────────────
   *
   * Checked AFTER the new lines are in, because whether one exists is a fact about the corrected
   * receipt and not about the old one. A walk-in sale corrected into something that leaves money
   * owing or containers out has nobody on the other end: the debt cannot be chased and the crates
   * cannot be settled, so they would sit on the "still out" list for ever.
   */
  /*
   * WHAT HAS BEEN PAID AGAINST THIS RECEIPT, through `payment_allocations`.
   *
   * `payments` has no `ref_table`/`ref_id` — a payment is a sum of money that arrived, and which
   * receipts it settles is a separate fact, because one payment can clear three receipts and one
   * receipt can take four payments. A first draft of this function read a `payments.ref_id` that
   * does not exist; plpgsql does not check column names until the body RUNS, so it applied cleanly
   * and would have failed on the first real correction.
   */
  /*
   * ─── MONEY HANDED OVER WHILE THE RECEIPT WAS BEING CORRECTED ───────────────
   *
   * A correction routinely finds more owing — a crate that went out and was never keyed — and the
   * customer pays the difference there and then. Recorded the same way `settle_draft_with_deposit`
   * records one: a payment row, and an ALLOCATION to this receipt.
   *
   * The allocation is the part that matters and the part that was once missed elsewhere. `payments`
   * has no `sale_id`; everything that reports what a receipt was paid reads `payment_allocations`.
   * Without it the money exists, unattached, while the receipt still reads as owing its full total —
   * and the customer gets chased for what they have already handed over.
   */
  /*
   * NEVER PAID PAST ITS TOTAL (0240). Corrected below what was already paid, the receipt keeps only
   * its total — the newest money comes off first — and the rest is the customer's credit (or, on a
   * walk-in, change to hand back). The balance counts payments, not allocations, so no account moves.
   */
  declare
    v_over  numeric;
    v_alloc record;
  begin
    v_over := coalesce((select sum(amount) from public.payment_allocations
                         where sale_id = p_sale_id), 0) - v_total;
    for v_alloc in select * from public.payment_allocations
                    where sale_id = p_sale_id
                    order by created_at desc, id desc
    loop
      exit when v_over <= 0;
      if v_alloc.amount <= v_over then
        delete from public.payment_allocations where id = v_alloc.id;
        v_over := v_over - v_alloc.amount;
      else
        update public.payment_allocations set amount = amount - v_over where id = v_alloc.id;
        v_over := 0;
      end if;
    end loop;
  end;

  if p_payments is not null then
    for v_pay in select * from jsonb_array_elements(p_payments) as t(p)
    loop
      v_amount := coalesce((v_pay.p ->> 'amount')::money_amt, 0);
      if v_amount > 0 then
        insert into public.payments (store_id, store_customer_id, amount, method, reference,
                                     bank_account_id, occurred_at)
        values (v_sale.store_id, v_customer, v_amount,
                coalesce(v_pay.p ->> 'method', 'cash'),
                nullif(v_pay.p ->> 'reference', ''),
                nullif(v_pay.p ->> 'bank_account_id', '')::uuid,
                now())
        returning id into v_payment;

        -- This receipt first, never past its total; any surplus pays older debts, then is credit.
        perform public.allocate_payment(v_payment, p_sale_id);
      end if;
    end loop;
  end if;

  /*
   * And a deposit against the containers this correction puts out. Only with somebody to hold it
   * for: a deposit belongs to a customer, and one taken against nobody could never be given back.
   */
  if p_deposit is not null and p_deposit > 0 and v_customer is not null then
    /*
     * TAKEN AS A SALE TAKES ONE (0258): the customer's deposit, and the one line that moves it out of
     * the account, at the correction's moment. This wrote `deposit_holdings` with a reason its own
     * check has never allowed ('sale_amended'), so every correction that added a deposit failed.
     */
    perform public.take_customer_deposit(v_sale.store_id, v_customer, p_deposit,
                                         nullif(btrim(coalesce(p_deposit_reason, '')), ''), now());
    insert into public.customer_charges (store_id, store_customer_id, direction, amount, reason, occurred_at)
    values (v_sale.store_id, v_customer, 'charge', p_deposit,
            'Put down as a deposit' || coalesce(' (' || nullif(btrim(coalesce(p_deposit_reason, '')), '') || ')', ''),
            now());
  end if;

  select coalesce(sum(a.amount), 0) into v_paid
    from public.payment_allocations a
   where a.sale_id = p_sale_id;

  v_owing := v_total - v_paid;

  select coalesce(sum(containers_out), 0) into v_out
    from public.sale_lines where sale_id = p_sale_id;

  if v_customer is null and (v_owing > 0 or v_out > 0) then
    raise exception
      'This receipt now leaves % owing and % containers out. Add a customer, because there has to be somebody to owe it.',
      v_owing, v_out
      using errcode = '22023';
  end if;

  /*
   * THE CONTAINERS ARE ALREADY WRITTEN, by the trigger, and must not be written again.
   *
   * `tg_sale_line_owes_containers` (0117) fires on INSERT and returns early when the sale has no
   * customer. The customer is attached ABOVE, before the new lines go in — so by the time the
   * trigger sees them there is somebody to owe the crates, and it does the job itself.
   *
   * A first version also inserted them here "because the walk-in never had them", which doubled
   * every obligation on a corrected walk-in: three crates became six. The probe caught it as
   * «8, expected 2 + 3». Attaching the customer before the lines is what makes the extra insert
   * both unnecessary and wrong.
   */

  return jsonb_build_object(
    'sale_id',      p_sale_id,
    'revision',     v_rev + 1,
    'total',        v_total,
    'paid',         v_paid,
    'owing',        v_owing,
    'customer_id',  v_customer,
    -- Always present, so a caller reads one shape rather than testing whether a key exists.
    'voided',       false
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.correct_sale(p_sale_id uuid, p_reason text, p_lines jsonb DEFAULT NULL::jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT NULL::jsonb, p_payments jsonb DEFAULT NULL::jsonb, p_deposit money_amt DEFAULT NULL::numeric, p_deposit_reason text DEFAULT NULL::text, p_take_back uuid[] DEFAULT NULL::uuid[], p_cancel_deposit boolean DEFAULT false, p_goods_moved boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sale public.sales;
  v_id   uuid;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'that sale does not exist' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_sale.store_id, 'sales.amend') then
    raise exception 'you do not have permission to correct a sale' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say why this receipt is being corrected' using errcode = '22023';
  end if;

  -- Only money that paid THIS receipt can be taken back through its correction.
  foreach v_id in array coalesce(p_take_back, '{}'::uuid[])
  loop
    if not exists (select 1 from public.payment_allocations a
                    where a.payment_id = v_id and a.sale_id = p_sale_id) then
      raise exception 'that payment is not on this receipt' using errcode = '22023';
    end if;
    perform public.void_payment(v_id, 'Taken back in a correction: ' || btrim(p_reason));
  end loop;

  if coalesce(p_cancel_deposit, false) then
    perform public.cancel_sale_deposit(p_sale_id, btrim(p_reason));
  end if;

  return public.amend_sale(p_sale_id, p_reason, p_lines, p_customer_id, p_charges, p_payments,
                           p_deposit, p_deposit_reason, p_goods_moved);
end;
$function$;

CREATE OR REPLACE FUNCTION public.reopen_sale(p_sale_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      perform public.stock_into_layers(v_sale.store_id, v_line.product_id, -v_line.base_qty, v_line.unit_cost_at_sale);
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
$function$;

CREATE OR REPLACE FUNCTION public.resolve_variance(p_period_id uuid, p_parts jsonb, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_p        record;
  v_avg_cost unit_cost;
  v_parts    jsonb;
  v_part     jsonb;
  v_qty      numeric;
  v_reason   text;
  -- What the SHOP called it. 'unlogged_damage' is the treatment; "Fell off the truck" is the reason
  -- somebody will recognise in a report six weeks later.
  v_label    text;
  v_sum      numeric := 0;
  v_id       uuid;
  v_ids      uuid[] := '{}';
  v_member   uuid;
  v_customer uuid;
  v_charge   numeric;
  v_sign     int;
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

  /*
   * A BARE OBJECT IS ONE PART.
   *
   * The single-reason case is still the common one — most gaps are a miscount — and making every
   * caller wrap it in an array would be ceremony for nothing.
   */
  v_parts := case
               when jsonb_typeof(p_parts) = 'object' then jsonb_build_array(p_parts)
               else p_parts
             end;

  if v_parts is null or jsonb_typeof(v_parts) <> 'array' or jsonb_array_length(v_parts) = 0 then
    raise exception 'say what happened to the missing stock' using errcode = '22023';
  end if;

  select avg_unit_cost into v_avg_cost from public.products where id = v_p.product_id;

  /*
   * THE PARTS MUST ADD UP TO THE VARIANCE, EXACTLY.
   *
   * Not "at most". A remainder is an unexplained shortfall, and an unexplained shortfall is the one
   * thing a period is not allowed to close on — letting the parts fall short would move that gap
   * from a blocked close to a number nobody ever looks at again.
   *
   * The parts are given as PLAIN QUANTITIES and take the variance's sign. Asking somebody to type
   * "-24" for twenty-four broken bottles is asking for a sign error in front of a shelf.
   */
  v_sign := case when v_p.variance_qty < 0 then -1 else 1 end;

  for v_part in select * from jsonb_array_elements(v_parts)
  loop
    v_qty := abs((v_part ->> 'qty')::numeric);
    if v_qty is null or v_qty <= 0 then
      raise exception 'each reason needs a quantity' using errcode = '22023';
    end if;
    v_sum := v_sum + v_qty;
  end loop;

  if v_sum <> abs(v_p.variance_qty) then
    raise exception 'the reasons add up to %, but the count is off by % — every one has to be accounted for',
      v_sum, abs(v_p.variance_qty) using errcode = '22023';
  end if;

  for v_part in select * from jsonb_array_elements(v_parts)
  loop
    v_qty    := abs((v_part ->> 'qty')::numeric) * v_sign;
    v_reason := v_part ->> 'reason';
    v_label  := nullif(v_part ->> 'label', '');
    v_member := nullif(v_part ->> 'charge_to_member_id', '')::uuid;  -- a user_id in this shop
    v_customer := nullif(v_part ->> 'charge_to_customer_id', '')::uuid;

    insert into public.variance_resolutions (store_id, stock_period_id, qty, reason, reason_label,
                                             note, value_at_cost)
    values (v_p.store_id, p_period_id, v_qty, v_reason, v_label,
            coalesce(v_part ->> 'note', p_note),
            case when v_reason = 'miscount' then 0
                 else abs(v_qty) * coalesce(v_avg_cost, 0) end)
    returning id into v_id;
    v_ids := v_ids || v_id;

    /*
     * ONE MOVEMENT PER PART, and the KIND says which.
     *
     * The old function wrote a single blended `adjustment`. Twenty-four broken and thirty-five
     * stolen became "adjustment 59", and no report could ever separate them again — which is the
     * report an owner actually wants. `damage` is its own movement kind and has been since 0003.
     */
    if v_reason = 'miscount' then
      -- To the figure the count was MEASURED against, which is what "I miscounted" means (0218).
      update public.stock_periods
         set actual_closing_qty = coalesce(expected_at_count, expected_closing_qty)
       where id = p_period_id;
    else
      insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                          ref_table, ref_id, note, occurred_at)
      values (v_p.store_id, v_p.product_id,
              case when v_reason = 'unlogged_damage' then 'damage' else 'adjustment' end,
              v_qty, coalesce(v_avg_cost, 0), 'variance_resolutions', v_id,
              coalesce(v_part ->> 'note', p_note, v_reason),
              /*
               * DATED INSIDE THE PERIOD IT SETTLES (0216, corrected by 0217).
               *
               * A resolution is not a new event in the shop's day. It explains a difference the
               * count FOUND — breakage, or a theft that happened during the period — so it
               * belongs before the count rather than after it.
               *
               * Stamped `now()` it fell outside the period's window once 0213 ended that window
               * at `counted_at`, so a resolution stopped reconciling the period it was resolving.
               * Stamped exactly AT `counted_at` it fell into the NEXT period instead — the window
               * ends exclusively and the next one begins there — so the loss came off a second
               * time, from an opening figure that already reflected it. A millisecond inside the
               * boundary is the one place it is counted once.
               */
              coalesce(v_p.counted_at - interval '1 millisecond', now()));
      perform public.stock_into_layers(v_p.store_id, v_p.product_id, v_qty, coalesce(v_avg_cost, 0));
    end if;

    /*
     * AND WHO ANSWERS FOR IT, when somebody does.
     *
     * The amount defaults to what the stock cost and can be overridden, because a shop recovers
     * what it sells for rather than what it paid. Naming nobody is the common case and stays
     * perfectly valid — a form that demands a culprit gets a guess, and a guess in this table is
     * worse than a blank.
     */
    if v_member is not null or v_customer is not null then
      v_charge := coalesce((v_part ->> 'charge_amount')::numeric,
                           abs(v_qty) * coalesce(v_avg_cost, 0));

      if v_charge > 0 and v_member is not null then
        perform public.record_staff_charge(
          v_p.store_id, v_member, v_charge, 'charged',
          coalesce(v_part ->> 'note', 'Stock missing at a count'),
          'variance_resolutions', v_id);
      end if;

      if v_charge > 0 and v_customer is not null then
        perform public.record_customer_charge(
          v_p.store_id, v_customer, v_charge,
          coalesce(v_part ->> 'note', 'Stock missing at a count'),
          false);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'period_id', p_period_id,
    'parts',     jsonb_array_length(v_parts),
    'ids',       to_jsonb(v_ids)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.close_stock_period(p_period_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_p        record;
  v_resolved numeric;
  v_next_id  uuid;
  v_at       timestamptz;
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

  if v_p.variance_qty is distinct from 0
     and not public.variance_within_tolerance(p_period_id) then
    select coalesce(sum(abs(qty)), 0) into v_resolved
      from public.variance_resolutions where stock_period_id = p_period_id;

    if v_resolved < abs(v_p.variance_qty) then
      raise exception
        'this period is off by %, and only % of that has been explained',
        abs(v_p.variance_qty), v_resolved
        using errcode = '22023';
    end if;
  end if;

  /*
   * THE PERIOD ENDS AT THE COUNT, not at the moment somebody pressed close (0213).
   *
   * Otherwise every sale between the two is pulled back into a period whose closing figure was
   * measured before they happened — the same fault `refresh_period` had, arriving by a different
   * road. The next period starts at the same instant, so nothing falls in a gap.
   */
  v_at := coalesce(v_p.counted_at, now());
  perform public.book_small_difference(p_period_id);

  update public.stock_periods
     set status     = 'closed',
         period_end = v_at,
         closed_by  = auth.uid(),
         closed_at  = now()
   where id = p_period_id;

  insert into public.stock_periods (store_id, product_id, period_start, opening_qty, status)
  values (v_p.store_id, v_p.product_id, v_at, v_p.actual_closing_qty, 'open')
  returning id into v_next_id;

  perform public.refresh_period(v_next_id);

  return v_next_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.ensure_open_period(p_product_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id       uuid;
  v_store_id uuid;
  v_opening  qty;
  v_p        record;
  v_tz       text;
  v_prev_end timestamptz;
begin
  select * into v_p from public.stock_periods
   where product_id = p_product_id and status = 'open';

  if found then
    select coalesce(st.timezone, 'UTC') into v_tz
      from public.stores st where st.id = v_p.store_id;

    /*
     * HAS THE DAY TURNED SINCE THIS PERIOD WAS COUNTED? (0214)
     *
     * Only a counted period can roll — an uncounted one has nothing to open the next with — and
     * only a settled one, so an unexplained difference is not quietly filed under yesterday.
     */
    if v_p.counted_at is not null
       and (v_p.counted_at at time zone v_tz)::date < (now() at time zone v_tz)::date
       and (v_p.variance_qty is not distinct from 0
            or public.variance_within_tolerance(v_p.id))
    then
      perform public.book_small_difference(v_p.id);
      update public.stock_periods
         set status     = 'closed',
             period_end = v_p.counted_at,
             closed_at  = now()
       where id = v_p.id;

      insert into public.stock_periods (store_id, product_id, period_start, opening_qty, status)
      values (v_p.store_id, p_product_id, v_p.counted_at, v_p.actual_closing_qty, 'open')
      returning id into v_id;

      -- Everything that has happened since that count belongs to the day that is starting.
      perform public.refresh_period(v_id);
      return v_id;
    end if;

    return v_p.id;
  end if;

  select store_id into v_store_id from public.products where id = p_product_id;
  if v_store_id is null then
    raise exception 'unknown product' using errcode = '23503';
  end if;

  /*
   * The next period opens where the last one ENDED, not at this moment — otherwise anything
   * recorded in between belongs to no period at all.
   */
  select sp.actual_closing_qty, sp.period_end into v_opening, v_prev_end
    from public.stock_periods sp
   where sp.product_id = p_product_id and sp.status <> 'open'
   order by sp.period_end desc nulls last, sp.created_at desc
   limit 1;

  if v_opening is null then
    /*
     * First ever period: what the ledger held BEFORE it (0252). The sale or delivery that called
     * this is already on the ledger, dated now(), and the period counts it as its own; taking it
     * into the opening as well counted it twice, and every count after it was out by exactly that.
     */
    select coalesce(sum(qty_delta), 0) into v_opening
      from public.stock_movements
     where product_id = p_product_id
       and not (occurred_at >= now()
                and kind in ('receive', 'transfer_in', 'sale', 'damage', 'return_in',
                             'repack_loss', 'adjustment', 'transfer_out'));
  end if;

  insert into public.stock_periods (store_id, product_id, period_start, opening_qty)
  values (v_store_id, p_product_id, coalesce(v_prev_end, now()), coalesce(v_opening, 0))
  returning id into v_id;

  perform public.refresh_period(v_id);
  return v_id;
end;
$function$;

grant execute on function public.correct_sale(uuid, text, jsonb, uuid, jsonb, jsonb, money_amt, text, uuid[], boolean, boolean) to authenticated, service_role;
grant execute on function public.amend_sale(uuid, text, jsonb, uuid, jsonb, jsonb, money_amt, text, boolean) to authenticated, service_role;
grant execute on function public.void_sale(uuid, text, boolean) to authenticated, service_role;

notify pgrst, 'reload schema';
