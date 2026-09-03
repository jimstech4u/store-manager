-- 0087 — The receipt link and the tracking page say the whole thing
--
-- «also reciept link and sale tracking should also have the new full correction for payment,
--  deposits and empties and shape and all»
--
-- Both pages are what a customer sees, and both had fallen behind what the shop records. The
-- tracking page knew about charges and empties but named every quantity through `product_packs` —
-- the model 0061 replaced — so a shop that defined its own shapes had its orders described in base
-- units. The receipt link was worse: still 0019, with no charges, no deposits, no empties, and the
-- same wrong word for the shape.
--
-- One older fault is corrected while both are open: `deposit_ledger.direction` is
-- ('collected','paid'), and 0064 tested it against 'out'. That comparison has never been true, so
-- every empties figure on the tracking page has been NEGATIVE since it shipped — a customer holding
-- ten crates was shown "-10 NBL crate", with a deposit of "-N1,250" beside it.
--
-- Neither page learns anything new about the shop. Costs, margins, running balances and bank
-- references stay out of both, because anyone holding the link can open them.

-- ─── The tracking page ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.public_track_token(p_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with found as (
    select d.*, st.name as shop_name
      from public.draft_orders d
      join public.stores st on st.id = d.store_id
     where d.share_token = trim(p_token)
  )
  select case
    when f.status = 'cancelled' then
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', 'cancelled',
        'shop', f.shop_name, 'updated_at', f.updated_at
      )

    when f.status = 'settled' then
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', 'settled',
        'shop', f.shop_name, 'updated_at', f.updated_at,
        'sale_id', f.settled_sale_id,

        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', p.name, 'qty', sl.entered_qty,
                   /*
                    * THE SHAPE IT WAS SOLD IN, said the way the seller said it.
                    *
                    * `product_packs` first, then the base unit — a customer who bought three
                    * crates was told they had bought three pieces the moment their shop defined
                    * its shapes on this software rather than inheriting packs from before 0061.
                    * Pluralised, because "3 Crate" is the sort of thing that makes a receipt look
                    * machine-made and a shop look careless.
                    */
                   'unit', coalesce(
                     case when sl.entered_qty = 1 then su.name else su.plural end,
                     pk.name, p.base_unit),
                   'unit_price', sl.unit_price, 'line_total', sl.line_total,
                   -- What has to come back, and what was taken against it.
                   'containers_out', sl.containers_out,
                   'deposit', sl.deposit_charged
                 ) order by sl.created_at)
            from public.sale_lines sl
            join public.products p on p.id = sl.product_id
            left join public.product_packs pk on pk.id = sl.entered_pack_id
            left join public.product_units pu on pu.id = sl.sale_unit_id
            left join public.store_units su on su.id = pu.store_unit_id
           where sl.sale_id = f.settled_sale_id
        ), '[]'::jsonb),

        -- What else was billed, by name. A delivery fee the customer cannot see is a delivery fee
        -- they will ring about.
        'charges', coalesce((
          select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                           order by c.sort_order)
            from public.sale_charges c where c.sale_id = f.settled_sale_id
        ), '[]'::jsonb),

        /*
         * How it was paid, by method.
         *
         * Grouped rather than listed one by one: "Cash ₦20,000, Transfer ₦9,950" is what somebody
         * checks against their own record. Bank references are deliberately NOT here — this page
         * is public to anyone holding the link.
         */
        'payments', coalesce((
          select jsonb_agg(x)
            from (
              select jsonb_build_object('method', pay.method, 'amount', sum(pa.amount)) as x
                from public.payment_allocations pa
                join public.payments pay on pay.id = pa.payment_id
               where pa.sale_id = f.settled_sale_id
               group by pay.method
               order by pay.method
            ) grouped
        ), '[]'::jsonb),

        /*
         * Empties, by CATEGORY.
         *
         * Two Gulder and two Star crates are four NBL crates — that is how the shop counts them,
         * how the depot pays for them, and therefore what the customer is holding. Listing them
         * per product would be a receipt nobody can reconcile against a stack in a yard.
         */
        /*
         * MONEY TAKEN AGAINST CONTAINERS, which appeared on no public page at all.
         *
         * A shop charging N125 a crate on ten crates has taken N1,250 that is not payment for
         * anything — it comes back when the crates do. It was in the total the customer was asked
         * for and named nowhere, so the receipt read as if the drinks cost N1,250 more than they
         * did, and the customer had no written record that the shop owes it back. That is the
         * whole point of a deposit.
         */
        'deposit_total', coalesce((
          select sum(sl.deposit_charged) from public.sale_lines sl
           where sl.sale_id = f.settled_sale_id
        ), 0),

        'empties', coalesce((
          select jsonb_agg(y)
            from (
              select jsonb_build_object(
                       'category', ec.name,
                       'qty', sum(case when dl.direction = 'collected' then dl.qty_units
                                       else -dl.qty_units end),
                       'deposit', sum(case when dl.direction = 'collected'
                                           then dl.qty_units * dl.deposit_per_unit
                                           else -(dl.qty_units * dl.deposit_per_unit) end)
                     ) as y
                from public.deposit_ledger dl
                join public.empties_categories ec on ec.id = dl.empties_category_id
               where dl.ref_table = 'sales' and dl.ref_id = f.settled_sale_id
               group by ec.name
              having sum(case when dl.direction = 'collected' then dl.qty_units
                              else -dl.qty_units end) <> 0
               order by ec.name
            ) grouped
        ), '[]'::jsonb),

        'total', coalesce((select s.total from public.sales s where s.id = f.settled_sale_id), 0),
        'paid', coalesce((
          select sum(pa.amount) from public.payment_allocations pa
           where pa.sale_id = f.settled_sale_id
        ), 0)
      )

    else
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', f.status,
        'shop', f.shop_name, 'updated_at', f.updated_at,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', p.name, 'qty', l.entered_qty,
                   -- Same shape, same words. An order watched while it is being built and the
                   -- receipt for it afterwards must not describe the same thing two ways.
                   'unit', coalesce(
                     case when l.entered_qty = 1 then su.name else su.plural end,
                     pk.name, p.base_unit),
                   'unit_price', l.unit_price, 'line_total', l.line_total,
                   'containers_out', l.containers_out
                 ) order by l.position)
            from public.draft_order_lines l
            join public.products p on p.id = l.product_id
            left join public.product_packs pk on pk.id = l.entered_pack_id
            left join public.product_units pu on pu.id = l.sale_unit_id
            left join public.store_units su on su.id = pu.store_unit_id
           where l.draft_order_id = f.id
        ), '[]'::jsonb),
        'charges', coalesce((
          select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                           order by c.sort_order)
            from public.draft_order_charges c where c.draft_order_id = f.id
        ), '[]'::jsonb),
        'total', (
          coalesce((select sum(l.line_total) from public.draft_order_lines l
                     where l.draft_order_id = f.id), 0)
          + coalesce(f.fee_amount, 0)
          + coalesce((select sum(c.amount) from public.draft_order_charges c
                       where c.draft_order_id = f.id), 0)
        )
      )
  end
  from found f;
$function$;

-- ─── The receipt link ───────────────────────────────────────────────────────────────
--
-- REPLACED, not patched. This is still 0019's definition: it knows about lines, a single fee and
-- a list of payments, and nothing else that has been built since. A customer opening the link they
-- were sent could not see the charges they were billed for, the deposit they paid, the containers
-- they are holding, or — once their shop defined its own shapes — even the right word for what
-- they bought.
--
-- What it deliberately still withholds is unchanged: no costs, no margin, no running balance, no
-- bank reference. A receipt handed to a customer is not a window into the shop's buying prices, and
-- anyone holding the link can open it.

create or replace function public.read_shared_receipt(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_link record;
  v_out  jsonb;
begin
  select * into v_link
    from public.share_links
   where token = p_token
     and kind = 'receipt'
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  -- Unknown, revoked and expired all answer the same, so the page cannot be used to find out
  -- whether a token ever existed.
  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'shop', jsonb_build_object(
      'name', st.name,
      'header', ss.receipt_header,
      'footer', ss.receipt_footer,
      'printer_width_mm', coalesce(ss.printer_width_mm, 80)
    ),
    'sale', jsonb_build_object(
      'id', s.id,
      'occurred_at', s.occurred_at,
      'total', s.total,
      'fee_amount', s.fee_amount,
      'fee_label', s.fee_label,
      'note', s.note,
      'transfer_details', s.transfer_details
    ),
    'customer', case when sc.id is null then null
                     else jsonb_build_object('name', sc.display_name) end,

    /*
     * The items, in the shape they were sold in.
     *
     * `sale_unit_id` first (0085), then the retired pack, then the base unit. Pluralised from the
     * shop's own words for the shape, so a receipt reads "3 crates" and not "3 Crate".
     */
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sl.id,
        'product_name', p.name,
        'base_unit', p.base_unit,
        'entered_qty', sl.entered_qty,
        'unit_name', coalesce(
          case when sl.entered_qty = 1 then su.name else su.plural end,
          pk.name),
        'unit_price', sl.unit_price,
        'line_total', sl.line_total,
        'containers_out', sl.containers_out,
        'deposit', sl.deposit_charged
      ) order by sl.created_at)
      from public.sale_lines sl
      join public.products p on p.id = sl.product_id
      left join public.product_packs pk on pk.id = sl.entered_pack_id
      left join public.product_units pu on pu.id = sl.sale_unit_id
      left join public.store_units su on su.id = pu.store_unit_id
      where sl.sale_id = s.id
    ), '[]'::jsonb),

    -- What else was billed, BY NAME. A delivery fee a customer cannot see is a delivery fee they
    -- will ring about, and "extra charge" answers nothing weeks later.
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                       order by c.sort_order)
        from public.sale_charges c where c.sale_id = s.id
    ), '[]'::jsonb),

    /*
     * Money held against containers.
     *
     * Not payment for anything: it comes back when the crates do. It was inside the total and named
     * nowhere, so the receipt read as though the drinks cost that much more, and the customer had
     * nothing in writing saying the shop owes it.
     */
    'deposit_total', coalesce((
      select sum(sl.deposit_charged) from public.sale_lines sl where sl.sale_id = s.id
    ), 0),

    /*
     * What has to come back, GROUPED THE WAY IT IS COUNTED.
     *
     * By category, not by brand: two Gulder and two Star are four NBL crates, because that is what
     * goes on the pallet and what the depot pays for. Netted, so a customer who has already
     * returned some sees what is left rather than the original number.
     */
    'empties', coalesce((
      select jsonb_agg(y)
        from (
          select jsonb_build_object(
                   'category', ec.name,
                   'qty', sum(case when dl.direction = 'collected' then dl.qty_units
                                   else -dl.qty_units end),
                   'deposit', sum(case when dl.direction = 'collected'
                                       then dl.qty_units * dl.deposit_per_unit
                                       else -(dl.qty_units * dl.deposit_per_unit) end)
                 ) as y
            from public.deposit_ledger dl
            join public.empties_categories ec on ec.id = dl.empties_category_id
           where dl.ref_table = 'sales' and dl.ref_id = s.id
           group by ec.name
          having sum(case when dl.direction = 'collected' then dl.qty_units
                          else -dl.qty_units end) <> 0
           order by ec.name
        ) grouped
    ), '[]'::jsonb),

    /*
     * How it was paid, GROUPED BY METHOD.
     *
     * "Cash N20,000, Transfer N9,950" is what somebody checks against their own record. Bank
     * references are deliberately left out — this page is public to anyone holding the link.
     */
    'payments', coalesce((
      select jsonb_agg(x)
        from (
          select jsonb_build_object('method', pay.method, 'amount', sum(pa.amount)) as x
            from public.payment_allocations pa
            join public.payments pay on pay.id = pa.payment_id
           where pa.sale_id = s.id
           group by pay.method
           order by pay.method
        ) grouped
    ), '[]'::jsonb),

    -- Computed here rather than on the page, so the receipt and the shop's own books cannot
    -- disagree about what is still owed.
    'paid_total', coalesce((
      select sum(pa.amount) from public.payment_allocations pa where pa.sale_id = s.id
    ), 0)
  )
  into v_out
  from public.sales s
  join public.stores st on st.id = s.store_id
  left join public.store_settings ss on ss.store_id = s.store_id
  left join public.store_customers sc on sc.id = s.store_customer_id
  where s.id = v_link.ref_id;

  -- Recorded so a shop can see a receipt was opened. Deliberately not an audit of WHO opened it:
  -- the viewer is not authenticated and pretending otherwise would be a false record.
  update public.share_links
     set view_count = view_count + 1, last_seen_at = now()
   where id = v_link.id;

  return v_out;
end;
$fn$;

revoke all on function public.read_shared_receipt(text) from public;
grant execute on function public.read_shared_receipt(text) to anon, authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('public_track_token', 'read_shared_receipt')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a public reader has % overloads', n;
    end if;
  end loop;
end;
$check$;
