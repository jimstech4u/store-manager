-- 0235 - A product search finds every word typed, in any order
--
-- Items sold together are now one item with a long name — "Bigi Cola | Apple | Tropical | Orange |
-- Lemon PET (350mL)". A seller asked for Bigi Apple types "bigi apple", and the search matched the
-- phrase only: the two words are not next to each other in the name, and the fuzzy match is too
-- weak on a long name, so nothing came back.
--
-- A product now also matches when EVERY word typed appears in its name or its group, in any order.
-- It ranks after a direct match on the name, ahead of group-only and fuzzy matches. Nothing that
-- matched before stops matching. Same signature, so every caller is unchanged.

create or replace function public.search_products(
  p_store_id uuid,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(id uuid, name text, sku text, base_unit text, category_id uuid, category_name text,
              avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid,
              pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term),
  words as (
    select coalesce(array_agg(w), '{}') as list
      from q, regexp_split_to_table(coalesce(q.term, ''), '\s+') w
     where w <> ''
  )
  select p.id,
         p.name,
         p.sku,
         p.base_unit,
         p.category_id,
         c.name,
         p.avg_unit_cost,
         p.cost_is_estimated,
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0)::qty,
         pk.id,
         pk.name,
         pk.base_unit_qty,
         pr.price,
         -- So a card marks itself the same whether it was browsed to or searched for.
         coalesce(p.low_stock_threshold, ss.low_stock_threshold)
  from public.products p
  cross join q
  cross join words
  left join public.product_categories c on c.id = p.category_id
  left join public.store_settings ss on ss.store_id = p.store_id
  left join public.product_packs pk
         on pk.id = coalesce(p.default_display_pack_id,
                             (select id from public.product_packs
                               where product_id = p.id order by base_unit_qty limit 1))
  left join public.product_prices pr
         on pr.product_id = p.id
        and (pr.pack_id = pk.id or (pr.pack_id is null and pk.id is null))
  where p.store_id = p_store_id
    and p.status = 'active'
    and public.is_store_member(p_store_id)
    and (
      q.term is null
      or p.name ilike '%' || q.term || '%'
      or p.sku  ilike '%' || q.term || '%'
      or c.name ilike '%' || q.term || '%'
      or similarity(p.name, q.term) > 0.25
      -- Every word, anywhere in the name or the group, in any order.
      or (cardinality(words.list) > 1
          and not exists (select 1 from unnest(words.list) w
                           where p.name not ilike '%' || w || '%'
                             and coalesce(c.name, '') not ilike '%' || w || '%'))
    )
  order by
    -- Exact-ish name matches first, then every-word matches, then category matches, then fuzzy.
    case
      when q.term is null then 1
      when p.name ilike q.term || '%' then 0
      when p.name ilike '%' || q.term || '%' then 1
      when cardinality(words.list) > 1
           and not exists (select 1 from unnest(words.list) w where p.name not ilike '%' || w || '%') then 1
      when c.name ilike '%' || q.term || '%' then 2
      else 3
    end,
    p.name
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  -- 0223: the picker pages. The order above is total (rank, then name), so an offset is stable.
  offset greatest(0, coalesce(p_offset, 0));
$function$;

notify pgrst, 'reload schema';
