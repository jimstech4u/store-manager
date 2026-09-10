-- 0128 — The empties count reaches the yard, and the yard weighs everything that moves
--
-- «so we could genuinely have damages (real loss) … this is for products and empties as well,
--  because we also count has to record what we have in good and when product comeback is ticked,
--  we need the empties count as well, but here if we already count by group (e.g NBL) we just need
--  the sum because we do not need the empties breakdown again»
--
-- Two faults, both of which put a wrong number on screen rather than leaving a feature missing.
--
-- ─── ONE: the count is written and cannot be read ───────────────────────────────────
--
-- `empties_counts` (0105) is keyed by `empties_category_id` — the POOL model, retired in 0119 when
-- containers moved onto product shapes. `yard_empties` still reaches a count through it:
--
--     last_count → empties_counts.empties_category_id
--     counted    → join product_returnables pr on pr.empties_category_id = …
--                  where pr.product_unit_id is not null
--
-- In the sample shop, EIGHT of ten `product_returnables` rows have a null `product_unit_id`. So the
-- join finds nothing, every shape reports `counted = 0, counted_at = null`, and the yard is a bare
-- movement sum. Every crate the shop owned before it started using this software is invisible:
--
--     Goldberg Crates: in_yard = -4587, counted = 0, out_to_customers = 4760
--
-- Minus four and a half thousand crates, from a shop that has never been short of one. The counts
-- are all there — 40, 0, 40, 0 — sitting in the table, unreachable.
--
-- ─── TWO: the yard weighs five movements and there are nine ─────────────────────────
--
-- 0127 gave both ledgers a `side`, so there are four ways a container can move with each party.
-- `yard_empties` was only taught five of them:
--
--     customer they_hold returned   +   counted
--     customer they_hold out        −   counted
--     customer we_hold   out        +   counted (and reported under SUPPLIERS, which is wrong)
--     supplier we_hold   out        +   counted
--     supplier we_hold   returned   −   counted
--
--     customer we_hold   returned   −   MISSING  we handed their crates back
--     customer we_hold   damaged    −   MISSING  theirs broke while they were here
--     supplier they_hold out        −   MISSING  ours went out on a lorry
--     supplier they_hold returned   +   MISSING  ours came back
--
-- `scripts/probe-supplier-account.mjs` recorded a `they_hold` `out` of 25 and then asserted the
-- yard had moved by −20, which is the answer WITHOUT that movement. It passed, and it was encoding
-- the gap as the expected result. A probe that agrees with the bug is worse than no probe; it is
-- corrected here and now fails against the old function.

-- ─── The count learns what a shape is ───────────────────────────────────────────────

alter table public.empties_counts
  alter column empties_category_id drop not null;

alter table public.empties_counts
  add column if not exists product_unit_id uuid references public.product_units (id) on delete restrict,
  add column if not exists category_id     uuid references public.product_categories (id) on delete restrict,
  add column if not exists store_unit_id   uuid references public.store_units (id) on delete restrict;

/*
 * ONE GRAIN PER ROW, and the old grain still allowed.
 *
 * A count is either of a SHAPE ("40 Goldberg crates"), of a GROUP ("120 NBL crates", which is what
 * a distributor actually counts — see below), or of a POOL, which is what every historical row is.
 * The table is append-only, so those rows keep exactly what they were written with and the
 * constraint has to keep accepting them.
 */
alter table public.empties_counts
  drop constraint if exists empties_counts_one_grain;
alter table public.empties_counts
  add constraint empties_counts_one_grain check (
    (product_unit_id is not null and category_id is null and store_unit_id is null)
    or (product_unit_id is null and category_id is not null and store_unit_id is not null)
    or (product_unit_id is null and category_id is null and store_unit_id is null
        and empties_category_id is not null)
  );

create index if not exists empties_counts_shape_idx
  on public.empties_counts (store_id, product_unit_id, counted_at desc)
  where product_unit_id is not null;

create index if not exists empties_counts_group_idx
  on public.empties_counts (store_id, category_id, store_unit_id, counted_at desc)
  where category_id is not null;

comment on column public.empties_counts.product_unit_id is
  'The shape counted. One of three grains — see the empties_counts_one_grain constraint.';
comment on column public.empties_counts.category_id is
  'With store_unit_id: a GROUP count. "120 NBL crates" — the same physical crate whatever beer was '
  'in it last, which is what a distributor counts and the only figure they can honestly give.';

-- ─── Walking the yard, in one call ──────────────────────────────────────────────────

/*
 * COUNTED BY SHAPE, OR BY GROUP, in whatever mixture the shop's yard is actually stacked in.
 *
 * A yard has a stack of NBL crates. They are the same physical crate whether the beer in them was
 * Goldberg or Gulder, and asking a shop to split that stack by which label was in it last is asking
 * for a fabricated number. So a group count is a first-class answer, not a shortcut — and it is
 * authoritative for the group TOTAL without pretending to a per-product breakdown.
 *
 * One call for the whole walk, because a yard is counted in one pass and a per-shape round trip
 * would put a different `counted_at` on each stack.
 */
create or replace function public.count_empties(
  p_store_id uuid,
  p_parts    jsonb,
  p_note     text default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_part  jsonb;
  v_shape uuid;
  v_cat   uuid;
  v_unit  uuid;
  v_qty   numeric;
  v_n     int := 0;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to count empties' using errcode = '42501';
  end if;

  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then
    raise exception 'nothing to count' using errcode = '22023';
  end if;

  for v_part in select * from jsonb_array_elements(p_parts)
  loop
    v_shape := nullif(v_part ->> 'product_unit_id', '')::uuid;
    v_cat   := nullif(v_part ->> 'category_id', '')::uuid;
    v_unit  := nullif(v_part ->> 'store_unit_id', '')::uuid;
    v_qty   := (v_part ->> 'qty')::numeric;

    /*
     * A BLANK IS NOT A NOUGHT and never becomes one here.
     *
     * "None in the yard" and "nobody looked" are different facts. The screen sends only the stacks
     * somebody actually counted; a part with no quantity is a bug in the caller, not a zero.
     */
    if v_qty is null then
      raise exception 'a count needs a quantity' using errcode = '22023';
    end if;
    if v_qty < 0 then
      raise exception 'a count cannot be negative' using errcode = '22023';
    end if;

    if v_shape is not null then
      /*
       * AND THE SHAPE HAS TO BE THIS SHOP'S.
       *
       * Permission in a store answers "may this person act here". It does not answer "is this shape
       * theirs" — the hole 0097 closed across the deposit writers, where a member of one shop could
       * write rows into another shop's ledger and the shop being written to could not see how they
       * got there. Asked where no argument can skip it.
       */
      if not exists (
        select 1 from public.product_units pu
          join public.products p on p.id = pu.product_id
         where pu.id = v_shape and p.store_id = p_store_id and pu.is_returnable
      ) then
        raise exception 'that shape does not come back, or does not belong to this shop'
          using errcode = '42501';
      end if;

      insert into public.empties_counts (store_id, product_unit_id, qty, note)
      values (p_store_id, v_shape, v_qty, p_note);

    elsif v_cat is not null and v_unit is not null then
      if not exists (
        select 1 from public.product_categories c
         where c.id = v_cat and c.store_id = p_store_id
      ) then
        raise exception 'that group does not belong to this shop' using errcode = '42501';
      end if;
      if not exists (
        select 1 from public.store_units su
         where su.id = v_unit and su.store_id = p_store_id
      ) then
        raise exception 'that unit does not belong to this shop' using errcode = '42501';
      end if;

      insert into public.empties_counts (store_id, category_id, store_unit_id, qty, note)
      values (p_store_id, v_cat, v_unit, v_qty, p_note);

    else
      raise exception 'a count has to name a shape, or a group and a unit' using errcode = '22023';
    end if;

    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$fn$;

revoke all on function public.count_empties(uuid, jsonb, text) from public;
grant execute on function public.count_empties(uuid, jsonb, text) to authenticated;

-- ─── The old writer keeps working, and now lands where it can be read ───────────────

/*
 * `count_empties_on_hand` is called by the product form on a deployed build. Dropping it here would
 * break production in the window between this migration and the next app deploy, so it stays — but
 * it now resolves the pool to a shape and writes the SHAPE grain when the bridge exists, which is
 * what makes the figure readable. Where the pool maps to nothing it writes the old grain, which is
 * still better than refusing: the row is a fact somebody entered.
 */
create or replace function public.count_empties_on_hand(
  p_store_id    uuid,
  p_category_id uuid,
  p_qty         qty,
  p_note        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id    uuid;
  v_shape uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to count empties' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.empties_categories
     where id = p_category_id and store_id = p_store_id
  ) then
    raise exception 'that pool does not belong to this shop' using errcode = '42501';
  end if;

  select pr.product_unit_id into v_shape
    from public.product_returnables pr
    join public.product_units pu on pu.id = pr.product_unit_id
    join public.products p on p.id = pu.product_id
   where pr.empties_category_id = p_category_id
     and pr.product_unit_id is not null
     and p.store_id = p_store_id
   limit 1;

  insert into public.empties_counts (store_id, empties_category_id, product_unit_id, qty, note)
  values (p_store_id,
          case when v_shape is null then p_category_id end,
          v_shape,
          p_qty, p_note)
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.count_empties_on_hand(uuid, uuid, qty, text) from public;
grant execute on function public.count_empties_on_hand(uuid, uuid, qty, text) to authenticated;

-- ─── The yard, weighing all nine ────────────────────────────────────────────────────

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
  counted_grain   text,
  group_id        uuid,
  group_name      text,
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
    select pu.id, pu.product_id, p.name as product_name,
           su.id as store_unit_id, su.name, su.plural,
           g.category_id, g.category_name
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
  ),
  /*
   * THE COUNT, at whichever grain it was taken, MOST RECENT WINS.
   *
   * Not a per-group setting, which would be one more thing for a shop to get wrong and to disagree
   * with what is actually stacked in the yard. The newest count is the best evidence there is: if
   * somebody counted NBL crates as one stack this morning, that beats a per-shape count from
   * Tuesday, and the other way round too.
   */
  shape_count as (
    select distinct on (ec.product_unit_id)
           ec.product_unit_id, ec.qty, ec.counted_at
      from public.empties_counts ec
     where ec.store_id = p_store_id and ec.product_unit_id is not null
     order by ec.product_unit_id, ec.counted_at desc, ec.created_at desc
  ),
  group_count as (
    select distinct on (ec.category_id, ec.store_unit_id)
           ec.category_id, ec.store_unit_id, ec.qty, ec.counted_at
      from public.empties_counts ec
     where ec.store_id = p_store_id and ec.category_id is not null
     order by ec.category_id, ec.store_unit_id, ec.counted_at desc, ec.created_at desc
  ),
  basis as (
    select s.id as shape,
           case
             when sc.counted_at is null and gc.counted_at is null then null
             when gc.counted_at is null then 'shape'
             when sc.counted_at is null then 'group'
             when sc.counted_at >= gc.counted_at then 'shape'
             else 'group'
           end as grain,
           case
             when sc.counted_at is null and gc.counted_at is null then null
             when gc.counted_at is null then sc.counted_at
             when sc.counted_at is null then gc.counted_at
             when sc.counted_at >= gc.counted_at then sc.counted_at
             else gc.counted_at
           end as at,
           sc.qty as shape_qty
      from shapes s
      left join shape_count sc on sc.product_unit_id = s.id
      left join group_count gc on gc.category_id = s.category_id
                              and gc.store_unit_id = s.store_unit_id
  ),
  /*
   * NINE MOVEMENTS, grouped by which way the crate physically went.
   *
   * `damaged` on a container the OTHER party is holding does not move the yard — it was already
   * gone from here. `damaged` on one standing in this yard does: it is here, and then it is not.
   */
  moves as (
    select b.shape, b.grain, b.at, b.shape_qty,
           coalesce((
             select sum(ce.qty) from public.customer_empties ce
              where ce.product_unit_id = b.shape
                and (b.at is null or ce.occurred_at > b.at)
                and ((ce.side = 'they_hold' and ce.direction = 'returned')
                  or (ce.side = 'we_hold'   and ce.direction = 'out'))
           ), 0) as in_cust,
           coalesce((
             select sum(ce.qty) from public.customer_empties ce
              where ce.product_unit_id = b.shape
                and (b.at is null or ce.occurred_at > b.at)
                and ((ce.side = 'they_hold' and ce.direction = 'out')
                  or (ce.side = 'we_hold'   and ce.direction in ('returned', 'damaged')))
           ), 0) as out_cust,
           coalesce((
             select sum(se.qty) from public.supplier_empties se
              where se.product_unit_id = b.shape
                and (b.at is null or se.occurred_at > b.at)
                and ((se.side = 'we_hold'   and se.direction = 'out')
                  or (se.side = 'they_hold' and se.direction = 'returned'))
           ), 0) as in_sup,
           coalesce((
             select sum(se.qty) from public.supplier_empties se
              where se.product_unit_id = b.shape
                and (b.at is null or se.occurred_at > b.at)
                and ((se.side = 'we_hold'   and se.direction in ('returned', 'damaged'))
                  or (se.side = 'they_hold' and se.direction = 'out'))
           ), 0) as out_sup
      from basis b
  )
  select s.product_id, s.product_name, s.id, s.name, s.plural,
         m.shape_qty::qty,
         m.at,
         m.grain,
         s.category_id, s.category_name,
         m.in_cust::qty, m.out_cust::qty, m.in_sup::qty, m.out_sup::qty,
         /*
          * NULL WHEN IT CANNOT BE KNOWN, never a plausible-looking figure.
          *
          * TWO ways it cannot be known, and both used to produce a number.
          *
          * NEVER COUNTED. Without a starting position the movements are not a position — they are
          * the difference between one. "Goldberg Crates: −4,587" is what that arithmetic produces in
          * a shop that has never been short of a crate, because 4,760 went out with customers and
          * nothing said how many were in the yard to begin with. A shop that has not counted is owed
          * the words "not counted yet", not a confident minus four thousand.
          *
          * COUNTED AS PART OF A GROUP. The shop counted a stack of NBL crates and did not say how
          * many had held Goldberg. The group reader below is where that shop's answer lives.
          */
         case
           when m.grain is null or m.grain = 'group' then null
           else (coalesce(m.shape_qty, 0) + m.in_cust - m.out_cust + m.in_sup - m.out_sup)
         end::qty
    from shapes s
    join moves m on m.shape = s.id
   where public.is_store_member(p_store_id)
   order by s.product_name, s.name;
$fn$;

revoke all on function public.yard_empties(uuid) from public;
grant execute on function public.yard_empties(uuid) to authenticated;

-- ─── And the same yard, said the way a distributor says it ──────────────────────────

/*
 * The group grain, which is the one most shops will read.
 *
 * `counted` is the group count where there is one, and otherwise the SUM of the shape counts under
 * it — so a shop that counts shape by shape still gets a group total, and a shop that counts the
 * stack gets the same column filled the other way. `counted_grain` says which, because a total
 * assembled from six shape counts taken on four different days is a weaker fact than one stack
 * counted this morning, and the screen should be able to say so.
 */
create or replace function public.yard_empties_by_group(p_store_id uuid)
returns table (
  group_id      uuid,
  group_name    text,
  store_unit_id uuid,
  unit_name     text,
  unit_plural   text,
  counted       qty,
  counted_at    timestamptz,
  counted_grain text,
  shapes        int,
  in_from_customers qty,
  out_to_customers  qty,
  in_from_suppliers qty,
  out_to_suppliers  qty,
  in_yard       qty
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with per_shape as (
    select y.*, su.id as store_unit_id
      from public.yard_empties(p_store_id) y
      join public.product_units pu on pu.id = y.product_unit_id
      join public.store_units su on su.id = pu.store_unit_id
     where y.group_id is not null
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
$fn$;

revoke all on function public.yard_empties_by_group(uuid) from public;
grant execute on function public.yard_empties_by_group(uuid) to authenticated;

-- ─── What the count screen offers ───────────────────────────────────────────────────

-- Every shape that comes back, with its group, so one screen can offer both grains without a
-- second round trip and without the client deciding what a group is.
create or replace function public.countable_empties(p_store_id uuid)
returns table (
  product_unit_id uuid,
  product_id      uuid,
  product_name    text,
  store_unit_id   uuid,
  unit_name       text,
  unit_plural     text,
  group_id        uuid,
  group_name      text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select pu.id, p.id, p.name, su.id, su.name, su.plural, g.category_id, g.category_name
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
$fn$;

revoke all on function public.countable_empties(uuid) from public;
grant execute on function public.countable_empties(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('count_empties', 'count_empties_on_hand', 'yard_empties',
                          'yard_empties_by_group', 'countable_empties')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'an empties function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
