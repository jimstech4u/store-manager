-- ════════════════════════════════════════════════════════════════════════════════════════════
-- A shared receipt shows the whole bill
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- The link a customer is sent showed the items and a total. It left out the charges they were
-- billed for, the empties they are holding, and how the money was actually paid — which is most of
-- what a receipt is FOR. A customer checking a delivery fee, or arguing about four crates they
-- brought back, was looking at a page that did not mention either.
--
-- EMPTIES ARE GROUPED THE WAY THEY ARE COUNTED. A shop takes back crates by category, not by
-- brand: two Gulder and two Star are four NBL crates, because that is what goes on the pallet and
-- what the depot pays for. `empties_categories` has said so all along and the receipt now says it
-- too — "4 NBL crates" rather than two lines nobody reconciles.

create or replace function public.public_track_token(p_token text)
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
                   'unit', coalesce(pk.name, p.base_unit),
                   'unit_price', sl.unit_price, 'line_total', sl.line_total
                 ) order by sl.created_at)
            from public.sale_lines sl
            join public.products p on p.id = sl.product_id
            left join public.product_packs pk on pk.id = sl.entered_pack_id
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
        'empties', coalesce((
          select jsonb_agg(y)
            from (
              select jsonb_build_object(
                       'category', ec.name,
                       'qty', sum(case when dl.direction = 'out' then dl.qty_units
                                       else -dl.qty_units end),
                       'deposit', sum(case when dl.direction = 'out'
                                           then dl.qty_units * dl.deposit_per_unit
                                           else -(dl.qty_units * dl.deposit_per_unit) end)
                     ) as y
                from public.deposit_ledger dl
                join public.empties_categories ec on ec.id = dl.empties_category_id
               where dl.ref_table = 'sales' and dl.ref_id = f.settled_sale_id
               group by ec.name
              having sum(case when dl.direction = 'out' then dl.qty_units
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
                   'unit', coalesce(pk.name, p.base_unit),
                   'unit_price', l.unit_price, 'line_total', l.line_total
                 ) order by l.position)
            from public.draft_order_lines l
            join public.products p on p.id = l.product_id
            left join public.product_packs pk on pk.id = l.entered_pack_id
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
$fn$;

revoke all on function public.public_track_token(text) from public;
grant execute on function public.public_track_token(text) to anon, authenticated;
