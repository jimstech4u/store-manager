-- 0080 — A shape has ROLES: bought, sold, counted, deposited
--
-- «the shape is the driver… bought in and sold in are now SELECTING from the shape which it
--  selected, not defining it again… so we can count stock in that shape, take deposit in that
--  shape»
--
-- The model already carried the tree: `defined_against_id` is the parent and `defined_qty` is how
-- many to it, with `base_qty` derived by a trigger. What it carried only half of is what a shape is
-- FOR. `is_bought` and `is_sold` existed; counting and deposits were left to be inferred, so every
-- screen inferred them slightly differently — the stock page picked "the largest sold unit", the
-- deposit screens worked in the pool's own base units, and neither was anything the shop had said.
--
-- Four roles, all flags on one shape, all chosen by the shop:
--
--   bought    deliveries arrive in it
--   sold      customers buy in it
--   counted   the shop counts the shelf in it        ← new
--   deposited a deposit is taken and returned in it  ← new

alter table public.product_units
  add column if not exists is_counted boolean not null default false,
  add column if not exists is_deposit boolean not null default false;

comment on column public.product_units.is_counted is
  'The shop counts the shelf in this shape. A distributor counts crates, not bottles, even when it '
  'sells both — and a count screen that asks for the wrong one gets a guess instead of a figure.';

comment on column public.product_units.is_deposit is
  'Deposits are taken and given back in this shape. Usually the crate: nobody holds money against a '
  'single bottle, and a deposit screen offering bottles invites an amount nobody agreed.';

-- ─── Backfill: say what every existing product was already doing ────────────────────
--
-- Not a guess dressed as data. Both defaults are the behaviour the app ALREADY had, written down
-- so it can be changed:
--
--   · counted — the largest shape the shop trades in. That is what the stock page has been
--     showing all along ("the lead unit"), and what a person counting a shelf actually uses.
--   · deposited — whatever was already marked returnable. A deposit is held against a thing that
--     comes back, so the shapes are the same ones until a shop says otherwise.

update public.product_units pu
   set is_counted = true
 where pu.is_counted = false
   and pu.id = (
     select x.id
       from public.product_units x
      where x.product_id = pu.product_id
        and (x.is_bought or x.is_sold)
      order by x.base_qty desc, x.sort_order
      limit 1
   );

update public.product_units
   set is_deposit = true
 where is_returnable = true
   and is_deposit = false;

-- ─── The editor saves them ──────────────────────────────────────────────────────────
--
-- Copied from 0068 verbatim, with the two columns added in each of the three places it writes.
-- Per the rule 0058 taught: a working function is not rewritten "more tidily" — the diff is the
-- new columns and nothing else.

create or replace function public.save_product_units(
  p_product_id uuid,
  p_units      jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store_id uuid;
  v_unit     jsonb;
  v_id       uuid;
  v_keep     uuid[] := '{}';
  v_ref      uuid;
begin
  select store_id into v_store_id from public.products where id = p_product_id;
  if v_store_id is null then
    raise exception 'That item no longer exists.' using errcode = 'no_data_found';
  end if;

  if not public.has_permission(v_store_id, 'products.manage') then
    raise exception 'You do not have permission to change what this shop sells.'
      using errcode = 'insufficient_privilege';
  end if;

  -- ── First pass: the units themselves ──────────────────────────────────────────────
  for v_unit in select * from jsonb_array_elements(p_units) loop
    v_id := nullif(v_unit ->> 'id', '')::uuid;

    if v_id is null then
      insert into public.product_units (
        product_id, store_unit_id, base_qty, is_bought, is_sold, sell_price, is_returnable,
        is_counted, is_deposit,
        whole_digit, allow_quarter, allow_half, allow_three_quarter, sort_order
      )
      values (
        p_product_id,
        (v_unit ->> 'store_unit_id')::uuid,
        coalesce((v_unit ->> 'base_qty')::qty, 1),
        coalesce((v_unit ->> 'is_bought')::boolean, false),
        coalesce((v_unit ->> 'is_sold')::boolean, false),
        nullif(v_unit ->> 'sell_price', '')::money_amt,
        coalesce((v_unit ->> 'is_returnable')::boolean, false),
        coalesce((v_unit ->> 'is_counted')::boolean, false),
        coalesce((v_unit ->> 'is_deposit')::boolean, false),
        coalesce((v_unit ->> 'whole_digit')::boolean, true),
        coalesce((v_unit ->> 'allow_quarter')::boolean, false),
        coalesce((v_unit ->> 'allow_half')::boolean, false),
        coalesce((v_unit ->> 'allow_three_quarter')::boolean, false),
        coalesce((v_unit ->> 'sort_order')::int, 0)
      )
      -- The shop adding a unit the product already has is not an error; it is the same unit.
      on conflict (product_id, store_unit_id) do update
        set is_bought = excluded.is_bought,
            is_sold = excluded.is_sold,
            sell_price = excluded.sell_price,
            is_returnable = excluded.is_returnable,
            is_counted = excluded.is_counted,
            is_deposit = excluded.is_deposit,
            whole_digit = excluded.whole_digit,
            allow_quarter = excluded.allow_quarter,
            allow_half = excluded.allow_half,
            allow_three_quarter = excluded.allow_three_quarter,
            sort_order = excluded.sort_order
      returning id into v_id;
    else
      update public.product_units
         set is_bought           = coalesce((v_unit ->> 'is_bought')::boolean, false),
             is_sold             = coalesce((v_unit ->> 'is_sold')::boolean, false),
             sell_price          = nullif(v_unit ->> 'sell_price', '')::money_amt,
             is_returnable       = coalesce((v_unit ->> 'is_returnable')::boolean, false),
             is_counted          = coalesce((v_unit ->> 'is_counted')::boolean, false),
             is_deposit          = coalesce((v_unit ->> 'is_deposit')::boolean, false),
             whole_digit         = coalesce((v_unit ->> 'whole_digit')::boolean, true),
             allow_quarter       = coalesce((v_unit ->> 'allow_quarter')::boolean, false),
             allow_half          = coalesce((v_unit ->> 'allow_half')::boolean, false),
             allow_three_quarter = coalesce((v_unit ->> 'allow_three_quarter')::boolean, false),
             sort_order          = coalesce((v_unit ->> 'sort_order')::int, 0)
       where id = v_id and product_id = p_product_id;
    end if;

    v_keep := v_keep || v_id;
  end loop;

  /*
   * ── Second pass: what each one is worth in terms of another ──────────────────────
   *
   * VERBATIM FROM 0068. A first version of this migration "tidied" the key it reads from
   * `defined_against` to `defined_against_store_unit_id` — a name the client has never sent — so
   * the null branch would have fired for every shape on every save and quietly erased every
   * relationship in the shop. Every crate would have forgotten how many bottles it holds, and
   * nothing would have raised.
   *
   * That is the 0058 failure exactly: a working function rewritten more tidily, one line changed,
   * the till stops. The rule is copy it and add; it is written down, and it still caught me.
   */
  for v_unit in select * from jsonb_array_elements(p_units) loop
    select pu.id into v_id
      from public.product_units pu
     where pu.product_id = p_product_id
       and pu.store_unit_id = (v_unit ->> 'store_unit_id')::uuid;

    if nullif(v_unit ->> 'defined_against', '') is null then
      -- The base unit, and anything the shop chose to state directly. Left as it is.
      update public.product_units
         set defined_against_id = null, defined_qty = null
       where id = v_id and defined_against_id is not null;
    else
      select pu.id into v_ref
        from public.product_units pu
       where pu.product_id = p_product_id
         and pu.store_unit_id = (v_unit ->> 'defined_against')::uuid;

      if v_ref is null then
        raise exception 'That unit is not on this item, so nothing can be measured against it.'
          using errcode = 'check_violation';
      end if;

      update public.product_units
         set defined_against_id = v_ref,
             defined_qty        = (v_unit ->> 'defined_qty')::qty
       where id = v_id;
    end if;
  end loop;

  /*
   * Units the shop took off the item.
   *
   * Restricted rather than cascaded by the foreign key, so a unit something else was measured
   * against cannot vanish and leave that relationship pointing at nothing.
   */
  delete from public.product_units
   where product_id = p_product_id
     and not (id = any (v_keep));

  perform public.assert_product_units_settled(p_product_id);
end;
$fn$;

revoke all on function public.save_product_units(uuid, jsonb) from public;
grant execute on function public.save_product_units(uuid, jsonb) to authenticated;

-- ─── The reader hands the roles back ────────────────────────────────────────────────

/*
 * DROPPED FIRST, because the return type changes — Postgres refuses `create or replace` for that,
 * and a second overload would make PostgREST answer 300 to every call, which is how 0058 stopped
 * the till saving.
 *
 * The body is 0068's, verbatim, with two columns added and NOTHING renamed. A first attempt here
 * "improved" `defined_against_id` into `defined_against_store_unit_id` — which the client reads by
 * name, so every relationship would have come back undefined and every crate would have forgotten
 * how many bottles it holds. Add columns; leave the rest alone.
 */
drop function if exists public.product_units_for(uuid);

create function public.product_units_for(p_product_id uuid)
returns table (
  id                  uuid,
  store_unit_id       uuid,
  name                text,
  plural              text,
  base_qty            qty,
  is_bought           boolean,
  is_sold             boolean,
  sell_price          money_amt,
  is_returnable       boolean,
  whole_digit         boolean,
  allow_quarter       boolean,
  allow_half          boolean,
  allow_three_quarter boolean,
  defined_against_id  uuid,
  defined_qty         qty,
  sort_order          int,
  is_counted          boolean,
  is_deposit          boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select pu.id, pu.store_unit_id, su.name, su.plural, pu.base_qty,
         pu.is_bought, pu.is_sold, pu.sell_price, pu.is_returnable,
         pu.whole_digit, pu.allow_quarter, pu.allow_half, pu.allow_three_quarter,
         pu.defined_against_id, pu.defined_qty, pu.sort_order,
         pu.is_counted, pu.is_deposit
    from public.product_units pu
    join public.store_units su on su.id = pu.store_unit_id
    join public.products p on p.id = pu.product_id
   where pu.product_id = p_product_id
     and public.is_store_member(p.store_id)
   order by pu.sort_order, pu.base_qty desc;
$fn$;

revoke all on function public.product_units_for(uuid) from public;
grant execute on function public.product_units_for(uuid) to authenticated;

-- The overload check 0058 taught us to run, for both functions rewritten here.
do $$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname in ('save_product_units', 'product_units_for')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a units function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$$;
