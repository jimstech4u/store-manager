-- 0239 - The shop's counts, all of them, in one history
--
-- "Also count history in full, with all products, with filter — and stock history also carries
-- that, so we can see how we counted." Each item's stock history shows its own counts (0232); this
-- is the whole shop's: every count, newest first — the item, who counted, what was on the shelf,
-- what the records expected, and whether it matched.
--
-- An item's OPENING count is left out, as in its history: it is the opening, not a count anybody
-- made afterwards. Filters: 'matched', 'off' (a difference found), 'today', 'week'; `p_query` finds
-- an item by every word typed. Paged newest first on (counted_at, id).

create or replace function public.count_history_page(
  p_store_id uuid,
  p_filter text default null,
  p_query text default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 40
)
returns table(id uuid, product_id uuid, product_name text, base_unit text, counted_at timestamptz,
              counted_by_name text, counted qty, expected qty, variance qty, status text)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  with words as (
    select coalesce(array_agg(w), '{}') as list
      from regexp_split_to_table(coalesce(trim(p_query), ''), '\s+') w
     where w <> ''
  ),
  tz as (select coalesce(timezone, 'UTC') as zone from public.stores where id = p_store_id)
  select sp.id,
         p.id,
         p.name,
         p.base_unit,
         sp.counted_at,
         coalesce(public.member_name(sp.store_id, sp.counted_by), 'Someone'),
         sp.actual_closing_qty,
         coalesce(sp.expected_at_count, sp.expected_closing_qty),
         sp.variance_qty,
         sp.status
    from public.stock_periods sp
    join public.products p on p.id = sp.product_id
    cross join words
    cross join tz
   where sp.store_id = p_store_id
     and public.is_store_member(p_store_id)
     -- Items taken off the list (a test item, a duplicate) are not the shop's counts any more.
     and p.status = 'active'
     and sp.counted_at is not null
     and sp.actual_closing_qty is not null
     -- Not the opening's own count.
     and sp.counted_at is distinct from (select min(m.occurred_at) from public.stock_movements m
                                          where m.product_id = sp.product_id and m.kind = 'opening')
     and (p_filter is null or p_filter = 'all'
          or (p_filter = 'matched' and coalesce(sp.variance_qty, 0) = 0)
          or (p_filter = 'off' and coalesce(sp.variance_qty, 0) <> 0)
          or (p_filter = 'today' and (sp.counted_at at time zone tz.zone)::date = (now() at time zone tz.zone)::date)
          or (p_filter = 'week' and sp.counted_at >= now() - interval '7 days'))
     and not exists (select 1 from unnest(words.list) w where p.name not ilike '%' || w || '%')
     and (p_before_at is null or sp.counted_at < p_before_at
          or (sp.counted_at = p_before_at and sp.id < p_before_id))
   order by sp.counted_at desc, sp.id desc
   limit greatest(1, least(coalesce(p_limit, 40), 200));
$function$;

revoke all on function public.count_history_page(uuid, text, text, timestamptz, uuid, integer) from public;
grant execute on function public.count_history_page(uuid, text, text, timestamptz, uuid, integer) to authenticated;

notify pgrst, 'reload schema';
