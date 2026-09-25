-- =====================================================================================
-- 0164 — The bulk ladder a marketplace shopper is actually on
--
-- `public_price_tiers` returned every band for a product, whatever shape it was for. A product sold
-- both by the crate and by the bottle has bands for each, and the marketplace shows ONE price — the
-- default shape from `public_product`. So a shopper looking at the crate price could be shown the
-- bottle's ladder underneath it: "5 or more: ₦180 each", against a crate at ₦3,700.
--
-- The bands returned are now the bands for the shape whose price is on the page, chosen by the same
-- expression `public_product` uses to choose that price. A ladder that belongs to a different unit
-- is not a discount, it is a different product.
-- =====================================================================================

create or replace function public.public_price_tiers(p_product_id uuid)
returns table (min_qty qty, max_qty qty, price money_amt)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with shown as (
    -- The shape the marketplace prices this product in: the same lateral pick as `public_product`.
    select su.id as sale_unit_id
    from public.products p
    join public.stores s on s.id = p.store_id
    left join lateral (
      select su2.id from public.product_sale_units su2
      where su2.product_id = p.id order by su2.sort_order, su2.base_qty desc limit 1
    ) su on true
    where p.id = p_product_id
      and s.is_public
      and s.onboarded_at is not null
      and p.status = 'active'
  )
  select t.min_qty, t.max_qty, t.price
  from public.product_price_tiers t, shown
  where t.product_id = p_product_id
    -- `is not distinct from`, because both are legitimately null for a product sold in its base
    -- unit and `=` is null there — which would return no ladder at all for exactly those products.
    and t.sale_unit_id is not distinct from shown.sale_unit_id
  order by t.min_qty;
$$;

comment on function public.public_price_tiers(uuid) is
  'The bulk bands for the shape the marketplace shows this product in — not every band the product has. Public.';
