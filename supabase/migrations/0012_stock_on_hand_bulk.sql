-- =====================================================================================
-- 0012 — On-hand quantities for a whole store in one call
--
-- The single-product stock_on_hand() is correct but wrong-shaped for a list: showing 40
-- products meant 40 round trips. On the connections this product is built for — a phone on
-- mobile data in a shop — that is the difference between a list that appears and one that
-- times out halfway through, leaving some rows showing stock and others showing zero, which
-- reads as a data error rather than a network one.
--
-- Summing the movement ledger stays the only definition of on-hand: there is no stored counter
-- to drift out of step with the transactions behind it.
-- =====================================================================================

create or replace function public.stock_on_hand_bulk(p_store_id uuid)
returns table (product_id uuid, on_hand qty)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id,
         coalesce(sum(m.qty_delta), 0)::qty
  from public.products p
  left join public.stock_movements m on m.product_id = p.id
  where p.store_id = p_store_id
    and public.is_store_member(p_store_id)
  group by p.id;
$$;

grant execute on function public.stock_on_hand_bulk(uuid) to authenticated;
