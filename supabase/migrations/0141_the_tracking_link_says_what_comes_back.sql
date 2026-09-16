-- 0141 — The live tracking link says what comes back
--
-- «likewise the live tracking sales, because it adds up with the outstanding on the customer —
--  any returnable product in a receipt needs a customer»
--
-- The tracking link a customer watches was on the retired pool model too: a paid order read
-- `deposit_ledger` pools (empty for every sale since containers moved onto shapes), and an order
-- still being built said nothing about containers at all. Both branches now hand over one row per
-- product shape with its maker, for the page to roll up with the counter's rule.
--
-- Spliced from 0087; only the two `empties` keys change.

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

        /*
         * STILL WITH YOU — what this sale sent out, per product shape, with its maker.
         *
         * Read from the container rows the sale wrote (`ref_table = 'sale_lines'`), net of anything
         * written back against the same lines by a correction. The counter's rule — whole ones add
         * across a maker, parts stay with their product — is applied on the page by `rollUpOwed`.
         * This used to read `deposit_ledger` pools, which no sale has written since containers moved
         * onto product shapes, so a paid order's link showed no containers at all.
         */
        'empties', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'product_id', t.product_id,
                   'product_name', t.product_name,
                   'product_unit_id', t.product_unit_id,
                   'unit_name', t.unit_name,
                   'unit_plural', t.unit_plural,
                   'base_qty', t.base_qty,
                   'group_id', t.group_id,
                   'group_name', t.group_name,
                   'owed', t.owed
                 ) order by t.group_name nulls last, t.product_name)
            from (
              select ce.product_id, pr.name as product_name, ce.product_unit_id,
                     su.name as unit_name, su.plural as unit_plural, pu.base_qty,
                     g.group_id, g.group_name,
                     sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as owed
                /*
                 * THIS SALE'S CONTAINER ROWS, from either place they can be.
                 *
                 * Written by the sale itself (`sale_lines`, since 0117), or carried over from the old deposit
                 * ledger (0110), where the deposit row points at the sale. 62 older receipts have theirs only
                 * in the second place and printed nothing although the ledger was right.
                 */
                from (
                  select c.* from public.customer_empties c
                    join public.sale_lines sl on c.ref_table = 'sale_lines' and sl.id = c.ref_id
                   where sl.sale_id = f.settled_sale_id
                  union all
                  select c.* from public.customer_empties c
                    join public.deposit_ledger dl on c.ref_table = 'deposit_ledger' and dl.id = c.ref_id
                   where dl.ref_table = 'sales' and dl.ref_id = f.settled_sale_id
                ) ce
                join public.products pr on pr.id = ce.product_id
                join public.product_units pu on pu.id = ce.product_unit_id
                join public.store_units su on su.id = pu.store_unit_id
                left join lateral (
                  select c.id as group_id, c.name as group_name
                    from public.product_category_links gl
                    join public.product_categories c on c.id = gl.category_id
                   where gl.product_id = pr.id and coalesce(c.status, 'active') = 'active'
                   order by c.name
                   limit 1
                ) g on true
               where true
                 and coalesce(ce.side, 'they_hold') = 'they_hold'
             /*
              * AND NOT TAKEN BACK BY A VOID. `unowe_voided_sale` (0117) writes its reversal under
              * `ref_table = 'sale_void'` pointing at the OUT row, not at the line — so without this a
              * cancelled receipt would still list the crates as with the customer.
              */
             and not exists (
               select 1 from public.customer_empties v
                where v.ref_table = 'sale_void' and v.ref_id = ce.id
             )
               group by ce.product_id, pr.name, ce.product_unit_id, su.name, su.plural,
                        pu.base_qty, g.group_id, g.group_name
              having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
            ) t
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
        /*
         * WHAT WILL COME BACK, while the order is still being built.
         *
         * The lines sold in a shape that comes back, in that shape — so a customer watching their
         * order sees the crates they are about to take home alongside the money, before they leave.
         */
        'empties', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'product_id', t.product_id,
                   'product_name', t.product_name,
                   'product_unit_id', t.product_unit_id,
                   'unit_name', t.unit_name,
                   'unit_plural', t.unit_plural,
                   'base_qty', t.base_qty,
                   'group_id', t.group_id,
                   'group_name', t.group_name,
                   'owed', t.owed
                 ) order by t.group_name nulls last, t.product_name)
            from (
              select l.product_id, pr.name as product_name, pu.id as product_unit_id,
                     su.name as unit_name, su.plural as unit_plural, pu.base_qty,
                     g.group_id, g.group_name,
                     sum(l.entered_qty) as owed
                from public.draft_order_lines l
                join public.products pr on pr.id = l.product_id
                join public.product_units pu on pu.id = l.sale_unit_id and pu.is_returnable
                join public.store_units su on su.id = pu.store_unit_id
                left join lateral (
                  select c.id as group_id, c.name as group_name
                    from public.product_category_links gl
                    join public.product_categories c on c.id = gl.category_id
                   where gl.product_id = pr.id and coalesce(c.status, 'active') = 'active'
                   order by c.name
                   limit 1
                ) g on true
               where l.draft_order_id = f.id
               group by l.product_id, pr.name, pu.id, su.name, su.plural, pu.base_qty,
                        g.group_id, g.group_name
              having sum(l.entered_qty) > 0
            ) t
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
