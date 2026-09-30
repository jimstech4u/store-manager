-- 0242 - A maker is counted in crates, and a maker's line is never lost from the paper
--
-- "Group markers do not have bottles." A crate from Nigerian Breweries is anybody's NBL crate; a
-- loose bottle is one beer's bottle. Three things got that wrong:
--
-- 1. THE MAKER'S UNIT. `group_return_units` (the customer form, the supplier form) ranked a maker's
--    returnable shapes by how many items use them — and every beer has both a returnable Crate and a
--    returnable Bottle, so it tied, and the tie went alphabetically to "Bottle". Arewa's opening
--    "1 Nigerian Breweries" and "1 International Breweries" went in as BOTTLES. Now the biggest
--    container comes first (the crate), then the count.
-- 2. THE SIDE. `record_customer_empties_for_group` had no side, so "the shop holds one of hers" was
--    written as "she holds one of ours". It takes `p_side` now (default: they hold ours, as before).
-- 3. THE PAPER. `customer_containers_as_at` — the receipt's "still with you" — read product rows only,
--    so an opening balance entered by maker never reached a receipt. It reads maker rows too, with
--    the crate's real size (`group_unit_base_qty`) so a maker's crate adds up with its beers' crates.
--    `customer_empties_owed` carries the same size, and All items' preview reads the receipt's own
--    function, so the two cannot disagree again.
--
-- And the yard: `yard_empties_by_group` listed a "Bottles" line under every maker. A maker that has
-- crates is shown in crates; a maker whose only container is a bottle keeps it. `countable_empties`
-- now says each shape's size, so the count screen picks the crate too.

-- ─── The size of a maker's container: what most of its items say that shape holds ─────────────
create or replace function public.group_unit_base_qty(p_category_id uuid, p_store_unit_id uuid)
returns qty
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select coalesce((
    select pu.base_qty
      from public.product_category_links l
      join public.products p on p.id = l.product_id and coalesce(p.status, 'active') = 'active'
      join public.product_units pu on pu.product_id = p.id and pu.store_unit_id = p_store_unit_id
     where l.category_id = p_category_id
     group by pu.base_qty
     order by count(*) desc, pu.base_qty desc
     limit 1
  ), 1)::qty;
$function$;

revoke all on function public.group_unit_base_qty(uuid, uuid) from public, anon;
grant execute on function public.group_unit_base_qty(uuid, uuid) to authenticated;

-- ─── 1. The maker's unit: its biggest container first ─────────────────────────────────────────
create or replace function public.group_return_units(p_category_id uuid)
returns table(store_unit_id uuid, name text, plural text, products integer)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select su.id, su.name, su.plural, count(distinct p.id)::int
    from public.product_categories c
    join public.product_category_links l on l.category_id = c.id
    join public.products p on p.id = l.product_id
    join public.product_units pu on pu.product_id = p.id and pu.is_returnable
    join public.store_units su on su.id = pu.store_unit_id
   where c.id = p_category_id
     and coalesce(p.status, 'active') = 'active'
     and public.is_store_member(c.store_id)
   group by su.id, su.name, su.plural
   -- The crate before the bottle (0242): a maker is counted in what holds many.
   order by max(pu.base_qty) desc, count(distinct p.id) desc, su.name;
$function$;

-- ─── 2. The maker writer takes a side ─────────────────────────────────────────────────────────
drop function if exists public.record_customer_empties_for_group(uuid, uuid, uuid, uuid, text, qty, text, timestamptz);
CREATE OR REPLACE FUNCTION public.record_customer_empties_for_group(p_store_id uuid, p_customer_id uuid, p_category_id uuid, p_store_unit_id uuid, p_direction text, p_qty qty, p_reason text DEFAULT NULL::text, p_occurred_at timestamp with time zone DEFAULT now(), p_side text DEFAULT 'they_hold'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id   uuid;
  v_owed qty;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to record empties' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.store_customers
     where id = p_customer_id and store_id = p_store_id
  ) then
    raise exception 'that customer does not belong to this shop' using errcode = '42501';
  end if;

  -- The maker and the word must both be this shop's. The hole 0097 closed, asked again because
  -- this is a new door into the same ledger.
  if not exists (
    select 1 from public.product_categories where id = p_category_id and store_id = p_store_id
  ) then
    raise exception 'that group does not belong to this shop' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.store_units where id = p_store_unit_id and store_id = p_store_id
  ) then
    raise exception 'that unit does not belong to this shop' using errcode = '42501';
  end if;

  if p_direction not in ('out', 'returned', 'damaged') then
    raise exception '% is not something that happens to a container', p_direction
      using errcode = '22023';
  end if;

  if coalesce(p_side, 'they_hold') not in ('they_hold', 'we_hold') then
    raise exception '% is not a side', p_side using errcode = '22023';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'say how many' using errcode = '22023';
  end if;

  if p_direction in ('returned', 'damaged') then
    select coalesce(sum(case when direction = 'out' then qty else -qty end), 0)
      into v_owed
      from public.customer_empties
     where store_customer_id = p_customer_id
       and category_id = p_category_id
       and store_unit_id = p_store_unit_id
       and coalesce(side, 'they_hold') = coalesce(p_side, 'they_hold');

    if p_qty > v_owed then
      raise exception 'they only owe % of those', v_owed using errcode = '23514';
    end if;
  end if;

  insert into public.customer_empties (store_id, store_customer_id, category_id, store_unit_id,
                                       direction, qty, reason, occurred_at, side, created_by)
  values (p_store_id, p_customer_id, p_category_id, p_store_unit_id, p_direction, p_qty,
          nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_occurred_at, now()),
          coalesce(p_side, 'they_hold'), auth.uid())
  returning id into v_id;

  return v_id;
end;
$function$;
revoke all on function public.record_customer_empties_for_group(uuid, uuid, uuid, uuid, text, qty, text, timestamptz, text) from public, anon;
grant execute on function public.record_customer_empties_for_group(uuid, uuid, uuid, uuid, text, qty, text, timestamptz, text) to authenticated;

-- ─── customer_empties_owed: a maker's crate is the size of its beers' crates ─────────────
CREATE OR REPLACE FUNCTION public.customer_empties_owed(p_store_customer_id uuid)
 RETURNS TABLE(product_id uuid, product_name text, product_unit_id uuid, unit_name text, unit_plural text, base_qty qty, group_id uuid, group_name text, side text, taken qty, returned qty, damaged qty, owed qty)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.id,
         coalesce(p.name, gc.name),
         pu.id,
         coalesce(su.name, gsu.name),
         coalesce(su.plural, gsu.plural),
         coalesce(pu.base_qty, public.group_unit_base_qty(gc.id, gsu.id), 1)::qty,
         coalesce(g.id, gc.id),
         coalesce(g.name, gc.name),
         ce.side,
         coalesce(sum(ce.qty) filter (where ce.direction = 'out'), 0)::qty,
         coalesce(sum(ce.qty) filter (where ce.direction = 'returned'), 0)::qty,
         coalesce(sum(ce.qty) filter (where ce.direction = 'damaged'), 0)::qty,
         (coalesce(sum(ce.qty) filter (where ce.direction = 'out'), 0)
          - coalesce(sum(ce.qty) filter (where ce.direction = 'returned'), 0)
          - coalesce(sum(ce.qty) filter (where ce.direction = 'damaged'), 0))::qty
    from public.customer_empties ce
    join public.store_customers c on c.id = ce.store_customer_id
    left join public.products p on p.id = ce.product_id
    left join public.product_units pu on pu.id = ce.product_unit_id
    left join public.store_units su on su.id = pu.store_unit_id
    left join public.product_categories gc on gc.id = ce.category_id
    left join public.store_units gsu on gsu.id = ce.store_unit_id
    left join lateral (
      select pc.id, pc.name
        from public.product_category_links pcl
        join public.product_categories pc on pc.id = pcl.category_id
       where pcl.product_id = p.id
         and coalesce(pc.status, 'active') = 'active'
       order by pc.name
       limit 1
    ) g on true
   where ce.store_customer_id = p_store_customer_id
     and public.is_store_member(c.store_id)
   group by p.id, p.name, pu.id, su.name, su.plural, pu.base_qty, g.id, g.name,
            gc.id, gc.name, gsu.id, gsu.name, gsu.plural, ce.side
   order by ce.side, 8 nulls last, 2, 6 desc;
$function$;

-- ─── customer_containers_as_at: what the receipt says is still with them — maker rows too ────
create or replace function public.customer_containers_as_at(p_customer uuid, p_at timestamptz)
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', t.product_id,
           'product_name', t.product_name,
           'product_unit_id', t.product_unit_id,
           'unit_name', t.unit_name,
           'unit_plural', t.unit_plural,
           'base_qty', t.base_qty,
           'group_id', t.group_id,
           'group_name', t.group_name,
           'owed', t.owed
         ) order by t.group_name nulls last, t.product_name), '[]'::jsonb)
    from (
      -- Each beer's own containers.
      select ce.product_id,
             pr.name   as product_name,
             ce.product_unit_id,
             su.name   as unit_name,
             su.plural as unit_plural,
             pu.base_qty,
             g.group_id,
             g.group_name,
             sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as owed
        from public.customer_empties ce
        join public.products pr on pr.id = ce.product_id
        join public.product_units pu on pu.id = ce.product_unit_id
        join public.store_units su on su.id = pu.store_unit_id
        left join lateral (
          select c.id as group_id, c.name as group_name
            from public.product_category_links l
            join public.product_categories c on c.id = l.category_id
           where l.product_id = pr.id and coalesce(c.status, 'active') = 'active'
           order by c.name
           limit 1
        ) g on true
       where ce.store_customer_id = p_customer
         and coalesce(ce.side, 'they_hold') = 'they_hold'
         and ce.occurred_at <= p_at
       group by ce.product_id, pr.name, ce.product_unit_id, su.name, su.plural,
                pu.base_qty, g.group_id, g.group_name
      having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
      union all
      -- And the maker's, entered without naming a beer (an opening balance, a book carried over).
      select null::uuid, pc.name, null::uuid, su.name, su.plural,
             public.group_unit_base_qty(pc.id, su.id),
             pc.id, pc.name,
             sum(case when ce.direction = 'out' then ce.qty else -ce.qty end)
        from public.customer_empties ce
        join public.product_categories pc on pc.id = ce.category_id
        join public.store_units su on su.id = ce.store_unit_id
       where ce.store_customer_id = p_customer
         and ce.product_id is null
         and coalesce(ce.side, 'they_hold') = 'they_hold'
         and ce.occurred_at <= p_at
       group by pc.id, pc.name, su.id, su.name, su.plural
      having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
    ) t;
$function$;

-- ─── order_empties_preview: All items reads the receipt's own rule for what they hold ─────────
create or replace function public.order_empties_preview(
  p_store_id uuid,
  p_customer_id uuid,
  p_lines jsonb
)
returns table(product_id uuid, product_name text, product_unit_id uuid, unit_name text,
              unit_plural text, base_qty qty, group_id uuid, group_name text, side text, owed qty)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select h.product_id, h.product_name, h.product_unit_id, h.unit_name, h.unit_plural,
         h.base_qty::qty, h.group_id, h.group_name, 'they_hold', h.owed::qty
    from jsonb_to_recordset(
           case when p_customer_id is not null
                 and public.is_store_member(p_store_id)
                 and exists (select 1 from public.store_customers c
                              where c.id = p_customer_id and c.store_id = p_store_id)
                then public.customer_containers_as_at(p_customer_id, now())
                else '[]'::jsonb end
         ) as h(product_id uuid, product_name text, product_unit_id uuid, unit_name text,
                unit_plural text, base_qty numeric, group_id uuid, group_name text, owed numeric)
  union all
  select p.id, p.name, pu.id, su.name, su.plural, coalesce(pu.base_qty, 1)::qty,
         g.id, g.name, 'they_hold', sum((l ->> 'qty')::numeric)::qty
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) l
    join public.product_units pu on pu.id = nullif(l ->> 'sale_unit_id', '')::uuid
                                and pu.is_returnable
    join public.products p on p.id = pu.product_id
                          and p.id = nullif(l ->> 'product_id', '')::uuid
                          and p.store_id = p_store_id
    join public.store_units su on su.id = pu.store_unit_id
    left join lateral (
      select pc.id, pc.name
        from public.product_category_links pcl
        join public.product_categories pc on pc.id = pcl.category_id
       where pcl.product_id = p.id
         and coalesce(pc.status, 'active') = 'active'
       order by pc.name
       limit 1
    ) g on true
   where public.is_store_member(p_store_id)
     and coalesce((l ->> 'qty')::numeric, 0) > 0
   group by p.id, p.name, pu.id, su.name, su.plural, pu.base_qty, g.id, g.name;
$function$;

-- ─── yard_empties_by_group: makers in crates ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.yard_empties_by_group(p_store_id uuid)
 RETURNS TABLE(group_id uuid, group_name text, store_unit_id uuid, unit_name text, unit_plural text, counted qty, counted_at timestamp with time zone, counted_grain text, shapes integer, in_from_customers qty, out_to_customers qty, in_from_suppliers qty, out_to_suppliers qty, in_yard qty)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with per_shape as (
    select y.*, su.id as store_unit_id
      from public.yard_empties(p_store_id) y
      join public.product_units pu on pu.id = y.product_unit_id
      join public.store_units su on su.id = pu.store_unit_id
     where y.group_id is not null
       /*
        * A MAKER IS COUNTED IN CRATES (0242). A maker that has a bigger container than this shape
        * is not listed in this shape: a loose bottle is one beer's, not the maker's. A maker whose
        * only container is a bottle keeps it.
        */
       and not exists (
         select 1
           from public.product_category_links l2
           join public.product_units pu2 on pu2.product_id = l2.product_id and pu2.is_returnable
          where l2.category_id = y.group_id
            and pu2.base_qty > pu.base_qty
       )
  ),
  group_count as (
    select distinct on (ec.category_id, ec.store_unit_id)
           ec.category_id, ec.store_unit_id, ec.qty, ec.counted_at
      from public.empties_counts ec
     where ec.store_id = p_store_id and ec.category_id is not null
     order by ec.category_id, ec.store_unit_id, ec.counted_at desc, ec.created_at desc
  )
  select p.group_id,
         p.group_name,
         p.store_unit_id,
         min(p.unit_name),
         min(p.unit_plural),
         /*
          * The group count if there is one, otherwise the sum of the shape counts — and NULL when
          * neither exists, for the same reason the shape reader returns null: a group nobody has
          * counted has no position, and `sum(coalesce(counted, 0))` would report a confident nought
          * for it and then subtract four thousand crates from that nought.
          */
         case
           when max(gc.qty) is not null then max(gc.qty)
           when count(p.counted) > 0 then sum(coalesce(p.counted, 0))
         end::qty,
         coalesce(max(gc.counted_at), max(p.counted_at)),
         case
           when max(gc.counted_at) is not null then 'group'
           when count(p.counted) > 0 then 'shape'
         end,
         count(*)::int,
         sum(p.in_from_customers)::qty,
         sum(p.out_to_customers)::qty,
         sum(p.in_from_suppliers)::qty,
         sum(p.out_to_suppliers)::qty,
         case
           when max(gc.qty) is null and count(p.counted) = 0 then null
           else (coalesce(max(gc.qty), sum(coalesce(p.counted, 0)))
                   + sum(p.in_from_customers) - sum(p.out_to_customers)
                   + sum(p.in_from_suppliers) - sum(p.out_to_suppliers))
         end::qty
    from per_shape p
    left join group_count gc on gc.category_id = p.group_id
                            and gc.store_unit_id = p.store_unit_id
   where public.is_store_member(p_store_id)
   group by p.group_id, p.group_name, p.store_unit_id
   order by p.group_name, min(p.unit_name);
$function$;

-- ─── countable_empties: each shape says how many it holds, so the count picks the crate ───
drop function if exists public.countable_empties(uuid);
CREATE OR REPLACE FUNCTION public.countable_empties(p_store_id uuid)
 RETURNS TABLE(product_unit_id uuid, product_id uuid, product_name text, store_unit_id uuid, unit_name text, unit_plural text, group_id uuid, group_name text, base_qty qty)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select pu.id, p.id, p.name, su.id, su.name, su.plural, g.category_id, g.category_name, pu.base_qty
    from public.product_units pu
    join public.products p on p.id = pu.product_id
    join public.store_units su on su.id = pu.store_unit_id
    left join lateral (
      select c.id as category_id, c.name as category_name
        from public.product_category_links l
        join public.product_categories c on c.id = l.category_id
       where l.product_id = p.id
         and coalesce(c.status, 'active') = 'active'
       order by c.name
       limit 1
    ) g on true
   where p.store_id = p_store_id
     and pu.is_returnable
     and coalesce(p.status, 'active') = 'active'
     and public.is_store_member(p_store_id)
   order by g.category_name nulls last, p.name, su.name;
$function$;

grant execute on function public.countable_empties(uuid) to authenticated;

notify pgrst, 'reload schema';
