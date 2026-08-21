-- =====================================================================================
-- Verification: Scenarios A (packaging splits + landed cost) and E (CRODS variance)
-- from STORE_MANAGER_SCENARIOS.md, run against the real schema.
--
-- Every expected number here was computed by hand in that document BEFORE the schema existed,
-- so this checks the implementation against the domain rather than against itself.
--
-- Rolls back at the end: verification must not leave rows behind that a later CRODS count
-- would treat as real stock.
-- =====================================================================================

begin;

create table if not exists pg_temp.results (
  seq    serial,
  label  text,
  got    numeric,
  want   numeric,
  passed boolean
);

create or replace function pg_temp.check_eq(
  p_label text, p_got numeric, p_want numeric, p_tol numeric default 0.01
) returns boolean
language plpgsql as $f$
declare v_ok boolean;
begin
  v_ok := p_got is not null and abs(p_got - p_want) <= p_tol;
  insert into pg_temp.results (label, got, want, passed) values (p_label, p_got, p_want, v_ok);
  return v_ok;
end;
$f$;

create or replace function pg_temp.check_true(p_label text, p_ok boolean)
returns boolean
language plpgsql as $f$
begin
  insert into pg_temp.results (label, got, want, passed)
  values (p_label, null, null, coalesce(p_ok, false));
  return coalesce(p_ok, false);
end;
$f$;

do $$
declare
  v_uid      uuid := '00000000-0000-0000-0000-0000000000a1';
  v_store    uuid;
  v_coke     uuid;
  v_pack     uuid;
  v_sale     uuid;
  v_period   uuid;
  v_avg      numeric;
  v_onhand   numeric;
  v_total    numeric;
  v_margin   numeric;
  v_count    jsonb;
  v_cid      uuid;
  v_first    uuid;
  v_again    uuid;
  v_res      uuid;
  v_value    numeric;
  v_next     uuid;
  v_open     numeric;
  v_crods    uuid;
begin
  -- A signed-in user is simulated by setting the JWT claim that auth.uid() reads. The
  -- SECURITY DEFINER functions run as the owner but still resolve the caller from this claim,
  -- exactly as they do in production.
  insert into auth.users (id, instance_id, email, aud, role, created_at, updated_at)
  values (v_uid, '00000000-0000-0000-0000-000000000000', 'verify@test.local',
          'authenticated', 'authenticated', now(), now())
  on conflict (id) do nothing;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);

  -- ─── Setup ───────────────────────────────────────────────────────────────────────
  v_store := public.create_store('Verify Distributors',
                                 'verify-' || substr(gen_random_uuid()::text, 1, 8));

  insert into public.products (store_id, name, base_unit)
  values (v_store, 'Coca-Cola PET 60cl', 'piece') returning id into v_coke;

  insert into public.product_packs (product_id, name, base_unit_qty)
  values (v_coke, 'Pack', 12) returning id into v_pack;

  -- ─── A1: landed cost ─────────────────────────────────────────────────────────────
  -- 100 packs @ ₦3,200 = ₦320,000 + ₦15,000 delivery + ₦5,000 distribution = ₦340,000
  -- over 1,200 pieces = ₦283.33/piece. The entire point: NOT ₦266.67.
  perform public.record_purchase(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_coke, 'qty', 100, 'pack_id', v_pack, 'unit_cost', 3200)),
    'Coca-Cola Nigeria', 'INV-001', 5000, 15000, now(), gen_random_uuid());

  select avg_unit_cost into v_avg from public.products where id = v_coke;
  perform pg_temp.check_eq('A1 landed cost per piece', v_avg, 283.3333, 0.001);

  select coalesce(sum(qty_delta), 0) into v_onhand
    from public.stock_movements where product_id = v_coke;
  perform pg_temp.check_eq('A1 stock on hand', v_onhand, 1200);

  -- ─── A2: one product, four different splits ──────────────────────────────────────
  v_sale := public.record_sale(
    v_store,
    jsonb_build_array(
      jsonb_build_object('product_id', v_coke, 'qty', 1, 'pack_id', v_pack, 'unit_price', 3700),
      jsonb_build_object('product_id', v_coke, 'qty', 6, 'line_total', 1900),
      jsonb_build_object('product_id', v_coke, 'qty', 3, 'line_total', 1000),
      jsonb_build_object('product_id', v_coke, 'qty', 1, 'unit_price', 350)),
    null, now(), gen_random_uuid());

  select total into v_total from public.sales where id = v_sale;
  perform pg_temp.check_eq('A2 sale total 3700+1900+1000+350 EXACT', v_total, 6950, 0);

  select coalesce(sum(qty_delta), 0) into v_onhand
    from public.stock_movements where product_id = v_coke;
  perform pg_temp.check_eq('A2 on hand after selling 22 pcs', v_onhand, 1178);

  select sl.line_total - (sl.base_qty * sl.unit_cost_at_sale) into v_margin
    from public.sale_lines sl
   where sl.sale_id = v_sale and sl.entered_pack_id = v_pack;
  perform pg_temp.check_eq('A2 margin on 1 pack = 3700 - 3400', v_margin, 300, 0.01);

  -- ─── Idempotency: the offline retry case ─────────────────────────────────────────
  v_cid := gen_random_uuid();
  v_first := public.record_sale(v_store,
    jsonb_build_array(jsonb_build_object('product_id', v_coke, 'qty', 2, 'unit_price', 350)),
    null, now(), v_cid);
  v_again := public.record_sale(v_store,
    jsonb_build_array(jsonb_build_object('product_id', v_coke, 'qty', 2, 'unit_price', 350)),
    null, now(), v_cid);

  perform pg_temp.check_true('retry with same client_uuid returns the same sale',
                             v_first = v_again);

  select coalesce(sum(qty_delta), 0) into v_onhand
    from public.stock_movements where product_id = v_coke;
  perform pg_temp.check_eq('retry did not double-decrement stock', v_onhand, 1176);

  -- ─── Fractional guard ────────────────────────────────────────────────────────────
  begin
    perform public.record_sale(v_store,
      jsonb_build_array(jsonb_build_object('product_id', v_coke, 'qty', 3.4, 'unit_price', 350)),
      null, now(), gen_random_uuid());
    perform pg_temp.check_true('refuses 3.4 pieces of a whole-unit product', false);
  exception when others then
    perform pg_temp.check_true('refuses 3.4 pieces of a whole-unit product', true);
  end;

  -- ─── Append-only enforcement ─────────────────────────────────────────────────────
  begin
    update public.stock_movements set qty_delta = 999
     where product_id = v_coke and kind = 'sale';
    perform pg_temp.check_true('stock_movements refuses UPDATE', false);
  exception when others then
    perform pg_temp.check_true('stock_movements refuses UPDATE', true);
  end;

  begin
    delete from public.stock_movements where product_id = v_coke and kind = 'sale';
    perform pg_temp.check_true('stock_movements refuses DELETE', false);
  exception when others then
    perform pg_temp.check_true('stock_movements refuses DELETE', true);
  end;

  -- ─── Scenario E: CRODS ───────────────────────────────────────────────────────────
  -- Documented example: opening 1,200 · sales 340 · damages 3 · counted 851 → variance −6.
  -- A fresh product seeded through backfill, so opening stock is genuinely OPENING stock and
  -- receiving is 0 — which is also what a business migrating onto the tool actually does.
  insert into public.products (store_id, name, base_unit)
  values (v_store, 'CRODS Test Product', 'piece') returning id into v_crods;

  perform public.backfill_stock(v_store, v_crods, 1200, 283.3333, current_date, true);

  select id into v_period from public.stock_periods
   where product_id = v_crods and status = 'open';

  perform public.record_sale(v_store,
    jsonb_build_array(jsonb_build_object('product_id', v_crods, 'qty', 340, 'unit_price', 300)),
    null, now(), gen_random_uuid());

  insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost)
  values (v_store, v_crods, 'damage', -3, 283.3333);

  perform public.refresh_period(v_period);
  v_count := public.enter_stock_count(v_period, 851);
  raise notice 'CRODS: %', v_count;

  perform pg_temp.check_eq('E opening from backfill', (v_count ->> 'opening')::numeric, 1200);
  perform pg_temp.check_eq('E receiving is zero', (v_count ->> 'receiving')::numeric, 0);
  perform pg_temp.check_eq('E sales',            (v_count ->> 'sales')::numeric, 340);
  perform pg_temp.check_eq('E damaged',          (v_count ->> 'damaged')::numeric, 3);
  perform pg_temp.check_eq('E expected closing', (v_count ->> 'expected_closing')::numeric, 857);
  perform pg_temp.check_eq('E variance',         (v_count ->> 'variance')::numeric, -6);
  perform pg_temp.check_true('E variance flagged as needing explanation',
                             (v_count ->> 'needs_resolution')::boolean);

  -- The enforcement that makes CRODS real rather than decorative.
  begin
    perform public.close_stock_period(v_period);
    perform pg_temp.check_true('refuses to close with an unexplained variance', false);
  exception when others then
    perform pg_temp.check_true('refuses to close with an unexplained variance', true);
  end;

  v_res := public.resolve_variance(v_period, 'theft', 'six pieces unaccounted for');
  select value_at_cost into v_value from public.variance_resolutions where id = v_res;
  perform pg_temp.check_eq('E loss booked at cost 6 x 283.33', v_value, 1700, 0.05);

  v_next := public.close_stock_period(v_period);
  perform pg_temp.check_true('closes once explained', v_next is not null);

  select opening_qty into v_open from public.stock_periods where id = v_next;
  perform pg_temp.check_eq('next period opens at the COUNTED figure', v_open, 851);
end;
$$;

select
  case when passed then 'ok  ' else 'FAIL' end as status,
  label,
  got,
  want
from pg_temp.results
order by seq;

rollback;
