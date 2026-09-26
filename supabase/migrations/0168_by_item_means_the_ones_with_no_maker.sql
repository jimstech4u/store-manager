-- =====================================================================================
-- 0168 — "Item by item" means the items that have no maker
--
-- A shop's returnables are counted one of two ways, and the two must not overlap:
--
--   BY MAKER — one stack of NBL crates, counted as NBL, whatever beer was in them last. That is
--   what a distributor's yard physically is.
--
--   ITEM BY ITEM — for the things that belong to nobody's pool: a dispenser bottle, a crate from a
--   supplier with no group of its own.
--
-- `products_with_returnables` returned EVERY returnable product, grouped or not, so Goldberg showed
-- up twice: once inside NBL under "by maker" and again on its own under "item by item", as though
-- the same physical crate could be counted both ways. Enter it in both and the shop has doubled its
-- obligation to a customer without typing anything twice.
--
-- The yard screen already worked this out and filtered the grouped ones out on the client
-- (`shapes.filter(r => !r.groupId)`), which fixed the screen somebody noticed and left every other
-- caller — the customer form, and now the supplier form — with the overlap. Doing it here fixes it
-- once, for all of them, and makes the two lists genuinely complementary: every returnable product
-- appears in exactly one of them.
-- =====================================================================================

create or replace function public.products_with_returnables(p_store_id uuid)
returns table (product_id uuid, product_name text, group_name text, shapes integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name,
         null::text,
         count(*)::int
    from public.products p
    join public.product_units pu on pu.product_id = p.id and pu.is_returnable
   where p.store_id = p_store_id
     and coalesce(p.status, 'active') = 'active'
     and public.is_store_member(p_store_id)
     /*
      * NO MAKER. A product in an active category is counted through that category, under "by
      * maker", and must not also stand alone here.
      *
      * `group_name` above is now always null for the same reason — it named the very category that
      * disqualifies a row from this list, so any row that could have filled it is no longer here.
      * Kept in the shape so existing callers still compile; it is dead and says so.
      */
     and not exists (
       select 1
         from public.product_category_links l
         join public.product_categories c on c.id = l.category_id
        where l.product_id = p.id
          and coalesce(c.status, 'active') = 'active'
     )
   group by p.id, p.name
   order by p.name;
$$;

comment on function public.products_with_returnables(uuid) is
  'Returnable products that belong to NO maker — the "item by item" half of the pair with groups_with_returnables. The two do not overlap: every returnable product is in exactly one of them.';
