-- ════════════════════════════════════════════════════════════════════════════════════════════
-- What the whole shelf is worth, answered by the shop
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- The stock screen adds up the rows it happens to be HOLDING and labels the result "Loaded so far,
-- worth" — honest about being partial, and useless as a figure. A shop with eight hundred lines
-- would have to scroll the entire catalogue into memory to learn what its stock is worth, and the
-- answer would still be an accumulation of page reads rather than a statement.
--
-- The server can answer it in one query over the whole catalogue. It is also the only party that
-- CAN: the value of what is on the shelf is quantity times what that quantity cost, and cost lives
-- in FIFO layers a browser never sees.
--
-- AT WHAT IT COST, not at what it sells for. That is the figure that belongs on a balance sheet and
-- the one a shopkeeper means by "how much stock am I holding" — and the two differ by the whole
-- margin, so the label says which.

/**
 * The value of everything on the shelf, and how much of it is still a guess.
 *
 * `estimated_value` is the part carried at a figure entered during setup rather than one from a
 * real delivery. Reported beside the total rather than folded into it, because "₦4.2m of stock, of
 * which ₦900k is estimated" is a different statement from "₦4.2m of stock", and a shop deciding
 * what to reorder needs to know which it is looking at.
 */
create or replace function public.stock_worth(p_store_id uuid)
returns table (
  total_value     money_amt,
  estimated_value money_amt,
  items           int,
  items_in_stock  int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select
    coalesce(sum(greatest(onhand.qty, 0) * p.avg_unit_cost), 0)::money_amt,
    coalesce(sum(greatest(onhand.qty, 0) * p.avg_unit_cost)
             filter (where p.cost_is_estimated), 0)::money_amt,
    count(*)::int,
    count(*) filter (where onhand.qty > 0)::int
  from public.products p
  join lateral (
    select coalesce(sum(m.qty_delta), 0) as qty
      from public.stock_movements m
     where m.product_id = p.id
  ) onhand on true
  where p.store_id = p_store_id
    and p.status = 'active'
    and public.is_store_member(p_store_id);
$fn$;

grant execute on function public.stock_worth(uuid) to authenticated;
