-- =====================================================================================
-- 0176 — The exceptions to the low-stock rule, as a list a shop can manage
--
-- 0171 gave a shop one level and let any item carry its own. There was no way to SEE the ones that
-- do: the general level sat in Settings, the exceptions were only visible by opening each item's
-- form one at a time, and a shop that had set five of them over three months had no way to find out
-- which five. A setting nobody can list is a setting nobody can trust.
--
-- `low_stock_items` answers a different question — "what is low right now" — and deliberately only
-- returns items at or below their level. An item given its own level of 5 with 40 on the shelf is
-- exactly the item a shop wants to check it set correctly, and that function will never mention it.
--
-- So: the items that have been given their OWN level, whether or not they are low, with what they
-- are judged by beside what the shop's general rule would have said. That last part is the point —
-- "this one warns at 5, everything else at 20" is the sentence a shop needs to read.
-- =====================================================================================

create or replace function public.products_with_own_low_stock(p_store_id uuid)
returns table (
  product_id  uuid,
  name        text,
  base_unit   text,
  on_hand     qty,
  own_level   numeric,
  shop_level  numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, p.base_unit,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0)::qty,
         p.low_stock_threshold,
         ss.low_stock_threshold
    from public.products p
    left join public.store_settings ss on ss.store_id = p.store_id
   where p.store_id = p_store_id
     and coalesce(p.status, 'active') = 'active'
     -- Its OWN level, set deliberately. Null here is not an exception, it is the ordinary case.
     and p.low_stock_threshold is not null
     and public.is_store_member(p_store_id)
   order by p.name;
$$;

grant execute on function public.products_with_own_low_stock(uuid) to authenticated;

comment on function public.products_with_own_low_stock(uuid) is
  'Items given their own low-stock level, whether or not they are currently low, with the shop''s general level beside it for comparison.';


/*
 * ─── AND THE SHOP'S OWN LEVEL, READABLE WITHOUT THE WHOLE SETTINGS ROW ────────────
 *
 * The level moved out of the Settings screen onto a page of its own, and that page has no business
 * fetching a shop's bank details and receipt footer to find one number. `store_settings` is readable
 * by a member, but the row is wide and the page that reads it then has to be careful not to write
 * the rest of it back.
 */
create or replace function public.low_stock_rule(p_store_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ss.low_stock_threshold
    from public.store_settings ss
   where ss.store_id = p_store_id
     and public.is_store_member(p_store_id);
$$;

grant execute on function public.low_stock_rule(uuid) to authenticated;
