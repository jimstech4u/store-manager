-- 0265 - A name spelled out is a name
--
-- A voice note: "Irekanmi's balance", spelled out, came through as "I R E K A N M I". Every word was
-- one letter, so the customer search's misspelling rule ("every word of three letters or more looks
-- like the name") was true of everybody, and the assistant answered with Mr Akanni. Letters spelled
-- out are now read as the word they spell, in both searches, and the customer rule needs at least
-- one word it can actually compare, as the product rule already did. Live definitions, these lines
-- changed.

CREATE OR REPLACE FUNCTION public.search_products(p_store_id uuid, p_query text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, name text, sku text, base_unit text, category_id uuid, category_name text, avg_unit_cost unit_cost, cost_is_estimated boolean, on_hand qty, pack_id uuid, pack_name text, pack_qty qty, list_price money_amt, low_stock_level numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with q as (
    -- Spelled out letter by letter, as a voice note does it, is one word (0265).
    select case when t ~ '^([[:alnum:]][ .-]+)+[[:alnum:]][.]?$' then regexp_replace(t, '[ .-]+', '', 'g') else t end as term
      from (select nullif(trim(coalesce(p_query, '')), '') as t) typed
  ),
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

CREATE OR REPLACE FUNCTION public.list_customers(p_store_id uuid, p_query text DEFAULT NULL::text, p_after_name text DEFAULT NULL::text, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 30, p_filter text DEFAULT NULL::text, p_min_amount numeric DEFAULT NULL::numeric, p_max_amount numeric DEFAULT NULL::numeric, p_quiet_days integer DEFAULT NULL::integer)
 RETURNS TABLE(id uuid, identity_id uuid, display_name text, business_name text, phone text, balance money_amt, deposit_held money_amt, last_sale_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with q as (
    -- Spelled out letter by letter, as a voice note does it, is one word (0265).
    select case when t ~ '^([[:alnum:]][ .-]+)+[[:alnum:]][.]?$' then regexp_replace(t, '[ .-]+', '', 'g') else t end as term
      from (select nullif(trim(coalesce(p_query, '')), '') as t) typed
  ),
  matched as (
    select sc.id, sc.identity_id, sc.display_name, sc.business_name, i.phone,
           public.customer_balance_total(sc.id) as balance,
           -- The same sum customers_with_deposits holds them to: taken, less given back or kept.
           coalesce((select sum(case when d.direction = 'taken' then d.amount else -d.amount end)
                       from public.customer_deposits d
                      where d.store_id = p_store_id and d.store_customer_id = sc.id), 0) as deposit_held,
           (select max(s.occurred_at) from public.sales s
             where s.store_customer_id = sc.id and s.status = 'posted') as last_sale_at,
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
                                and word_similarity(w, sc.display_name || ' ' || coalesce(sc.business_name, '')) < 0.3)
             -- With no word long enough to compare, "every word looks like the name" was true of
             -- everybody, and the closest of the whole shop came back as a match (0265).
             and exists (select 1 from regexp_split_to_table(q.term, '\s+') w where length(w) >= 3))
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
  select m.id, m.identity_id, m.display_name, m.business_name, m.phone, m.balance,
         m.deposit_held::money_amt, m.last_sale_at
    from matched m
   where (p_filter is null or p_filter in ('all', 'empties')
      or (p_filter = 'owes' and m.balance > 0.005)
      or (p_filter = 'credit' and m.balance < -0.005)
      or (p_filter = 'deposit' and m.deposit_held > 0.005)
      -- Somebody who has bought and then stopped; a customer who never bought has not gone quiet.
      or (p_filter = 'quiet' and m.last_sale_at < now() - make_interval(days => coalesce(p_quiet_days, 30))))
     -- "Above 100k" of whatever the filter is about.
     and (p_min_amount is null
          or case p_filter when 'deposit' then m.deposit_held when 'credit' then -m.balance else m.balance end >= p_min_amount)
     and (p_max_amount is null
          or case p_filter when 'deposit' then m.deposit_held when 'credit' then -m.balance else m.balance end <= p_max_amount)
   order by m.rank, m.score desc, m.display_name, m.id
   limit greatest(1, least(coalesce(p_limit, 30), 100));
$function$;

notify pgrst, 'reload schema';
