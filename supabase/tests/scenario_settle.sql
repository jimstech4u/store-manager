-- =====================================================================================
-- Verification: the sale screen's server side (STORE_MANAGER_PLAN.md §12)
--
-- Covers settle_sale end to end — fees, several payment methods on one sale, change, walk-in
-- versus credit customers, and the helpers the screens call (find_customers, upsert_customer,
-- create_product). Rolls back, so it leaves nothing for a later CRODS count to trip over.
-- =====================================================================================

begin;

create temporary table results (
  seq    serial,
  label  text,
  got    numeric,
  want   numeric,
  passed boolean
) on commit drop;

-- This suite switches to the `authenticated` role so RLS is actually exercised rather than
-- bypassed by a superuser — which is the point of testing against the real database. That role
-- then cannot write to the results table it needs, so grant it explicitly.
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
  v_uid      uuid := gen_random_uuid();
  v_store    uuid;
  v_coke     uuid;
  v_pack     uuid;
  v_customer uuid;
  v_sale     uuid;
  v_sale2    uuid;
  v_total    money_amt;
  v_balance  money_amt;
  v_paid     money_amt;
  v_methods  int;
  v_found    int;
  v_transfer text;
  v_client   uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at,
                          aud, role)
  values (v_uid, '00000000-0000-0000-0000-000000000000', 'settle@test.local',
          'x', now(), now(), 'authenticated', 'authenticated');

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  perform set_config('role', 'authenticated', true);

  v_store := public.create_store('Settle Test Shop', 'settle-test-shop');

  -- ─── create_product builds product + pack + price in one call ─────────────────────
  v_coke := public.create_product(v_store, 'Coca-Cola PET 60cl', 'piece', 'Pack', 12, 3700, true);
  select id into v_pack from public.product_packs where product_id = v_coke;

  perform pg_temp.check_true('create_product made a pack', v_pack is not null);
  perform pg_temp.check_eq('create_product set the list price',
    (select price from public.product_prices where product_id = v_coke), 3700);
  perform pg_temp.check_true('product displays in packs by default',
    (select default_display_pack_id from public.products where id = v_coke) = v_pack);

  -- Stock to sell from.
  perform public.backfill_stock(v_store, v_coke, 1200, 283.333334, current_date, true);

  -- ─── upsert_customer + find_customers ────────────────────────────────────────────
  v_customer := public.upsert_customer(v_store, '08031234567', 'Mama Blessing', 'Blessing Stores');
  perform pg_temp.check_true('upsert_customer created a customer', v_customer is not null);

  -- The same phone in a different format must resolve to the SAME customer, not a second one:
  -- a split identity means a debtor can look settled while owing money under another record.
  perform pg_temp.check_true('+234 form resolves to the same customer',
    public.upsert_customer(v_store, '+2348031234567', 'Mama Blessing') = v_customer);

  select count(*) into v_found from public.find_customers(v_store, '0803');
  perform pg_temp.check_eq('find_customers finds by partial phone', v_found, 1);

  -- Misspelled name still finds them — the counter reality this is built for.
  select count(*) into v_found from public.find_customers(v_store, 'Blesing');
  perform pg_temp.check_true('find_customers tolerates a misspelling', v_found >= 1);

  -- ─── Settle: credit customer, fee, split payment ─────────────────────────────────
  -- 2 packs at 3700 = 7400, plus 500 delivery = 7900. Pays 5000 cash + 1000 transfer = 6000,
  -- leaving 1900 owed.
  v_sale := public.settle_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_coke, 'qty', 2, 'pack_id', v_pack, 'unit_price', 3700)),
    jsonb_build_array(
      jsonb_build_object('amount', 5000, 'method', 'cash'),
      jsonb_build_object('amount', 1000, 'method', 'transfer', 'reference', 'TRF-991')),
    v_customer, 500, 'Delivery', 'Leave at the shop front'
  );

  select total into v_total from public.sales where id = v_sale;
  perform pg_temp.check_eq('total includes the fee (7400 + 500)', v_total, 7900);

  perform pg_temp.check_eq('fee recorded separately',
    (select fee_amount from public.sales where id = v_sale), 500);
  perform pg_temp.check_true('note recorded',
    (select note from public.sales where id = v_sale) = 'Leave at the shop front');

  select count(distinct method) into v_methods
  from public.payments where store_customer_id = v_customer;
  perform pg_temp.check_eq('two payment methods on one sale', v_methods, 2);

  select sum(amount) into v_paid from public.payments where store_customer_id = v_customer;
  perform pg_temp.check_eq('total collected', v_paid, 6000);

  v_balance := public.customer_balance_total(v_customer);
  perform pg_temp.check_eq('balance owed is 7900 - 6000', v_balance, 1900);

  -- Stock moved by 24 pieces (2 packs of 12), not 2.
  perform pg_temp.check_eq('stock fell by 24 pieces',
    (select coalesce(sum(qty_delta), 0) from public.stock_movements
      where product_id = v_coke and kind = 'sale'), -24);

  -- ─── Idempotency ─────────────────────────────────────────────────────────────────
  v_sale2 := public.settle_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_coke, 'qty', 1, 'pack_id', v_pack, 'unit_price', 3700)),
    jsonb_build_array(jsonb_build_object('amount', 3700, 'method', 'cash')),
    v_customer, 0, null, null, now(), v_client
  );
  perform pg_temp.check_true('retry returns the same sale',
    public.settle_sale(
      v_store,
      jsonb_build_array(jsonb_build_object(
        'product_id', v_coke, 'qty', 1, 'pack_id', v_pack, 'unit_price', 3700)),
      jsonb_build_array(jsonb_build_object('amount', 3700, 'method', 'cash')),
      v_customer, 0, null, null, now(), v_client
    ) = v_sale2);

  -- The retry must not take the customer's money twice — the failure that would destroy trust
  -- in this product faster than any missing feature.
  select sum(amount) into v_paid from public.payments where store_customer_id = v_customer;
  perform pg_temp.check_eq('retry did not double-charge', v_paid, 9700);

  -- ─── Walk-in (no customer) ───────────────────────────────────────────────────────
  v_sale := public.settle_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_coke, 'qty', 1, 'pack_id', v_pack, 'unit_price', 3700)),
    jsonb_build_array(jsonb_build_object('amount', 3700, 'method', 'cash')),
    null
  );
  perform pg_temp.check_true('walk-in sale records with no customer',
    (select store_customer_id from public.sales where id = v_sale) is null);
  perform pg_temp.check_eq('walk-in payment recorded',
    (select count(*) from public.payments where store_id = v_store and store_customer_id is null), 1);

  -- ─── Transfer details snapshot on the receipt ────────────────────────────────────
  perform public.ensure_store_settings(v_store);
  update public.store_settings
     set show_transfer_details = true,
         transfer_bank_name = 'First Bank',
         transfer_account_no = '0123456789',
         transfer_account_name = 'Settle Test Shop'
   where store_id = v_store;

  v_sale := public.settle_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_coke, 'qty', 1, 'pack_id', v_pack, 'unit_price', 3700)),
    '[]'::jsonb, v_customer
  );
  select transfer_details into v_transfer from public.sales where id = v_sale;
  perform pg_temp.check_true('transfer details printed on the sale',
    v_transfer like '%First Bank%' and v_transfer like '%0123456789%');

  -- Changing the bank later must not rewrite a receipt already issued.
  update public.store_settings set transfer_bank_name = 'Zenith' where store_id = v_store;
  perform pg_temp.check_true('an issued receipt keeps the account it was issued with',
    (select transfer_details from public.sales where id = v_sale) = v_transfer);

  -- ─── Settings are role-gated ─────────────────────────────────────────────────────
  perform pg_temp.check_true('owner may change settings',
    public.has_permission(v_store, 'store.settings'));
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
