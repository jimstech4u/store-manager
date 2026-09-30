-- 0232 - An item's history shows its counts, including the ones that matched
--
-- "A count that matched is not stock history, but we need to also have the history that we counted
-- here and the qty stays the same."
--
-- `product_history_page` listed ledger rows only, so a count that agreed with the records — which
-- moves nothing — left no trace on the item's history at all. Counts now come in as their own kind,
-- `count`: when, who, what was counted (`balance`), and the difference it found (`qty_delta`, 0 when
-- it matched). The opening's own count is left out: it is the opening, already on the list.
--
-- Same signature and columns, so every caller keeps working. A caller asking for particular kinds
-- gets counts only when it asks for 'count'.

create or replace function public.product_history_page(
  p_product_id uuid,
  p_kinds text[] default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 40
)
returns table(id uuid, at timestamptz, kind text, qty_delta qty, balance qty, unit_cost unit_cost,
              ref_table text, ref_id uuid, note text, actor uuid, actor_name text, reverses_id uuid,
              supplier_id uuid, supplier_name text)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  with movements as (
    select
      m.id,
      m.occurred_at,
      m.kind,
      m.qty_delta,
      sum(m.qty_delta) over (order by m.occurred_at, m.id rows unbounded preceding) as balance,
      m.unit_cost,
      m.ref_table,
      m.ref_id,
      m.note,
      m.created_by,
      m.reverses_id,
      p.store_id
    from public.stock_movements m
    join public.products p on p.id = m.product_id
    where m.product_id = p_product_id
      and public.is_store_member(p.store_id)
  ),
  opened as (
    select min(m.occurred_at) as at
      from public.stock_movements m
     where m.product_id = p_product_id and m.kind = 'opening'
  ),
  counts as (
    select
      sp.id,
      sp.counted_at as occurred_at,
      'count'::text as kind,
      coalesce(sp.variance_qty, 0)::numeric as qty_delta,
      sp.actual_closing_qty::numeric as balance,
      null::numeric as unit_cost,
      'stock_periods'::text as ref_table,
      sp.id as ref_id,
      null::text as note,
      sp.counted_by as created_by,
      null::uuid as reverses_id,
      sp.store_id
    from public.stock_periods sp
    join public.products p on p.id = sp.product_id
    where sp.product_id = p_product_id
      and sp.counted_at is not null
      and sp.actual_closing_qty is not null
      and public.is_store_member(p.store_id)
      and sp.counted_at is distinct from (select at from opened)
  ),
  everything as (
    select * from movements
    union all
    select * from counts
  )
  select
    v.id,
    v.occurred_at,
    v.kind,
    v.qty_delta,
    v.balance,
    v.unit_cost,
    v.ref_table,
    v.ref_id,
    v.note,
    v.created_by,
    coalesce(
      nullif(trim(coalesce(sm.first_name, '') || ' ' || coalesce(sm.last_name, '')), ''),
      sm.login_email,
      u.email,
      'Someone'
    ),
    v.reverses_id,
    pu.supplier_id,
    coalesce(su.name, pu.supplier_name)
  from everything v
  left join public.store_members sm on sm.user_id = v.created_by and sm.store_id = v.store_id
  left join auth.users u on u.id = v.created_by
  left join public.purchases pu on v.ref_table = 'purchases' and pu.id = v.ref_id
  left join public.suppliers su on su.id = pu.supplier_id
  where (p_kinds is null or cardinality(p_kinds) = 0 or v.kind = any (p_kinds))
    and (
      p_before_at is null
      or v.occurred_at < p_before_at
      or (v.occurred_at = p_before_at and v.id < p_before_id)
    )
  order by v.occurred_at desc, v.id desc
  limit greatest(1, least(coalesce(p_limit, 40), 200));
$function$;

notify pgrst, 'reload schema';
