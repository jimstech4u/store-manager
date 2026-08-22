-- =====================================================================================
-- Verification: sale units, fractional units, and the empties guard
--
-- Covers the shapes a product is actually sold in — 1 pack, ½ pack, ¼ pack, loose pieces, an
-- arbitrary weight, half a bottle — and the rule that a returnable can never leave without
-- either an account to owe it or cash taken for it.
-- =====================================================================================

begin;

create temporary table results (
  seq serial, label text, got numeric, want numeric, passed boolean
) on commit drop;

grant insert, select on pg_temp.results to authenticated;
grant usage, select on all sequences in schema pg_temp to authenticated;

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
  v_powder uuid;
  v_trophy uuid;
  v_bottle uuid;   -- NBL bottle category
  v_crate  uuid;   -- NBL crate category
  v_cust   uuid;
  v_sale   uuid;
  v_n      int;
  v_total  money_amt;
  v_owed   qty;
  v_failed boolean;
begin
  insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, aud, role)
  values (v_uid, '00000000-0000-0000-0000-000000000000', 'units@test.local', 'x', now(), now(),
          'authenticated', 'authenticated');
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  perform set_config('role', 'authenticated', true);

  v_store := public.create_store('Units Test', 'units-test');

  -- ─── A pack product with several sale shapes ─────────────────────────────────────
  v_coke := public.create_product(v_store, 'Coca-Cola PET 60cl', 'piece', 'Pack', 12, 3700, true);
  select id into v_pack from public.product_packs where product_id = v_coke;
  perform public.backfill_stock(v_store, v_coke, 1200, 283.333334, current_date, true);

  -- Priced individually, NOT derived: half a pack is not half the money.
  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order) values
    (v_coke, 'Pack',         12, 3700, 0),
    (v_coke, 'Half pack',     6, 1900, 1),
    (v_coke, 'Quarter pack',  3, 1000, 2),
    (v_coke, 'Piece',         1,  350, 3);

  select count(*) into v_n from public.product_sale_units_for(v_coke);
  perform pg_temp.check_eq('four sale shapes configured', v_n, 4);

  perform pg_temp.check_eq('half pack is 6 pieces',
    (select base_qty from public.product_sale_units_for(v_coke) where name = 'Half pack'), 6);
  perform pg_temp.check_eq('half pack is priced above half the pack price',
    (select price from public.product_sale_units_for(v_coke) where name = 'Half pack'), 1900);

  -- Selling one of each shape, with base_qty supplied directly by the unit.
  v_sale := public.record_sale(
    v_store,
    jsonb_build_array(
      jsonb_build_object('product_id', v_coke, 'qty', 1, 'base_qty', 12,
                         'unit_price', 3700, 'line_total', 3700),
      jsonb_build_object('product_id', v_coke, 'qty', 1, 'base_qty', 6,
                         'unit_price', 1900, 'line_total', 1900),
      jsonb_build_object('product_id', v_coke, 'qty', 1, 'base_qty', 3,
                         'unit_price', 1000, 'line_total', 1000),
      jsonb_build_object('product_id', v_coke, 'qty', 2, 'base_qty', 2,
                         'unit_price', 350, 'line_total', 700))
  );

  select total into v_total from public.sales where id = v_sale;
  perform pg_temp.check_eq('total across four shapes', v_total, 7300);

  perform pg_temp.check_eq('stock fell by 12+6+3+2 pieces',
    (select coalesce(sum(qty_delta), 0) from public.stock_movements
      where product_id = v_coke and kind = 'sale'), -23);

  -- ─── Bulk: any weight, including fractions ───────────────────────────────────────
  v_powder := public.create_product(v_store, 'Powder', 'kg', 'Bag', 50, 45000, true);
  perform public.backfill_stock(v_store, v_powder, 1000, 920, current_date, true);

  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order) values
    (v_powder, 'Bag',      50, 52000, 0),
    (v_powder, 'Half bag', 25, 26500, 1),
    (v_powder, '1kg',       1,  1100, 2);

  v_sale := public.record_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_powder, 'qty', 1.4, 'base_qty', 1.4,
      'unit_price', 1100, 'line_total', 1540))
  );
  perform pg_temp.check_eq('1.4kg sells fine', (select total from public.sales where id = v_sale), 1540);

  -- A fractional quantity of something counted in whole units must still be refused.
  v_failed := false;
  begin
    perform public.record_sale(
      v_store,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_coke, 'qty', 1, 'base_qty', 3.4,
        'unit_price', 350, 'line_total', 350)));
  exception when others then
    v_failed := true;
  end;
  perform pg_temp.check_true('3.4 pieces is refused', v_failed);

  -- ─── Returnables: bottle AND crate, two obligations from one sale ────────────────
  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'NBL bottle', 'content', 125) returning id into v_bottle;
  insert into public.empties_categories (store_id, name, kind, deposit)
  values (v_store, 'NBL crate', 'container', 1500) returning id into v_crate;

  v_trophy := public.create_product(v_store, 'Trophy Lager 60cl', 'piece', 'Crate', 12, 6000, true);
  perform public.backfill_stock(v_store, v_trophy, 600, 420, current_date, true);

  insert into public.product_returnables (product_id, empties_category_id, qty_per_base_unit)
  values (v_trophy, v_bottle, 1), (v_trophy, v_crate, null);

  -- Half a crate: 6 bottles, and the seller says the crate went out too.
  insert into public.product_sale_units (product_id, name, base_qty, price, sort_order) values
    (v_trophy, 'Crate',      12, 6000, 0),
    (v_trophy, 'Half crate',  6, 3100, 1);

  select count(*) into v_n from public.returnables_for_sale(v_trophy, 6, 1);
  perform pg_temp.check_eq('half a crate owes back TWO kinds of empty', v_n, 2);

  perform pg_temp.check_eq('six bottles are owed',
    (select qty_units from public.returnables_for_sale(v_trophy, 6, 1) where kind = 'content'), 6);
  perform pg_temp.check_eq('one crate is owed',
    (select qty_units from public.returnables_for_sale(v_trophy, 6, 1) where kind = 'container'), 1);
  perform pg_temp.check_eq('the deposit at stake',
    (select sum(deposit_total) from public.returnables_for_sale(v_trophy, 6, 1)), 2250);

  -- ─── The hole this closes ────────────────────────────────────────────────────────
  -- Anonymous, no deposit taken: the bottles would walk out unrecorded.
  v_failed := false;
  begin
    perform public.record_sale(
      v_store,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_trophy, 'qty', 1, 'base_qty', 6, 'containers_out', 1,
        'unit_price', 3100, 'line_total', 3100)));
  exception when others then
    v_failed := true;
  end;
  perform pg_temp.check_true('empties cannot leave anonymously with no deposit', v_failed);

  -- With a cash deposit, an anonymous sale is fine — the shop is made whole.
  v_sale := public.record_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_trophy, 'qty', 1, 'base_qty', 6, 'containers_out', 1,
      'unit_price', 3100, 'line_total', 3100, 'deposit_charged', 2250)));
  perform pg_temp.check_eq('a cash deposit is added to the total',
    (select total from public.sales where id = v_sale), 5350);
  perform pg_temp.check_eq('no obligation is created when cash was taken',
    (select count(*) from public.deposit_ledger where ref_id = v_sale), 0);

  -- With a customer, it becomes credit: they hold the shop's containers.
  v_cust := public.upsert_customer(v_store, '08031234567', 'Mama Blessing');
  v_sale := public.record_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_trophy, 'qty', 1, 'base_qty', 6, 'containers_out', 1,
      'unit_price', 3100, 'line_total', 3100)),
    v_cust);

  perform pg_temp.check_eq('a customer sale creates two obligations',
    (select count(*) from public.deposit_ledger where ref_id = v_sale), 2);
  perform pg_temp.check_eq('no cash deposit is charged when it is on account',
    (select total from public.sales where id = v_sale), 3100);

  v_owed := public.empties_outstanding(v_cust, v_bottle);
  perform pg_temp.check_eq('they owe six bottles', v_owed, 6);
  perform pg_temp.check_eq('and one crate', public.empties_outstanding(v_cust, v_crate), 1);

  -- Returning some of them settles part of it.
  perform public.return_empties(v_store, v_cust, v_bottle, 4);
  perform pg_temp.check_eq('after returning four, two bottles remain',
    public.empties_outstanding(v_cust, v_bottle), 2);

  -- Returning more than is owed must be refused, or the ledger would go negative and the shop
  -- would appear to owe the customer bottles it never gave them.
  v_failed := false;
  begin
    perform public.return_empties(v_store, v_cust, v_bottle, 99);
  exception when others then
    v_failed := true;
  end;
  perform pg_temp.check_true('cannot return more empties than are owed', v_failed);
end;
$$;

select case when passed then 'ok  ' else 'FAIL' end as status, label, got, want
from pg_temp.results order by seq;

rollback;
