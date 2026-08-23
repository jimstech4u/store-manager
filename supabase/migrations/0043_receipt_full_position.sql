-- =====================================================================================
-- 0043 — The receipt has to state the whole position, not just the money
--
-- `sale_detail` fed the printed receipt and returned the sale's single `fee_amount`/`fee_label`
-- pair plus the customer's money balance. Two things were missing and both are the ones that get
-- argued about weeks later:
--
--  · NAMED CHARGES. With several charges now possible on one order (0042), printing one of them
--    is worse than printing none.
--
--  · EMPTIES. A receipt that states what is owed in money and says nothing about the fourteen
--    crates is half a receipt. The crates are precisely what nobody has a piece of paper about.
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.sale_detail(p_sale_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'sale', to_jsonb(s) - 'store_id',
    'customer', case when sc.id is null then null else jsonb_build_object(
        'id', sc.id, 'name', sc.display_name, 'business', sc.business_name, 'phone', i.phone,
        'balance', public.customer_balance_total(sc.id)
      ) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sl.id,
        'product_id', sl.product_id,
        'product_name', p.name,
        'base_unit', p.base_unit,
        'entered_qty', sl.entered_qty,
        'pack_name', pk.name,
        'base_qty', sl.base_qty,
        'unit_price', sl.unit_price,
        'line_total', sl.line_total,
        'unit_cost_at_sale', sl.unit_cost_at_sale,
        'containers_out', sl.containers_out
      ) order by sl.created_at)
      from public.sale_lines sl
      join public.products p on p.id = sl.product_id
      left join public.product_packs pk on pk.id = sl.entered_pack_id
      where sl.sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pay.id, 'amount', pa.amount, 'method', pay.method,
        'reference', pay.reference, 'occurred_at', pay.occurred_at
      ) order by pay.occurred_at)
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.sale_id = s.id
    ), '[]'::jsonb),
    -- Every named charge on this sale, kept separate.
    --
    -- The receipt previously printed the single `fee_amount` and its label, which is all the sale
    -- used to carry. A bill with transport AND loading on it showed one of them.
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', ch.label, 'amount', ch.amount)
                       order by ch.sort_order)
      from public.sale_charges ch where ch.sale_id = s.id
    ), '[]'::jsonb),
    -- What this customer still has of the shop's, per pool, AFTER this sale.
    --
    -- A receipt that states the money owed and says nothing about the fourteen crates is half a
    -- receipt: the crates are the part that gets argued about, because nobody has a piece of
    -- paper saying how many there were.
    'empties', case when sc.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
               'category', ec.name,
               'qty', t.qty,
               'held', t.held
             ) order by ec.name)
      from (
        select dl.empties_category_id as cid,
               sum(dl.qty_units) as qty,
               sum(dl.qty_units * dl.deposit_per_unit) as held
          from public.deposit_ledger dl
         where dl.store_customer_id = sc.id and dl.direction = 'collected'
         group by dl.empties_category_id
        having sum(dl.qty_units) <> 0 or sum(dl.qty_units * dl.deposit_per_unit) <> 0
      ) t
      join public.empties_categories ec on ec.id = t.cid
    ), '[]'::jsonb) end,
    'draft', case when d.id is null then null else jsonb_build_object(
        'code', d.code, 'created_by', d.created_by, 'settled_by', d.settled_by,
        'settled_at', d.settled_at
      ) end
  )
  from public.sales s
  left join public.store_customers sc on sc.id = s.store_customer_id
  left join public.identities i on i.id = sc.identity_id
  left join public.draft_orders d on d.settled_sale_id = s.id
  where s.id = p_sale_id
    and public.is_store_member(s.store_id);
$function$
;
