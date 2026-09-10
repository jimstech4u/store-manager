-- 0127 — Containers go both ways, with everybody
--
-- Both empties ledgers assumed one direction, and neither said so.
--
--   `customer_empties`  only ever meant "they are holding OURS". A customer who brings their own
--                       crates and leaves them — routine, and the reason the till has a "they
--                       brought their own" button — had nowhere to be recorded.
--   `supplier_empties`  only ever meant "we sent theirs back". What is standing in the yard because
--                       a load arrived in THEIR crates was not written down at all.
--
-- So the yard could not reconcile, and the shop noticed: what leaves for a supplier has to be
-- weighed against what came in from them, or the figure is what came back from customers minus what
-- went out to breweries, which are not the same crates.
--
-- One column fixes both: WHOSE CONTAINERS THESE ARE.
--
--     side = 'they_hold'   ours, with them
--     side = 'we_hold'     theirs, with us
--
-- `direction` keeps its meaning inside each side — `out` opens the obligation, `returned` closes it
-- by the thing arriving, `damaged` closes it by both parties agreeing it is gone. Partial
-- throughout, because partial is the ordinary case, and every movement is its own row.

alter table public.customer_empties
  add column if not exists side text not null default 'they_hold'
    check (side in ('they_hold', 'we_hold'));

alter table public.supplier_empties
  add column if not exists side text not null default 'we_hold'
    check (side in ('they_hold', 'we_hold')),
  add column if not exists direction text not null default 'returned'
    check (direction in ('out', 'returned', 'damaged'));

/*
 * WHAT THE ROWS ALREADY THERE MEANT.
 *
 * Every `customer_empties` row was written when the only meaning was "they hold ours", which is the
 * column default, so nothing needs saying. Every `supplier_empties` row was "we sent theirs back" —
 * side `we_hold`, direction `returned` — which is what the defaults above say. Stated rather than
 * assumed, because a default that happens to be right today is not a record of what was meant.
 */

comment on column public.customer_empties.side is
  'Whose containers: they_hold = ours, out with them. we_hold = theirs, left with us. A customer '
  'who brings their own crates is ordinary and had nowhere to be recorded before this.';

comment on column public.supplier_empties.side is
  'Whose containers: we_hold = theirs, standing in our yard until a lorry takes them. they_hold = '
  'ours, gone out with a load and not yet back.';

create index if not exists customer_empties_side_idx
  on public.customer_empties (store_customer_id, side, product_unit_id);
create index if not exists supplier_empties_side_idx
  on public.supplier_empties (supplier_id, side, product_unit_id);

-- ─── Both writers take a side ───────────────────────────────────────────────────────

drop function if exists public.record_customer_empties(uuid, uuid, uuid, text, qty, text, text, uuid, timestamptz);

create function public.record_customer_empties(
  p_store_id        uuid,
  p_customer_id     uuid,
  p_product_unit_id uuid,
  p_direction       text,
  p_qty             qty,
  p_reason          text default null,
  p_ref_table       text default null,
  p_ref_id          uuid default null,
  p_occurred_at     timestamptz default now(),
  p_side            text default 'they_hold'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id         uuid;
  v_product_id uuid;
  v_returnable boolean;
  v_owed       qty;
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

  if p_direction not in ('out', 'returned', 'damaged') then
    raise exception '% is not something that happens to a container', p_direction
      using errcode = '22023';
  end if;

  if p_side not in ('they_hold', 'we_hold') then
    raise exception '% is not a side', p_side using errcode = '22023';
  end if;

  select p.id, pu.is_returnable
    into v_product_id, v_returnable
    from public.product_units pu
    join public.products p on p.id = pu.product_id
   where pu.id = p_product_unit_id and p.store_id = p_store_id;

  if v_product_id is null then
    raise exception 'that shape does not belong to this shop' using errcode = '42501';
  end if;

  if not v_returnable then
    raise exception 'that shape is not marked as coming back — tick it on the product first'
      using errcode = '23514';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'say how many' using errcode = '22023';
  end if;

  -- Not more than is owed ON THIS SIDE. The two are separate obligations: a customer holding four
  -- of ours while we hold two of theirs settles each on its own.
  if p_direction in ('returned', 'damaged') then
    select coalesce(sum(case when direction = 'out' then qty else -qty end), 0)
      into v_owed
      from public.customer_empties
     where store_customer_id = p_customer_id
       and product_unit_id = p_product_unit_id
       and side = p_side;

    if p_qty > v_owed then
      raise exception 'they only owe % of those', v_owed using errcode = '23514';
    end if;
  end if;

  insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                       direction, qty, reason, ref_table, ref_id, occurred_at, side)
  values (p_store_id, p_customer_id, v_product_id, p_product_unit_id, p_direction, p_qty,
          nullif(btrim(coalesce(p_reason, '')), ''), p_ref_table, p_ref_id,
          coalesce(p_occurred_at, now()), p_side)
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_customer_empties(uuid, uuid, uuid, text, qty, text, text, uuid, timestamptz, text) from public;
grant execute on function public.record_customer_empties(uuid, uuid, uuid, text, qty, text, text, uuid, timestamptz, text) to authenticated;

drop function if exists public.record_supplier_empties(uuid, uuid, qty, uuid, text, text, timestamptz, uuid);

create function public.record_supplier_empties(
  p_store_id        uuid,
  p_product_unit_id uuid,
  p_qty             qty,
  p_purchase_id     uuid default null,
  p_supplier        text default null,
  p_note            text default null,
  p_occurred_at     timestamptz default now(),
  p_supplier_id     uuid default null,
  p_side            text default 'we_hold',
  p_direction       text default 'returned'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id         uuid;
  v_product_id uuid;
  v_returnable boolean;
  v_supplier   uuid := p_supplier_id;
  v_owed       qty;
begin
  if not public.has_permission(p_store_id, 'stock.receive') then
    raise exception 'you do not have permission to record this' using errcode = '42501';
  end if;

  if p_side not in ('they_hold', 'we_hold') then
    raise exception '% is not a side', p_side using errcode = '22023';
  end if;
  if p_direction not in ('out', 'returned', 'damaged') then
    raise exception '% is not something that happens to a container', p_direction
      using errcode = '22023';
  end if;

  select p.id, pu.is_returnable
    into v_product_id, v_returnable
    from public.product_units pu
    join public.products p on p.id = pu.product_id
   where pu.id = p_product_unit_id and p.store_id = p_store_id;

  if v_product_id is null then
    raise exception 'that shape does not belong to this shop' using errcode = '42501';
  end if;

  if not v_returnable then
    raise exception 'that shape is not marked as coming back — tick it on the product first'
      using errcode = '23514';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'say how many' using errcode = '22023';
  end if;

  if v_supplier is not null then
    if not exists (
      select 1 from public.suppliers where id = v_supplier and store_id = p_store_id
    ) then
      raise exception 'that supplier does not belong to this shop' using errcode = '42501';
    end if;
  elsif btrim(coalesce(p_supplier, '')) <> '' then
    select id into v_supplier
      from public.suppliers
     where store_id = p_store_id
       and lower(btrim(name)) = lower(btrim(p_supplier));
  end if;

  if p_direction in ('returned', 'damaged') and v_supplier is not null then
    select coalesce(sum(case when direction = 'out' then qty else -qty end), 0)
      into v_owed
      from public.supplier_empties
     where supplier_id = v_supplier
       and product_unit_id = p_product_unit_id
       and side = p_side;

    /*
     * NOT REFUSED WHEN THERE IS NO OPENING FIGURE.
     *
     * A shop's crates predate this app — bought with a load, always had, returned before anybody
     * was recording. Refusing the first honest entry because the arithmetic has not caught up is
     * how a real day's work goes unrecorded. Said as a negative instead, which is a fact worth
     * seeing: more has gone back than can be accounted for.
     */
    if v_owed > 0 and p_qty > v_owed then
      raise exception 'only % of those are outstanding', v_owed using errcode = '23514';
    end if;
  end if;

  insert into public.supplier_empties (store_id, product_id, product_unit_id, qty,
                                       purchase_id, supplier_id, supplier, note, occurred_at,
                                       side, direction)
  values (p_store_id, v_product_id, p_product_unit_id, p_qty,
          p_purchase_id, v_supplier, nullif(btrim(coalesce(p_supplier, '')), ''),
          nullif(btrim(coalesce(p_note, '')), ''), coalesce(p_occurred_at, now()),
          p_side, p_direction)
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_supplier_empties(uuid, uuid, qty, uuid, text, text, timestamptz, uuid, text, text) from public;
grant execute on function public.record_supplier_empties(uuid, uuid, qty, uuid, text, text, timestamptz, uuid, text, text) to authenticated;

-- ─── And both readers say which side ────────────────────────────────────────────────

drop function if exists public.customer_empties_owed(uuid);

create function public.customer_empties_owed(p_store_customer_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  base_qty        qty,
  group_id        uuid,
  group_name      text,
  side            text,
  taken           qty,
  returned        qty,
  damaged         qty,
  owed            qty
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id,
         coalesce(p.name, gc.name),
         pu.id,
         coalesce(su.name, gsu.name),
         coalesce(su.plural, gsu.plural),
         coalesce(pu.base_qty, 1)::qty,
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
            gc.id, gc.name, gsu.name, gsu.plural, ce.side
   order by ce.side, 8 nulls last, 2, 6 desc;
$fn$;

revoke all on function public.customer_empties_owed(uuid) from public;
grant execute on function public.customer_empties_owed(uuid) to authenticated;

drop function if exists public.supplier_empties_sent(uuid);

create function public.supplier_empties_sent(p_supplier_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  side            text,
  outstanding     qty,
  moved           qty,
  last_at         timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id, p.name, pu.id, su.name, su.plural, se.side,
         (coalesce(sum(se.qty) filter (where se.direction = 'out'), 0)
          - coalesce(sum(se.qty) filter (where se.direction in ('returned', 'damaged')), 0))::qty,
         coalesce(sum(se.qty) filter (where se.direction in ('returned', 'damaged')), 0)::qty,
         max(se.occurred_at)
    from public.supplier_empties se
    join public.suppliers s on s.id = se.supplier_id
    join public.products p on p.id = se.product_id
    join public.product_units pu on pu.id = se.product_unit_id
    join public.store_units su on su.id = pu.store_unit_id
   where se.supplier_id = p_supplier_id
     and public.is_store_member(s.store_id)
   group by p.id, p.name, pu.id, su.name, su.plural, se.side
   order by se.side, p.name, pu.base_qty desc;
$fn$;

revoke all on function public.supplier_empties_sent(uuid) from public;
grant execute on function public.supplier_empties_sent(uuid) to authenticated;

-- ─── The yard, finally weighing both sides ──────────────────────────────────────────

/*
 * WHAT IS ACTUALLY STANDING IN THE YARD.
 *
 * The first version counted what customers brought back and what went to the maker, which is not
 * the same set of crates — a load arriving in the supplier's crates puts containers in the yard
 * that no customer ever had.
 *
 *     what the last count found
 *   + what customers brought back          they_hold, returned
 *   - what customers took                  they_hold, out          (since the count)
 *   + what customers left with us          we_hold,   out
 *   + what arrived from suppliers          we_hold,   out
 *   - what went back to suppliers          we_hold,   returned
 *
 * Counted FROM THE LAST COUNT: a count is the shop putting its hand up and saying what is there,
 * and everything before it is superseded. That is the whole point of counting.
 */
drop function if exists public.yard_empties(uuid);

create function public.yard_empties(p_store_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  counted         qty,
  counted_at      timestamptz,
  in_from_customers qty,
  out_to_customers  qty,
  in_from_suppliers qty,
  out_to_suppliers  qty,
  in_yard         qty
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with shapes as (
    select pu.id, pu.product_id, p.name as product_name, su.name, su.plural
      from public.product_units pu
      join public.products p on p.id = pu.product_id
      join public.store_units su on su.id = pu.store_unit_id
     where p.store_id = p_store_id
       and pu.is_returnable
       and coalesce(p.status, 'active') = 'active'
  ),
  last_count as (
    select distinct on (ec.empties_category_id)
           ec.empties_category_id, ec.qty, ec.counted_at
      from public.empties_counts ec
     where ec.store_id = p_store_id
     order by ec.empties_category_id, ec.counted_at desc
  ),
  counted as (
    select pr.product_unit_id, lc.qty, lc.counted_at
      from last_count lc
      join public.product_returnables pr on pr.empties_category_id = lc.empties_category_id
     where pr.product_unit_id is not null
  ),
  moves as (
    select s.id as shape, c.qty as counted, c.counted_at,
           coalesce((
             select sum(ce.qty) from public.customer_empties ce
              where ce.product_unit_id = s.id and ce.side = 'they_hold'
                and ce.direction = 'returned'
                and (c.counted_at is null or ce.occurred_at > c.counted_at)
           ), 0) as in_cust,
           coalesce((
             select sum(ce.qty) from public.customer_empties ce
              where ce.product_unit_id = s.id and ce.side = 'they_hold'
                and ce.direction = 'out'
                and (c.counted_at is null or ce.occurred_at > c.counted_at)
           ), 0) as out_cust,
           coalesce((
             select sum(ce.qty) from public.customer_empties ce
              where ce.product_unit_id = s.id and ce.side = 'we_hold'
                and ce.direction = 'out'
                and (c.counted_at is null or ce.occurred_at > c.counted_at)
           ), 0) as left_by_cust,
           coalesce((
             select sum(se.qty) from public.supplier_empties se
              where se.product_unit_id = s.id and se.side = 'we_hold'
                and se.direction = 'out'
                and (c.counted_at is null or se.occurred_at > c.counted_at)
           ), 0) as in_sup,
           coalesce((
             select sum(se.qty) from public.supplier_empties se
              where se.product_unit_id = s.id and se.side = 'we_hold'
                and se.direction in ('returned', 'damaged')
                and (c.counted_at is null or se.occurred_at > c.counted_at)
           ), 0) as out_sup
      from shapes s
      left join counted c on c.product_unit_id = s.id
  )
  select s.product_id, s.product_name, s.id, s.name, s.plural,
         coalesce(m.counted, 0)::qty,
         m.counted_at,
         m.in_cust::qty,
         m.out_cust::qty,
         (m.in_sup + m.left_by_cust)::qty,
         m.out_sup::qty,
         (coalesce(m.counted, 0) + m.in_cust - m.out_cust + m.in_sup + m.left_by_cust - m.out_sup)::qty
    from shapes s
    join moves m on m.shape = s.id
   where public.is_store_member(p_store_id)
   order by s.product_name, s.name;
$fn$;

revoke all on function public.yard_empties(uuid) from public;
grant execute on function public.yard_empties(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('record_customer_empties', 'record_supplier_empties',
                          'customer_empties_owed', 'supplier_empties_sent', 'yard_empties')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'an empties function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
