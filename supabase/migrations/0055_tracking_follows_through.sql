-- ════════════════════════════════════════════════════════════════════════════════════════════
-- One code, all the way through
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- A customer is given a tracking code while their order is being built. Then it is paid for, and
-- the code stops working — so the shop has to send them a SECOND link for the receipt. Two links
-- for one purchase, and the first one dies in their hand without saying why.
--
-- The code should follow the order to wherever it ends up. The rules are unchanged about who may
-- see what; only the answer for a code whose order has moved on:
--
--   open       the order as it is being built, exactly as before
--   settled    the receipt for the sale it became
--   cancelled  a plain sentence saying so, rather than "not found"
--
-- "Not found" is still the answer for a code that never existed, and for a code released back to
-- the pool and taken by somebody else's order — which the `settled_sale_id` link handles, because
-- it is the ORDER that is followed, not the string.
--
-- Nothing here exposes more than the receipt page already does: a settled order's lines and total
-- are the same lines and total the buyer was standing there for.

create or replace function public.public_track_order(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with found as (
    select d.*, st.name as shop_name
      from public.draft_orders d
      join public.stores st on st.id = d.store_id
     where upper(d.code) = upper(trim(p_code))
       /*
        * The most recent order to hold this code.
        *
        * A code is released when its order is settled or cancelled, so the same string can belong
        * to a later order. The newest is the one the person asking was just given; an older,
        * finished order with the same code is somebody else's business.
        */
     order by d.created_at desc
     limit 1
  )
  select case
    when f.status = 'cancelled' then
      jsonb_build_object(
        'code', f.code,
        'status', 'cancelled',
        'shop', f.shop_name,
        'updated_at', f.updated_at
      )

    when f.status = 'settled' then
      jsonb_build_object(
        'code', f.code,
        'status', 'settled',
        'shop', f.shop_name,
        'updated_at', f.updated_at,
        'sale_id', f.settled_sale_id,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', p.name,
                   'qty', sl.entered_qty,
                   'unit', coalesce(pk.name, p.base_unit),
                   'unit_price', sl.unit_price,
                   'line_total', sl.line_total
                 ) order by sl.created_at)
            from public.sale_lines sl
            join public.products p on p.id = sl.product_id
            left join public.product_packs pk on pk.id = sl.entered_pack_id
           where sl.sale_id = f.settled_sale_id
        ), '[]'::jsonb),
        'total', coalesce((select s.total from public.sales s where s.id = f.settled_sale_id), 0),
        /*
         * What has been paid TOWARDS this sale, from the allocation table.
         *
         * A payment can be split across several sales, so the amount that matters here is what was
         * allocated to this one — not the size of the payment that happened to settle it.
         */
        'paid', coalesce((
          select sum(pa.amount) from public.payment_allocations pa
           where pa.sale_id = f.settled_sale_id
        ), 0)
      )

    else
      jsonb_build_object(
        'code', f.code,
        'status', f.status,
        'shop', f.shop_name,
        'updated_at', f.updated_at,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', p.name,
                   'qty', l.entered_qty,
                   'unit', coalesce(pk.name, p.base_unit),
                   'unit_price', l.unit_price,
                   'line_total', l.line_total
                 ) order by l.position)
            from public.draft_order_lines l
            join public.products p on p.id = l.product_id
            left join public.product_packs pk on pk.id = l.entered_pack_id
           where l.draft_order_id = f.id
        ), '[]'::jsonb),
        'charges', coalesce((
          select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount)
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
$fn$;

revoke all on function public.public_track_order(text) from public;
grant execute on function public.public_track_order(text) to anon, authenticated;
