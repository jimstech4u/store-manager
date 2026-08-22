-- =====================================================================================
-- Verification: price ranges, the sale-unit guard, named charges, the account picture,
-- on-demand stock, and store codes.
--
-- Uses the domain expert's own numbers throughout — ₦4,500 / ₦4,450 / ₦4,420, and the customer
-- who owes money across several charges plus three different pools of empties.
-- =====================================================================================

begin;

create temporary table results (
  seq serial, label text, got numeric, want numeric, passed boolean
) on commit drop;

grant insert, select on pg_temp.results to authenticated, anon;
grant usage, select on all sequences in schema pg_temp to authenticated, anon;

create or replace function pg_temp.check_eq(p_label text, p_got numeric, p_want numeric, p_tol numeric default 0.01)
returns boolean language plpgsql as $$
declare v_ok boolean;
begin
  v_ok := p_got is not null and abs(p_got - p_want) <= p_tol;
  insert into pg_temp.results (label, got, want, passed) values (p_label, p_got, p_want, v_ok);
  return v_ok;
end $$;

create or replace function pg_temp.check_true(p_label text, p_ok boolean)
returns boolean language plpgsql as $$
begin
  insert into pg_temp.results (label, got, want, passed)
  values (p_label, null, null, coalesce(p_ok, false));
  return coalesce(p_ok, false);
end $$;

do $$
declare
  v_uid    uuid := gen_random_uuid();
  v_store  uuid;
  v_coke   uuid;
  v_pack   uuid;
  v_unit   uuid;
  v_eva    uuid;
  v_cust   uuid;
  v_sale   uuid;
  v_nbl    uuid;
  v_guin   uuid;
  v_disp   uuid;
  v_trophy uuid;
  v_p      jsonb;
  v_acct   jsonb;
  v_res    jsonb;
  v_failed boolean;
  v_code   text;
begin
  insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, aud, role)
  values (v_uid, '00000000-0000-0000-0000-000000000000', 'price@test.local', 'x', now(), now(),
          'authenticated', 'authenticated');
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  perform set_config('role', 'authenticated', true);

  v_store := public.create_store('Pricing Test', 'pricing-test');

  -- ─── Price ranges ────────────────────────────────────────────────────────────────
  v_coke := public.create_product(v_store, 'Coca-Cola PET 60cl', 'piece', 'Pack', 12, 4500, true);
  select id into v_pack from public.product_packs where product_id = v_coke;
  perform public.backfill_stock(v_store, v_coke, 20000, 3400, current_date, true);

  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
  values (v_coke, 'Pack', 12, 4500, 0) returning id into v_unit;

  insert into public.product_price_tiers (product_id, sale_unit_id, min_qty, max_qty, price)
  values (v_coke, v_unit,   5,  100, 4450),
         (v_coke, v_unit, 101, 1000, 4420);

  perform pg_temp.check_eq('two bands configured',
    (select count(*) from public.product_price_tiers_for(v_coke)), 2);

  -- Below the first band: the ordinary price.
  v_res := public.resolve_price(v_coke, 1, v_unit);
  perform pg_temp.check_eq('1 pack uses the list price', (v_res ->> 'suggested')::numeric, 4500);
  perform pg_temp.check_true('and says so', (v_res ->> 'reason') = 'list');

  v_res := public.resolve_price(v_coke, 4, v_unit);
  perform pg_temp.check_eq('4 packs is still list price', (v_res ->> 'suggested')::numeric, 4500);

  -- Boundaries are the part that goes wrong, so all four are checked.
  perform pg_temp.check_eq('5 packs enters the first band',
    (public.resolve_price(v_coke, 5, v_unit) ->> 'suggested')::numeric, 4450);
  perform pg_temp.check_eq('100 packs is still the first band',
    (public.resolve_price(v_coke, 100, v_unit) ->> 'suggested')::numeric, 4450);
  perform pg_temp.check_eq('101 packs enters the second band',
    (public.resolve_price(v_coke, 101, v_unit) ->> 'suggested')::numeric, 4420);
  perform pg_temp.check_eq('1000 packs is the second band',
    (public.resolve_price(v_coke, 1000, v_unit) ->> 'suggested')::numeric, 4420);

  -- Above every band: falls back rather than inventing a price.
  perform pg_temp.check_eq('beyond the last band falls back to list',
    (public.resolve_price(v_coke, 5000, v_unit) ->> 'suggested')::numeric, 4500);

  v_res := public.resolve_price(v_coke, 50, v_unit);
  perform pg_temp.check_true('a bulk price explains itself', (v_res ->> 'reason') = 'bulk');
  perform pg_temp.check_eq('and still reports the normal price',
    (v_res ->> 'base_price')::numeric, 4500);

  -- Overlapping bands are a configuration mistake, not a tie to be broken silently.
  v_failed := false;
  begin
    insert into public.product_price_tiers (product_id, sale_unit_id, min_qty, max_qty, price)
    values (v_coke, v_unit, 50, 200, 4400);
  exception when others then
    v_failed := true;
  end;
  perform pg_temp.check_true('an overlapping band is refused', v_failed);

  -- The seller always outranks the price list.
  v_sale := public.record_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_coke, 'qty', 1000, 'base_qty', 12000,
      'unit_price', 4500, 'line_total', 4500000)));
  perform pg_temp.check_eq('a seller may charge full price for 1000 packs',
    (select total from public.sales where id = v_sale), 4500000);

  -- ─── The sale-unit guard ─────────────────────────────────────────────────────────
  v_eva := public.create_product(v_store, 'Eva 75cl', 'piece', 'Pack', 12, 2400, true);
  perform public.backfill_stock(v_store, v_eva, 600, 180, current_date, true);
  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order)
  values (v_eva, 'Pack', 12, 2400, 0), (v_eva, 'Half pack', 6, 1300, 1);

  update public.products set allow_free_qty = false where id = v_eva;

  -- A whole number of an allowed shape is fine.
  perform pg_temp.check_true('two half packs are allowed',
    public.record_sale(v_store, jsonb_build_array(jsonb_build_object(
      'product_id', v_eva, 'qty', 2, 'base_qty', 12,
      'unit_price', 1300, 'line_total', 2600))) is not null);

  -- A quarter pack is not a shape this product is sold in.
  v_failed := false;
  begin
    perform public.record_sale(v_store, jsonb_build_array(jsonb_build_object(
      'product_id', v_eva, 'qty', 1, 'base_qty', 3,
      'unit_price', 700, 'line_total', 700)));
  exception when others then v_failed := true;
  end;
  perform pg_temp.check_true('a quarter pack is refused when not configured', v_failed);

  -- Nor is a single piece.
  v_failed := false;
  begin
    perform public.record_sale(v_store, jsonb_build_array(jsonb_build_object(
      'product_id', v_eva, 'qty', 1, 'base_qty', 1,
      'unit_price', 250, 'line_total', 250)));
  exception when others then v_failed := true;
  end;
  perform pg_temp.check_true('a loose piece is refused when not configured', v_failed);

  -- The same quantity is fine for a product that allows any amount.
  perform pg_temp.check_true('the guard is per product, not global',
    public.record_sale(v_store, jsonb_build_array(jsonb_build_object(
      'product_id', v_coke, 'qty', 1, 'base_qty', 1,
      'unit_price', 400, 'line_total', 400))) is not null);

  -- ─── The account picture ─────────────────────────────────────────────────────────
  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'Nigerian Breweries', 'content', 125) returning id into v_nbl;
  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'Guinness', 'content', 150) returning id into v_guin;
  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'Dispenser bottle', 'container', 2500) returning id into v_disp;

  v_cust := public.upsert_customer(v_store, '08031234567', 'Mama Blessing');

  -- Star and Gulder are different products in ONE pool: 14 NBL empties, any mix.
  v_trophy := public.create_product(v_store, 'Star 60cl', 'piece', 'Crate', 12, 6000, true);
  perform public.backfill_stock(v_store, v_trophy, 600, 420, current_date, true);
  insert into public.product_returnables (product_id, empties_category_id, qty_per_base_unit)
  values (v_trophy, v_nbl, 1);

  v_sale := public.record_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_trophy, 'qty', 14, 'base_qty', 14,
      'unit_price', 500, 'line_total', 200000)),
    v_cust, now(), null,
    jsonb_build_array(
      jsonb_build_object('label', 'Transport', 'amount', 2000),
      jsonb_build_object('label', 'Loading', 'amount', 4000))
  );

  perform pg_temp.check_eq('two named charges are kept apart',
    (select count(*) from public.sale_charges where sale_id = v_sale), 2);
  perform pg_temp.check_eq('the total includes both charges',
    (select total from public.sales where id = v_sale), 206000);

  -- Empties from other pools, so the account shows three separate obligations.
  insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                     direction, qty_units, deposit_per_unit)
  values (v_store, v_cust, v_guin, 'collected', 20, 150),
         (v_store, v_cust, v_disp, 'collected', 2, 2500);

  perform public.record_payment(v_store, v_cust, 191000, 'transfer');

  v_acct := public.customer_account(v_cust);

  perform pg_temp.check_eq('what they still owe', (v_acct ->> 'balance')::numeric, 15000);
  perform pg_temp.check_eq('charges are itemised', jsonb_array_length(v_acct -> 'charges'), 2);
  perform pg_temp.check_eq('three separate pools of empties',
    jsonb_array_length(v_acct -> 'empties'), 3);

  perform pg_temp.check_eq('14 Nigerian Breweries empties',
    (select (e ->> 'qty')::numeric from jsonb_array_elements(v_acct -> 'empties') e
      where e ->> 'category' = 'Nigerian Breweries'), 14);
  perform pg_temp.check_eq('20 Guinness empties',
    (select (e ->> 'qty')::numeric from jsonb_array_elements(v_acct -> 'empties') e
      where e ->> 'category' = 'Guinness'), 20);
  perform pg_temp.check_eq('2 dispenser bottles',
    (select (e ->> 'qty')::numeric from jsonb_array_elements(v_acct -> 'empties') e
      where e ->> 'category' = 'Dispenser bottle'), 2);

  -- ─── On-demand stock ─────────────────────────────────────────────────────────────
  declare
    v_new uuid;
  begin
    v_new := public.create_product(v_store, 'Malta Guinness', 'piece', 'Pack', 24, 6000, true);

    perform pg_temp.check_true('a new product is not initialised yet',
      (select stock_initialised_at from public.products where id = v_new) is null);

    v_p := public.initialise_stock(v_store, v_new, 96, 210);
    perform pg_temp.check_true('first count is accepted', not (v_p ->> 'already')::boolean);
    perform pg_temp.check_eq('and becomes the position', (v_p ->> 'on_hand')::numeric, 96);

    -- Two staff reaching for the same product must not double the opening figure.
    v_p := public.initialise_stock(v_store, v_new, 96, 210);
    perform pg_temp.check_true('a second attempt is recognised', (v_p ->> 'already')::boolean);
    perform pg_temp.check_eq('and does not double the stock', (v_p ->> 'on_hand')::numeric, 96);

    perform pg_temp.check_true('the cost is flagged as an estimate',
      (select cost_is_estimated from public.products where id = v_new));
  end;

  -- ─── Store code ──────────────────────────────────────────────────────────────────
  perform public.complete_onboarding(v_store);
  v_code := public.ensure_store_code(v_store);
  perform pg_temp.check_true('a shop code is issued', length(v_code) = 6);
  perform pg_temp.check_true('with no look-alike characters', v_code !~ '[O0I1L]');
  perform pg_temp.check_true('asking again returns the same code',
    public.ensure_store_code(v_store) = v_code);

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', null, true);

  v_res := public.find_store_by_code(v_code);
  perform pg_temp.check_true('the public can find the shop by code',
    (v_res ->> 'name') = 'Pricing Test');
  -- A public handle confirms the shop and stops. It is not a way to read the books.
  perform pg_temp.check_true('and gets nothing else', not (v_res ? 'balance'));
  perform pg_temp.check_true('a wrong code finds nothing',
    public.find_store_by_code('ZZZZZZ') is null);
end;
$$;

select case when passed then 'ok  ' else 'FAIL' end as status, label, got, want
from pg_temp.results order by seq;

rollback;
