-- =====================================================================================
-- 0044 — A customer search that puts the customer you searched for first
--
-- `list_customers` matched a name three ways — exact-ish `ilike`, a phone substring, and a
-- trigram `similarity > 0.3` — and then ordered the lot ALPHABETICALLY. For a shop with a family
-- of similarly named customers that is close to useless: searching "Irekanmi 008670" matches every
-- "Irekanmi …" through the similarity clause, and the one actually typed is wherever the alphabet
-- puts it. With the function's own `limit`, a specific customer can fall outside the results of
-- their own search.
--
-- The fix is ordering, not matching. Fuzzy matching is worth keeping — a seller misspells a name
-- and still finds the person — but a fuzzy match must never outrank an exact one:
--
--   1. the phone, if the query looks like one          (a phone is an identifier, not a guess)
--   2. an exact name
--   3. a name that starts with the query
--   4. a name that contains it
--   5. everything else the similarity turned up, best first
--
-- The signature is unchanged, so every caller keeps working.
-- =====================================================================================

create or replace function public.list_customers(
  p_store_id   uuid,
  p_query      text default null,
  p_after_name text default null,
  p_after_id   uuid default null,
  p_limit      int  default 30
)
returns table (
  id            uuid,
  identity_id   uuid,
  display_name  text,
  business_name text,
  phone         text,
  balance       money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with q as (
    select nullif(trim(coalesce(p_query, '')), '') as term
  ),
  matched as (
    select sc.id, sc.identity_id, sc.display_name, sc.business_name, i.phone,
           public.customer_balance_total(sc.id) as balance,
           /*
            * Lower rank sorts first. Computed per row so the ordering is a property of the match,
            * not of the alphabet.
            */
           case
             when q.term is null then 5
             when i.phone = public.normalize_phone(q.term) then 0
             when lower(sc.display_name) = lower(q.term) then 1
             when sc.display_name ilike q.term || '%' then 2
             when sc.display_name ilike '%' || q.term || '%' then 3
             when i.phone like '%' || public.normalize_phone(q.term) || '%' then 3
             else 4
           end as rank,
           case
             when q.term is null then 0
             else similarity(sc.display_name, q.term)
           end as score
      from public.store_customers sc
      cross join q
      join public.identities i on i.id = sc.identity_id
     where sc.store_id = p_store_id
       and public.is_store_member(p_store_id)
       and (
         q.term is null
         or i.phone like '%' || public.normalize_phone(q.term) || '%'
         or sc.display_name  ilike '%' || q.term || '%'
         or sc.business_name ilike '%' || q.term || '%'
         or similarity(sc.display_name, q.term) > 0.3
       )
       -- The cursor only applies to unsearched browsing, which is still alphabetical. Paging
       -- through ranked results by name would skip rows, because rank and name disagree.
       and (
         p_after_name is null
         or (sc.display_name, sc.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
       )
  )
  select m.id, m.identity_id, m.display_name, m.business_name, m.phone, m.balance
    from matched m
   order by m.rank, m.score desc, m.display_name, m.id
   limit greatest(1, least(coalesce(p_limit, 30), 100));
$fn$;

grant execute on function public.list_customers(uuid, text, text, uuid, int) to authenticated;
