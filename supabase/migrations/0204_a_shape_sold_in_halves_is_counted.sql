-- 0204 - A shape sold in halves is counted, not weighed
--
-- Two reports from the shop, one cause:
--
--   "all crates and can has 'halves too' selected and now any amount"
--   "the add part in sell page does not show when we set them in stock product"
--
-- Every shape in Ashabi but six was stored as `whole_digit = false` - WEIGHED, any amount at all -
-- while also carrying `allow_half`. Those two statements contradict each other, and `partsFor` in
-- `src/lib/quantity-rules.ts` resolves the contradiction the only way it can:
--
--     export function partsFor(rules: QuantityRules) {
--       if (!rules.wholeDigit) return [];        // a chicken has no half
--
-- So the product form showed "Halves too" lit, and the till offered no half button. The seller had
-- to type 0.5 by hand - and because a weighed thing accepts any figure at all, the till would just
-- as happily have taken 0.43 crates, which is a quantity nobody can hand over.
--
-- WHERE IT CAME FROM. `scripts/import-opening-inventory.mjs` wrote `whole_digit: false` for all 104
-- products, and `UnitsEditor` never put it back: ticking "Halves too" patched only `allowHalf`,
-- keeping whatever `wholeDigit` already was. The comment over that handler says "Ticking any step
-- means this is counted, not weighed" - the intent was right and written down, and the line under
-- it did not do it. Both are fixed alongside this migration.
--
-- WHY THE RULE LIVES HERE TOO. A client can be fixed and an importer can be fixed, and the next
-- script to load a shop's catalogue can still send the contradiction. A step and "any amount" are
-- not two settings that happen to disagree: naming a step IS saying the thing is counted. So the
-- server settles it, and no caller can store a shape that offers a half it will not sell.
--
-- Everything else in `save_product_units` is the live definition, byte for byte - including the
-- second pass whose own comment records that a previous tidy-up of it nearly erased every
-- relationship in the shop.

create or replace function public.save_product_units(p_product_id uuid, p_units jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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
        /*
         * COUNTED WHENEVER A STEP IS NAMED. See the note at the foot of this function: a shape
         * that says "halves too" and also says "any amount" offers no halves at all, because
         * `partsFor` returns nothing for a weighed thing.
         */
        coalesce((v_unit ->> 'whole_digit')::boolean, true)
          or coalesce((v_unit ->> 'allow_half')::boolean, false)
          or coalesce((v_unit ->> 'allow_quarter')::boolean, false)
          or coalesce((v_unit ->> 'allow_three_quarter')::boolean, false),
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
             -- Counted whenever a step is named; see the foot of this function.
             whole_digit         = coalesce((v_unit ->> 'whole_digit')::boolean, true)
                                     or coalesce((v_unit ->> 'allow_half')::boolean, false)
                                     or coalesce((v_unit ->> 'allow_quarter')::boolean, false)
                                     or coalesce((v_unit ->> 'allow_three_quarter')::boolean, false),
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
$function$;

grant execute on function public.save_product_units(uuid, jsonb) to authenticated;

/*
 * AND THE SHAPES ALREADY SAVED THAT WAY.
 *
 * Only ever turned ON, and only where a step is already named: this makes a shape that claims
 * halves actually sell them. A genuinely weighed thing has no step named and is not touched, so
 * nothing that should accept 3.2 kg stops accepting it.
 */
update public.product_units
   set whole_digit = true
 where not whole_digit
   and (allow_half or allow_quarter or allow_three_quarter);

notify pgrst, 'reload schema';
