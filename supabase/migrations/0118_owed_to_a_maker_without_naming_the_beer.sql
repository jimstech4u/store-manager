-- 0118 — Owed to a maker, without naming the beer
--
-- «if it is group, then we can say one input like 24 NBL»
--
-- Opening balances arrive this way. A shop bringing its book across knows it is holding twenty-four
-- NBL crates for Daniel; it does not know, and will never know, how many were Goldberg and how many
-- were Star. That is not a gap in the record — it is what the record says, because an NBL crate
-- settles any NBL crate and nobody counted them by brand.
--
-- `customer_empties` demanded a product and a shape, so the only ways to enter that were to invent
-- a product — putting twenty-four crates against Goldberg because it sells most, which is a fact
-- nobody stated — or to leave it out and start the account wrong.
--
-- A row now names EITHER a product's shape OR a maker and a shape-word. Both are containers owed;
-- they differ in how precisely the shop knows what they were, and that difference is now visible
-- instead of guessed at.

alter table public.customer_empties
  alter column product_id      drop not null,
  alter column product_unit_id drop not null;

alter table public.customer_empties
  add column if not exists category_id uuid
    references public.product_categories (id) on delete restrict,
  add column if not exists store_unit_id uuid
    references public.store_units (id) on delete restrict;

/*
 * ONE OR THE OTHER, NEVER NEITHER.
 *
 * A row naming no product and no maker is a quantity of nothing. This constraint is what stops the
 * nullable columns above from becoming a way to write meaningless rows — the usual cost of relaxing
 * a NOT NULL, and the reason it is added in the same migration rather than left for later.
 */
alter table public.customer_empties
  drop constraint if exists customer_empties_says_what;

alter table public.customer_empties
  add constraint customer_empties_says_what check (
    (product_unit_id is not null and product_id is not null)
    or (category_id is not null and store_unit_id is not null)
  );

create index if not exists customer_empties_group_idx
  on public.customer_empties (store_customer_id, category_id, store_unit_id);

comment on column public.customer_empties.category_id is
  'The maker, when the shop knows the containers are theirs but not which product they came from — '
  'an opening balance carried across from a book. Mutually exclusive with product_unit_id.';

-- ─── The writer for a maker-level row ───────────────────────────────────────────────

create or replace function public.record_customer_empties_for_group(
  p_store_id      uuid,
  p_customer_id   uuid,
  p_category_id   uuid,
  p_store_unit_id uuid,
  p_direction     text,
  p_qty           qty,
  p_reason        text default null,
  p_occurred_at   timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
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

  if p_qty is null or p_qty <= 0 then
    raise exception 'say how many' using errcode = '22023';
  end if;

  if p_direction in ('returned', 'damaged') then
    select coalesce(sum(case when direction = 'out' then qty else -qty end), 0)
      into v_owed
      from public.customer_empties
     where store_customer_id = p_customer_id
       and category_id = p_category_id
       and store_unit_id = p_store_unit_id;

    if p_qty > v_owed then
      raise exception 'they only owe % of those', v_owed using errcode = '23514';
    end if;
  end if;

  insert into public.customer_empties (store_id, store_customer_id, category_id, store_unit_id,
                                       direction, qty, reason, occurred_at)
  values (p_store_id, p_customer_id, p_category_id, p_store_unit_id, p_direction, p_qty,
          nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_customer_empties_for_group(uuid, uuid, uuid, uuid, text, qty, text, timestamptz) from public;
grant execute on function public.record_customer_empties_for_group(uuid, uuid, uuid, uuid, text, qty, text, timestamptz) to authenticated;

-- ─── And the readers say both kinds ─────────────────────────────────────────────────

create or replace function public.customer_empties_owed(p_store_customer_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  base_qty        qty,
  group_id        uuid,
  group_name      text,
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
  select
    p.id,
    /*
     * A GROUP ROW HAS NO PRODUCT, and says so rather than borrowing one.
     *
     * The maker's name carries it, because that is the truest thing anybody can say about those
     * containers, and `product_id` stays null so a screen can tell the two apart.
     */
    coalesce(p.name, gc.name),
    pu.id,
    coalesce(su.name, gsu.name),
    coalesce(su.plural, gsu.plural),
    coalesce(pu.base_qty, 1)::qty,
    coalesce(g.id, gc.id),
    coalesce(g.name, gc.name),
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
            gc.id, gc.name, gsu.name, gsu.plural
   order by 8 nulls last, 2, 6 desc;
$fn$;

revoke all on function public.customer_empties_owed(uuid) from public;
grant execute on function public.customer_empties_owed(uuid) to authenticated;

create or replace function public.customer_empties_ledger(p_store_customer_id uuid)
returns table (
  id           uuid,
  product_name text,
  unit_name    text,
  unit_plural  text,
  direction    text,
  qty          qty,
  reason       text,
  occurred_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select ce.id,
         coalesce(p.name, gc.name),
         coalesce(su.name, gsu.name),
         coalesce(su.plural, gsu.plural),
         ce.direction, ce.qty, ce.reason, ce.occurred_at
    from public.customer_empties ce
    join public.store_customers c on c.id = ce.store_customer_id
    left join public.products p on p.id = ce.product_id
    left join public.product_units pu on pu.id = ce.product_unit_id
    left join public.store_units su on su.id = pu.store_unit_id
    left join public.product_categories gc on gc.id = ce.category_id
    left join public.store_units gsu on gsu.id = ce.store_unit_id
   where ce.store_customer_id = p_store_customer_id
     and public.is_store_member(c.store_id)
   order by ce.occurred_at desc, ce.created_at desc;
$fn$;

revoke all on function public.customer_empties_ledger(uuid) from public;
grant execute on function public.customer_empties_ledger(uuid) to authenticated;

-- ─── What the customer form offers ──────────────────────────────────────────────────

-- Only makers that actually have something coming back. A group of PET bottles nobody returns is
-- not an answer to "what of yours are they holding".
create or replace function public.groups_with_returnables(p_store_id uuid)
returns table (id uuid, name text, products int)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select c.id, c.name, count(distinct p.id)::int
    from public.product_categories c
    join public.product_category_links l on l.category_id = c.id
    join public.products p on p.id = l.product_id
    join public.product_units pu on pu.product_id = p.id and pu.is_returnable
   where c.store_id = p_store_id
     and coalesce(c.status, 'active') = 'active'
     and coalesce(p.status, 'active') = 'active'
     and public.is_store_member(p_store_id)
   group by c.id, c.name
   order by c.name;
$fn$;

revoke all on function public.groups_with_returnables(uuid) from public;
grant execute on function public.groups_with_returnables(uuid) to authenticated;

-- The shapes a maker's containers come back in, so "24 NBL" can say 24 of what.
create or replace function public.group_return_units(p_category_id uuid)
returns table (store_unit_id uuid, name text, plural text, products int)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select su.id, su.name, su.plural, count(distinct p.id)::int
    from public.product_categories c
    join public.product_category_links l on l.category_id = c.id
    join public.products p on p.id = l.product_id
    join public.product_units pu on pu.product_id = p.id and pu.is_returnable
    join public.store_units su on su.id = pu.store_unit_id
   where c.id = p_category_id
     and public.is_store_member(c.store_id)
   group by su.id, su.name, su.plural
   order by count(distinct p.id) desc, su.name;
$fn$;

revoke all on function public.group_return_units(uuid) from public;
grant execute on function public.group_return_units(uuid) to authenticated;

-- Products with at least one shape that comes back, for the other tab.
create or replace function public.products_with_returnables(p_store_id uuid)
returns table (product_id uuid, product_name text, group_name text, shapes int)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id, p.name,
         (select pc.name
            from public.product_category_links l
            join public.product_categories pc on pc.id = l.category_id
           where l.product_id = p.id and coalesce(pc.status, 'active') = 'active'
           order by pc.name limit 1),
         count(*)::int
    from public.products p
    join public.product_units pu on pu.product_id = p.id and pu.is_returnable
   where p.store_id = p_store_id
     and coalesce(p.status, 'active') = 'active'
     and public.is_store_member(p_store_id)
   group by p.id, p.name
   order by p.name;
$fn$;

revoke all on function public.products_with_returnables(uuid) from public;
grant execute on function public.products_with_returnables(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('record_customer_empties_for_group', 'customer_empties_owed',
                          'customer_empties_ledger', 'groups_with_returnables',
                          'group_return_units', 'products_with_returnables')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'an empties function has % overloads', n;
    end if;
  end loop;
end;
$check$;
