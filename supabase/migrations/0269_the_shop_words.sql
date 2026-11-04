-- 0269 - The shop's own words for its items
--
-- "Customers write orders: B/S is Guinness Big Bottle, S/S is Guinness Small Stout, Dudu Red is Dudu
-- PET, and Coke can be 50cl, PET or can, so we need to ask. We need a way to ask for the correction,
-- hold it, and build the next one better." Names on paper rarely match the catalogue, and no amount
-- of fuzzy matching turns "B/S" into Guinness Big Bottle. Somebody has to say it once.
--
-- A phrase may mean ONE item, and is then found as that item, by the agent and by the app's own
-- search. Or it may mean SEVERAL ("coke"), and is then always a question among exactly those, never a
-- silent pick. Phrases are compared lower-cased with punctuation as spaces, so "B/S", "b/s" and "B S"
-- are one word.

create function public.name_phrase(p text)
 returns text
 language sql
 immutable
as $function$
  select nullif(btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', ' ', 'g')), '');
$function$;

create table public.product_aliases (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores(id) on delete cascade,
  phrase     text not null,
  product_id uuid not null references public.products(id) on delete cascade,
  taught_by  uuid default auth.uid(),
  taught_at  timestamptz not null default now(),
  unique (store_id, phrase, product_id)
);
create index product_aliases_lookup on public.product_aliases (store_id, phrase);
alter table public.product_aliases enable row level security;
create policy product_aliases_read on public.product_aliases for select using (public.is_store_member(store_id));

/* Teach a phrase: it means these items, replacing what it meant before. Anybody who sells may teach. */
create function public.teach_product_name(p_store_id uuid, p_phrase text, p_product_ids uuid[])
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_phrase text := public.name_phrase(p_phrase);
  v_count  int;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to teach item names' using errcode = '42501';
  end if;
  if v_phrase is null then
    raise exception 'say the word to teach' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_product_ids), 0) = 0 then
    raise exception 'say which item it means' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_product_ids) i
              where not exists (select 1 from public.products p where p.id = i and p.store_id = p_store_id)) then
    raise exception 'one of those items is not yours' using errcode = '42501';
  end if;

  delete from public.product_aliases where store_id = p_store_id and phrase = v_phrase;
  insert into public.product_aliases (store_id, phrase, product_id)
  select p_store_id, v_phrase, i from (select distinct unnest(p_product_ids) i) x;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

create function public.forget_product_name(p_store_id uuid, p_phrase text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count int;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to change item names' using errcode = '42501';
  end if;
  delete from public.product_aliases where store_id = p_store_id and phrase = public.name_phrase(p_phrase);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

/* What a phrase means in this shop: none, one, or the several to ask among. */
create function public.product_name_meanings(p_store_id uuid, p_phrase text)
 returns table(product_id uuid, name text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select p.id, p.name
    from public.product_aliases al
    join public.products p on p.id = al.product_id and p.status = 'active'
   where al.store_id = p_store_id and al.phrase = public.name_phrase(p_phrase)
     and public.is_store_member(p_store_id)
   order by p.name;
$function$;

/* Every word the shop has taught, for reading back and correcting. */
create function public.product_names_learned(p_store_id uuid)
 returns table(phrase text, items text[], taught_at timestamptz)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select al.phrase, array_agg(p.name order by p.name), max(al.taught_at)
    from public.product_aliases al
    join public.products p on p.id = al.product_id
   where al.store_id = p_store_id and public.is_store_member(p_store_id)
   group by al.phrase
   order by al.phrase;
$function$;

/* The lines of an order the agent could not place yet: kept with the chat, never in a model's memory. */
alter table public.whatsapp_links add column order_questions jsonb not null default '[]'::jsonb;

grant execute on function public.teach_product_name(uuid, text, uuid[]) to authenticated, service_role;
grant execute on function public.forget_product_name(uuid, text) to authenticated, service_role;
grant execute on function public.product_name_meanings(uuid, text) to authenticated, service_role;
grant execute on function public.product_names_learned(uuid) to authenticated, service_role;

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
      -- What the SHOP calls it (0269): "B/S" is Guinness Big Bottle because somebody said so.
      or exists (select 1 from public.product_aliases al
                  where al.store_id = p_store_id and al.product_id = p.id and al.phrase = public.name_phrase(q.term))
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
    -- The shop's own word for it first (0269).
    case when q.term is not null and exists (select 1 from public.product_aliases al
                  where al.store_id = p_store_id and al.product_id = p.id and al.phrase = public.name_phrase(q.term)) then 0 else 1 end,
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

notify pgrst, 'reload schema';
