-- 0154 — An item's whole history, page by page, and by kind
--
-- «stock history seems not to have support for when we have initial data entered, delivery
--  entered, right now is just sold sold records»
--
-- They were all there. `product_history` returns every movement — the opening figure, each
-- delivery, damage, corrections — but the screen asked for the newest sixty, and on an item that
-- sells all day the newest sixty are sixty sales. The opening stock and last week's delivery sat
-- below the cut with no way to reach them.
--
-- This reads the same rows a page at a time (keyset on `occurred_at, id`, the order the running
-- balance is summed in), and can be asked for one kind at a time — "when did this come in?" is
-- answered without scrolling through a month of sales. The running balance is still summed over
-- EVERY movement before the filter is applied, so a delivery row still says what was on the shelf
-- after it, not a total of deliveries.
--
-- A DELIVERY NAMES ITS SUPPLIER, so the row opens the supplier's account — the record it belongs
-- to — the same way a sale opens its receipt.
--
-- A new name rather than widening `product_history`: that one has callers with positional
-- arguments, and a second overload is how an rpc call becomes ambiguous.

drop function if exists public.product_history_page(uuid, text[], timestamptz, uuid, integer);

create function public.product_history_page(
  p_product_id uuid,
  p_kinds text[] default null,
  p_before_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 40
)
returns table (
  id uuid,
  at timestamptz,
  kind text,
  qty_delta qty,
  balance qty,
  unit_cost unit_cost,
  ref_table text,
  ref_id uuid,
  note text,
  actor uuid,
  actor_name text,
  reverses_id uuid,
  supplier_id uuid,
  supplier_name text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with movements as (
    select
      m.id,
      m.occurred_at,
      m.kind,
      m.qty_delta,
      -- Summed over everything, oldest first, BEFORE any filter: what was left at that moment.
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
  from movements v
  -- This shop's name for them: somebody in two shops is one row per shop, not two history rows.
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

revoke all on function public.product_history_page(uuid, text[], timestamptz, uuid, integer) from public, anon;
grant execute on function public.product_history_page(uuid, text[], timestamptz, uuid, integer) to authenticated;
