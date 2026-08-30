-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Saying what a product is bought in and sold in
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- 0061 gave a product as many units as it needs and 0067 made the relationship between them
-- compulsory. Neither gave anybody a way to SAY any of it: `product_units` has no reader and no
-- writer, so the whole model is reachable only from SQL. This is the pair of functions the form
-- needs, and nothing more.
--
-- SAVED AS A WHOLE SET, not row by row. A shop editing an item is answering one question — "what
-- is this bought and sold in?" — and the answer is only ever right or wrong as a whole: adding a
-- kilogramme is fine, adding a kilogramme and removing the litre it was defined against is not.
-- Sending the set means the check at the end sees what the shop actually meant, instead of
-- refusing a half-finished edit that was on its way somewhere valid.
--
-- THE CALLER IS READ FROM auth.uid(). Nothing here takes a user id or a permission from the
-- browser; `has_permission` is asked, in the database, on every write.

-- ─── The shop's vocabulary ──────────────────────────────────────────────────────────

/**
 * The units this shop keeps, for the picker.
 *
 * Per-store deliberately: "Keg", "Bundle" and "Half-bag" are real units in one trade and noise in
 * another, and a global list is either too short to be useful or too long to choose from.
 */
create or replace function public.store_units_for(p_store_id uuid)
returns table (id uuid, name text, plural text, divisible boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select su.id, su.name, su.plural, su.divisible
    from public.store_units su
   where su.store_id = p_store_id
     and public.is_store_member(p_store_id)
   order by su.name;
$fn$;

grant execute on function public.store_units_for(uuid) to authenticated;

/**
 * A unit this shop had no word for yet.
 *
 * The plural is asked for rather than guessed. "Boxs" and "Kilogrammes" cannot both come out of
 * adding an "s", and a receipt reading "2 Boxs" is worse than one that says nothing at all.
 *
 * Returns the existing row when the name is already known, rather than failing: two people adding
 * "Crate" on the same afternoon have not done anything wrong.
 */
create or replace function public.create_store_unit(
  p_store_id uuid,
  p_name     text,
  p_plural   text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'products.manage') then
    raise exception 'You do not have permission to change what this shop sells.'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'Give the unit a name.' using errcode = 'check_violation';
  end if;

  select id into v_id from public.store_units
   where store_id = p_store_id and lower(name) = lower(btrim(p_name));
  if v_id is not null then
    return v_id;
  end if;

  insert into public.store_units (store_id, name, plural)
  values (p_store_id, btrim(p_name), coalesce(nullif(btrim(p_plural), ''), btrim(p_name)))
  returning id into v_id;

  return v_id;
end;
$fn$;

grant execute on function public.create_store_unit(uuid, text, text) to authenticated;

-- ─── What one product is bought and sold in ─────────────────────────────────────────

/**
 * Every unit on a product, as the form needs it.
 *
 * `defined_against_id` and `defined_qty` come back so the form can read the shop's own sentence
 * back to them — "one Bag is 24 Litres" — rather than showing a bare 24 in a box called base_qty,
 * which is a number nobody in a shop has any way to check.
 */
create or replace function public.product_units_for(p_product_id uuid)
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
  sort_order          int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select pu.id, pu.store_unit_id, su.name, su.plural, pu.base_qty,
         pu.is_bought, pu.is_sold, pu.sell_price, pu.is_returnable,
         pu.whole_digit, pu.allow_quarter, pu.allow_half, pu.allow_three_quarter,
         pu.defined_against_id, pu.defined_qty, pu.sort_order
    from public.product_units pu
    join public.store_units su on su.id = pu.store_unit_id
    join public.products p on p.id = pu.product_id
   where pu.product_id = p_product_id
     and public.is_store_member(p.store_id)
   order by pu.sort_order, pu.base_qty desc;
$fn$;

grant execute on function public.product_units_for(uuid) to authenticated;

/**
 * Replace what a product is bought and sold in.
 *
 * Each element of `p_units` is one unit:
 *
 *     { "id": null | uuid,          -- existing row, when there is one
 *       "store_unit_id": uuid,
 *       "is_bought": bool, "is_sold": bool,
 *       "sell_price": number | null,
 *       "is_returnable": bool,
 *       "whole_digit": bool, "allow_quarter": bool,
 *       "allow_half": bool, "allow_three_quarter": bool,
 *       "defined_against": uuid | null,   -- the store_unit this one was stated in terms of
 *       "defined_qty": number | null,     -- how many of THAT one of THIS is
 *       "base_qty": number }              -- only read for the base unit, which defines nothing
 *
 * `defined_against` names a STORE unit, not a product_unit row, because the form is working with
 * units the shop has chosen and half of them may not exist as rows yet. Resolving it here means a
 * brand-new product can arrive with its whole set of relationships in one call.
 *
 * TWO PASSES, and the reason matters. Every row is written first with whatever base_qty it came
 * with, and only then are the relationships applied — otherwise "one Bag is 24 Litres" would be
 * saved before the Litre row exists and the foreign key would refuse a set that is perfectly
 * valid taken as a whole.
 *
 * ENDS BY ASKING WHETHER IT ADDS UP. A product bought in a unit that reaches nothing it is sold in
 * is refused here, in the same transaction, so the half-answered version never reaches the shelf.
 */
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
             whole_digit         = coalesce((v_unit ->> 'whole_digit')::boolean, true),
             allow_quarter       = coalesce((v_unit ->> 'allow_quarter')::boolean, false),
             allow_half          = coalesce((v_unit ->> 'allow_half')::boolean, false),
             allow_three_quarter = coalesce((v_unit ->> 'allow_three_quarter')::boolean, false),
             sort_order          = coalesce((v_unit ->> 'sort_order')::int, 0)
       where id = v_id and product_id = p_product_id;
    end if;

    v_keep := v_keep || v_id;
  end loop;

  -- ── Second pass: what each one is worth in terms of another ───────────────────────
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
   * against cannot vanish and leave that relationship pointing at nothing. Postgres raises, and
   * the message says which one — a shop removing "Litre" while "Bag" is stated in litres needs to
   * be told that, not to have the Bag silently redefined.
   */
  delete from public.product_units
   where product_id = p_product_id
     and not (id = any (v_keep));

  perform public.assert_product_units_settled(p_product_id);
end;
$fn$;

grant execute on function public.save_product_units(uuid, jsonb) to authenticated;
