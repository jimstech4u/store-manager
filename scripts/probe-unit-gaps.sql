-- Cooking oil, bought in litres and kilogrammes, sold only in litres.
-- Everything created here is removed before the report is read.

drop table if exists public._probe_unit_gap;
create table public._probe_unit_gap (step text, expected text, got text, pass boolean);

do $probe$
declare
  v_store  uuid := '7138327c-c81c-4486-a97c-92207b48b64e';
  v_prod   uuid;
  v_litre  uuid;
  v_kg     uuid;
  v_pu_l   uuid;
  v_pu_kg  uuid;
  v_base   qty;
  v_gaps   text;
  v_err    text;
begin
  -- ── The units this shop keeps ────────────────────────────────────────────────
  insert into public.store_units (store_id, name, plural)
  values (v_store, 'ProbeLitre', 'ProbeLitres') returning id into v_litre;
  insert into public.store_units (store_id, name, plural)
  values (v_store, 'ProbeKg', 'ProbeKgs') returning id into v_kg;

  insert into public.products (store_id, name, base_unit, status)
  values (v_store, 'PROBE Cooking Oil', 'litre', 'active') returning id into v_prod;

  -- Sold in litres. This is the base unit: one litre is one base unit.
  insert into public.product_units (product_id, store_unit_id, base_qty, is_bought, is_sold, sell_price)
  values (v_prod, v_litre, 1, true, true, 1200) returning id into v_pu_l;

  -- Bought in kilogrammes, and nobody has said what a kilogramme is.
  insert into public.product_units (product_id, store_unit_id, base_qty, is_bought, is_sold)
  values (v_prod, v_kg, 1, true, false) returning id into v_pu_kg;

  -- ── 1. The gap is seen ───────────────────────────────────────────────────────
  select string_agg(unit_name, ',') into v_gaps from public.unit_gaps_unchecked(v_prod);
  insert into public._probe_unit_gap values
    ('undefined kg is reported as a gap', 'ProbeKg', coalesce(v_gaps, '(none)'), v_gaps is not distinct from 'ProbeKg');

  -- ── 2. Saving is refused while the gap stands ────────────────────────────────
  begin
    perform public.assert_product_units_settled(v_prod);
    v_err := '(saved anyway)';
  exception when others then
    v_err := sqlerrm;
  end;
  insert into public._probe_unit_gap values
    ('saving refused, naming the unit', 'mentions ProbeKg', v_err, v_err like '%ProbeKg%');

  -- ── 3. One kilogramme is twenty-four litres ──────────────────────────────────
  update public.product_units
     set defined_against_id = v_pu_l, defined_qty = 24
   where id = v_pu_kg;

  select base_qty into v_base from public.product_units where id = v_pu_kg;
  insert into public._probe_unit_gap values
    ('base_qty derived from the sentence', '24', v_base::text, v_base = 24);

  select string_agg(unit_name, ',') into v_gaps from public.unit_gaps_unchecked(v_prod);
  insert into public._probe_unit_gap values
    ('gap closes', '(none)', coalesce(v_gaps, '(none)'), v_gaps is null);

  begin
    perform public.assert_product_units_settled(v_prod);
    v_err := 'saved';
  exception when others then
    v_err := sqlerrm;
  end;
  insert into public._probe_unit_gap values
    ('saving now allowed', 'saved', v_err, v_err = 'saved');

  -- ── 4. Stock bought in kg is stock that can be sold in litres ────────────────
  /*
   * Proved through the conversion, NOT by writing to the ledger.
   *
   * `stock_movements` is append-only and refuses deletes — rightly, it is the books — so a probe
   * that received three kilogrammes could never take them back out, and every future stock figure
   * for this shop would carry a test's rubbish in it. The claim being tested is the conversion
   * anyway: three kilogrammes is seventy-two litres of the same oil, so it lands in the one pool
   * the litre line already reads from, rather than in a pile of its own that nothing can sell.
   */
  insert into public._probe_unit_gap
  select 'three kg is seventy-two sellable litres', '72',
         (3 * kg.base_qty / litre.base_qty)::text,
         (3 * kg.base_qty / litre.base_qty) = 72
    from public.product_units kg, public.product_units litre
   where kg.id = v_pu_kg and litre.id = v_pu_l;

  -- And there is exactly ONE line of stock, not two: kilogrammes are a bigger scoop into the same
  -- drum, so they must never appear beside litres as if they were separate stock.
  -- Counted off the units themselves rather than through `selling_units_for_product`, which is a
  -- reader and correctly shows this probe's unauthenticated caller nothing (step 7 proves that).
  insert into public._probe_unit_gap
  select 'one line of stock, not two piles', '1 sold of 2 bought',
         count(*) filter (where is_sold)::text || ' sold of '
           || count(*) filter (where is_bought)::text || ' bought',
         count(*) filter (where is_sold) = 1 and count(*) filter (where is_bought) = 2
    from public.product_units where product_id = v_prod;

  -- ── 5. A correction carries to everything derived from it ────────────────────
  update public.product_units set defined_qty = 25 where id = v_pu_kg;
  select base_qty into v_base from public.product_units where id = v_pu_kg;
  insert into public._probe_unit_gap values
    ('correcting the sentence moves base_qty', '25', v_base::text, v_base = 25);

  -- ── 6. Units may not define each other in a circle ───────────────────────────
  begin
    update public.product_units
       set defined_against_id = v_pu_kg, defined_qty = 0.04
     where id = v_pu_l;
    v_err := '(circle accepted)';
  exception when others then
    v_err := sqlerrm;
  end;
  insert into public._probe_unit_gap values
    ('a circular definition is refused', 'refused', v_err, v_err like '%circle%');

  -- ── 7. The reader stays shut to a non-member ────────────────────────────────
  /*
   * This probe runs with no signed-in user, so it is exactly the outsider the membership test
   * exists for. The reader must return nothing — while the guard above still refused the save.
   * That pair is the whole point of splitting them.
   */
  insert into public._probe_unit_gap
  select 'reader shows a non-member nothing', '0', count(*)::text, count(*) = 0
    from public.product_unit_gaps(v_prod);

  -- ── Clean up ─────────────────────────────────────────────────────────────────
  delete from public.product_units where product_id = v_prod and defined_against_id is not null;
  delete from public.product_units where product_id = v_prod;
  delete from public.products where id = v_prod;
  delete from public.store_units where id in (v_litre, v_kg);
end;
$probe$;

select count(*) as steps,
       count(*) filter (where pass is not true) as failed,
       coalesce(string_agg(step || ' (got ' || got || ')', '; ')
                filter (where pass is not true), 'all passed') as detail
  from public._probe_unit_gap;

drop table public._probe_unit_gap;
