-- One public product, by id.
--
-- A product needs a page of its own to be findable: a URL a person can send, a title, a price and a
-- picture a search result can show. Rendering that page needs ONE product, and the only public read
-- available was `public_products`, which lists a shop's catalogue — so a page for one item meant
-- fetching two hundred and throwing away all but one. That is fine for a shop with twenty products
-- and wrong for a shop with two thousand.
--
-- The visibility rules are copied from `public_products` deliberately, not relaxed: a public shop,
-- onboarded, an active and confirmed product. A crawler and a passer-by must see exactly the same
-- thing, and the safest way to guarantee that is for both to be answered by the same conditions.

create or replace function public.public_product(p_id uuid)
returns table (
  id           uuid,
  name         text,
  category     text,
  store_id     uuid,
  store_name   text,
  store_code   text,
  unit_label   text,
  price        money_amt,
  has_bulk     boolean,
  in_stock     boolean,
  image_path   text,
  media_count  bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, c.name, s.id, s.name, s.code,
         coalesce(su.name, pk.name, p.base_unit),
         coalesce(su.price, pr.price),
         exists (select 1 from public.product_price_tiers t where t.product_id = p.id),
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0) > 0,
         (select pm.path from public.product_media pm
           where pm.product_id = p.id and pm.kind = 'image'
           order by pm.sort_order limit 1),
         (select count(*) from public.product_media pm where pm.product_id = p.id)
  from public.products p
  join public.stores s on s.id = p.store_id
  left join public.product_categories c on c.id = p.category_id
  left join public.product_packs pk on pk.id = p.default_display_pack_id
  left join lateral (
    select su2.name, su2.price from public.product_sale_units su2
    where su2.product_id = p.id order by su2.sort_order, su2.base_qty desc limit 1
  ) su on true
  left join lateral (
    select pp.price from public.product_prices pp
    where pp.product_id = p.id order by (pp.pack_id is null) limit 1
  ) pr on true
  where p.id = p_id
    and s.is_public
    and s.onboarded_at is not null
    and p.status = 'active'
    and p.confirmed_at is not null
$$;

comment on function public.public_product(uuid) is
  'One public product for its own page. Same visibility as public_products: a crawler sees exactly what a passer-by sees.';

grant execute on function public.public_product(uuid) to anon, authenticated;
