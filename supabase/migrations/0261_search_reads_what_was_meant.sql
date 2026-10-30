-- 0261 - Search reads what was meant
--
-- "Users can type incorrect spelling and we should look at their intention, even in the app." Search
-- already had a fuzzy line, but it scored the whole name: "tropy" against "Trophy Bottle (600mL)" is
-- diluted by everything after the first word and found nothing, while a loose score on short names
-- brought strangers along. Customers had worse: a name has no digits, so its "phone" was empty and
-- LIKE '%%' matched everybody in the shop on every name search; only the sort order hid it. Now, in
-- both readers every screen and the
-- WhatsApp assistant use: what was typed is tried as typed first; only when nothing matches are the
-- words compared one at a time against the words of the name (and its group, or business), closest
-- first. Both functions are the live definitions with only those lines changed.

CREATE OR REPLACE FUNCTION public.search_products(p_store_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, name text, sku text, base_unit text, category_id uuid, category_name text, avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid, pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      -- Every word, anywhere in the name or the group, in any order.
      or (cardinality(words.list) > 1
          and not exists (select 1 from unnest(words.list) w
                           where p.name not ilike '%' || w || '%'
                             and coalesce(c.name, '') not ilike '%' || w || '%'))
      /*
       * WHAT THEY MEANT (0261), only when nothing matched as typed. Word by word, because a whole-name
       * score is diluted by the rest of a long name: "tropy" against "Trophy Bottle (600mL)". Every
       * word typed has to look like some word of the name or its group.
       */
      or (not exists (
            select 1 from public.products p2
              left join public.product_categories c2 on c2.id = p2.category_id
             where p2.store_id = p_store_id and p2.status = 'active'
               and (p2.name ilike '%' || q.term || '%'
                    or p2.sku ilike '%' || q.term || '%'
                    or c2.name ilike '%' || q.term || '%'
                    or (cardinality(words.list) > 1
                        and not exists (select 1 from unnest(words.list) w
                                         where p2.name not ilike '%' || w || '%'
                                           and coalesce(c2.name, '') not ilike '%' || w || '%'))))
          and not exists (select 1 from unnest(words.list) w
                           where length(w) >= 3
                             and word_similarity(w, p.name || ' ' || coalesce(c.name, '')) < 0.4)
          and exists (select 1 from unnest(words.list) w where length(w) >= 3))
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
    -- Among guesses, the closest first.
    case when q.term is null then 0
         else (select max(similarity(q.term, x))
                 from regexp_split_to_table(p.name || ' ' || coalesce(c.name, ''), '[^[:alnum:]]+') x)
    end desc,
    p.name
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  -- 0223: the picker pages. The order above is total (rank, then name), so an offset is stable.
  offset greatest(0, coalesce(p_offset, 0));
$function$;

CREATE OR REPLACE FUNCTION public.list_customers(p_store_id uuid, p_query text DEFAULT NULL::text, p_after_name text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 30, p_filter text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, identity_id uuid, display_name text, business_name text, phone text, balance money_amt)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with q as (
    select nullif(trim(coalesce(p_query, '')), '') as term
  ),
  matched as (
    select sc.id, sc.identity_id, sc.display_name, sc.business_name, i.phone,
           public.customer_balance_total(sc.id) as balance,
           case
             when q.term is null then 5
             when i.phone = public.normalize_phone(q.term) then 0
             when lower(sc.display_name) = lower(q.term) then 1
             when sc.display_name ilike q.term || '%' then 2
             when sc.display_name ilike '%' || q.term || '%' then 3
             when q.term ~ '[0-9]' and i.phone like '%' || public.normalize_phone(q.term) || '%' then 3
             else 4
           end as rank,
           case
             when q.term is null then 0
             else word_similarity(q.term, sc.display_name || ' ' || coalesce(sc.business_name, ''))
           end as score
      from public.store_customers sc
      cross join q
      join public.identities i on i.id = sc.identity_id
     where sc.store_id = p_store_id
       and public.is_store_member(p_store_id)
       and (
         q.term is null
         or (q.term ~ '[0-9]' and i.phone like '%' || public.normalize_phone(q.term) || '%')
         or sc.display_name  ilike '%' || q.term || '%'
         or sc.business_name ilike '%' || q.term || '%'
         /*
          * WHAT THEY MEANT (0261), only when nobody matched as typed, so "busayo" no longer brings
          * Moturayo along with Busayo Store; word by word, so a misspelt word still finds its name.
          */
         or (not exists (
               select 1 from public.store_customers s2
                 join public.identities i2 on i2.id = s2.identity_id
                where s2.store_id = p_store_id
                  and (s2.display_name ilike '%' || q.term || '%'
                       or s2.business_name ilike '%' || q.term || '%'
                       or (q.term ~ '[0-9]' and i2.phone like '%' || public.normalize_phone(q.term) || '%')))
             and not exists (select 1 from regexp_split_to_table(q.term, '\s+') w
                              where length(w) >= 3
                                and word_similarity(w, sc.display_name || ' ' || coalesce(sc.business_name, '')) < 0.3))
       )
       and (
         p_after_name is null
         or (sc.display_name, sc.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
       )
       and (
         p_filter <> 'empties' or p_filter is null
         or exists (
           select 1 from public.customer_empties ce
            where ce.store_customer_id = sc.id and coalesce(ce.side, 'they_hold') = 'they_hold'
            group by ce.product_unit_id
           having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0)
       )
  )
  select m.id, m.identity_id, m.display_name, m.business_name, m.phone, m.balance
    from matched m
   where p_filter is null or p_filter in ('all', 'empties')
      or (p_filter = 'owes' and m.balance > 0.005)
      or (p_filter = 'credit' and m.balance < -0.005)
   order by m.rank, m.score desc, m.display_name, m.id
   limit greatest(1, least(coalesce(p_limit, 30), 100));
$function$;

notify pgrst, 'reload schema';
