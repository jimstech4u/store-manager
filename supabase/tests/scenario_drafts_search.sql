-- =====================================================================================
-- Verification: shareable drafts, search, credit, linked records, activity log
--
-- Covers the requirements added on 2026-08-16: transferring an unsettled receipt between staff
-- by code, recording who finally settled it, selling on credit, category-aware product search,
-- drilling from a customer's balance into the receipts behind it, and the change log.
-- Rolls back.
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
  v_sales1  uuid := gen_random_uuid();   -- salesman A
  v_sales2  uuid := gen_random_uuid();   -- salesman B
  v_store   uuid;
  v_cat_h2o uuid;
  v_eva     uuid;
  v_coke    uuid;
  v_pack    uuid;
  v_cust    uuid;
  v_draft   uuid;
  v_code    text;
  v_claimed uuid;
  v_sale    uuid;
  v_detail  jsonb;
  v_n       int;
  v_bal     money_amt;
  v_out     money_amt;
begin
  insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, aud, role)
  values (v_sales1, '00000000-0000-0000-0000-000000000000', 'a@test.local', 'x', now(), now(),
          'authenticated', 'authenticated'),
         (v_sales2, '00000000-0000-0000-0000-000000000000', 'b@test.local', 'x', now(), now(),
          'authenticated', 'authenticated');

  perform set_config('request.jwt.claims', json_build_object('sub', v_sales1::text)::text, true);
  perform set_config('role', 'authenticated', true);

  v_store := public.create_store('Drafts Test', 'drafts-test');

  -- Salesman B works here too.
  insert into public.store_members (store_id, user_id, role_code)
  values (v_store, v_sales2, 'staff');

  -- ─── Categories and search ───────────────────────────────────────────────────────
  insert into public.product_categories (store_id, name) values (v_store, 'Water')
  returning id into v_cat_h2o;

  v_eva  := public.create_product(v_store, 'Eva 75cl', 'piece', 'Pack', 12, 2400, true);
  v_coke := public.create_product(v_store, 'Coca-Cola PET 60cl', 'piece', 'Pack', 12, 3700, true);
  update public.products set category_id = v_cat_h2o where id = v_eva;
  select id into v_pack from public.product_packs where product_id = v_coke;

  perform public.backfill_stock(v_store, v_eva,  600, 180, current_date, true);
  perform public.backfill_stock(v_store, v_coke, 1200, 283.333334, current_date, true);

  -- "water" must find Eva even though the word appears nowhere in its name — the whole point of
  -- searching by category.
  select count(*) into v_n from public.search_products(v_store, 'water');
  perform pg_temp.check_eq('searching a CATEGORY finds its products', v_n, 1);

  select count(*) into v_n from public.search_products(v_store, 'eva');
  perform pg_temp.check_eq('searching a name finds the product', v_n, 1);

  -- Misspelling still finds it; a seller typing fast one-handed should not be punished.
  select count(*) into v_n from public.search_products(v_store, 'coca cola');
  perform pg_temp.check_true('fuzzy name search works', v_n >= 1);

  select count(*) into v_n from public.search_products(v_store, null);
  perform pg_temp.check_eq('empty search returns everything', v_n, 2);

  -- ─── A draft order, created by salesman A ────────────────────────────────────────
  v_cust := public.upsert_customer(v_store, '08031234567', 'Mama Blessing');

  v_draft := public.save_draft_order(
    v_store,
    jsonb_build_array(
      jsonb_build_object('product_id', v_coke, 'qty', 2, 'pack_id', v_pack,
                         'unit_price', 3700, 'line_total', 7400)),
    null, v_cust, null, 500, 'Delivery', 'Ring on arrival'
  );

  select code into v_code from public.draft_orders where id = v_draft;
  perform pg_temp.check_true('a draft gets a share code', v_code is not null and length(v_code) = 5);
  perform pg_temp.check_true('the code avoids look-alike characters',
    v_code !~ '[O0I1L]');
  perform pg_temp.check_true('salesman A holds it',
    (select held_by from public.draft_orders where id = v_draft) = v_sales1);

  -- A draft must not touch stock. If it did, CRODS would report an unexplained loss for goods
  -- still sitting on the shelf.
  perform pg_temp.check_eq('a draft moves no stock',
    (select count(*) from public.stock_movements where product_id = v_coke and kind = 'sale'), 0);

  select count(*) into v_n from public.search_draft_orders(v_store, 'Blessing');
  perform pg_temp.check_eq('open orders are searchable by customer', v_n, 1);

  select count(*) into v_n from public.search_draft_orders(v_store, v_code);
  perform pg_temp.check_eq('open orders are findable by code', v_n, 1);

  -- ─── Salesman B claims it by code ────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales2::text)::text, true);

  v_claimed := public.claim_draft_order(v_store, v_code);
  perform pg_temp.check_true('B claims the order with the code', v_claimed = v_draft);
  perform pg_temp.check_true('the order is now held by B',
    (select held_by from public.draft_orders where id = v_draft) = v_sales2);

  -- Lower case, as it would be typed in a hurry.
  perform pg_temp.check_true('claiming is case-insensitive',
    public.claim_draft_order(v_store, lower(v_code)) = v_draft);

  -- ─── B settles it on credit (partial payment) ────────────────────────────────────
  -- 7400 + 500 fee = 7900. Pays 3000 cash; 4900 goes on the customer's account.
  v_sale := public.settle_draft_order(
    v_draft,
    jsonb_build_array(jsonb_build_object('amount', 3000, 'method', 'cash'))
  );

  perform pg_temp.check_true('settling produced a sale', v_sale is not null);
  perform pg_temp.check_true('the settler recorded is B, not A',
    (select settled_by from public.draft_orders where id = v_draft) = v_sales2);
  perform pg_temp.check_true('the draft is marked settled',
    (select status from public.draft_orders where id = v_draft) = 'settled');

  perform pg_temp.check_eq('stock moved only on settle',
    (select coalesce(sum(qty_delta), 0) from public.stock_movements
      where product_id = v_coke and kind = 'sale'), -24);

  v_bal := public.customer_balance_total(v_cust);
  perform pg_temp.check_eq('the unpaid part went on their account (7900 - 3000)', v_bal, 4900);

  -- Settling twice must not sell twice.
  perform pg_temp.check_true('re-settling returns the same sale',
    public.settle_draft_order(v_draft, '[]'::jsonb) = v_sale);
  perform pg_temp.check_eq('re-settling did not move stock again',
    (select coalesce(sum(qty_delta), 0) from public.stock_movements
      where product_id = v_coke and kind = 'sale'), -24);

  -- ─── Linked records ──────────────────────────────────────────────────────────────
  select count(*) into v_n from public.customer_statement(v_cust);
  perform pg_temp.check_eq('the balance breaks down into receipts', v_n, 1);

  select outstanding into v_out from public.customer_statement(v_cust) limit 1;
  perform pg_temp.check_eq('the receipt shows what is still owed on it', v_out, 4900);

  perform pg_temp.check_true('the statement names who settled it',
    (select settled_by from public.customer_statement(v_cust) limit 1) = v_sales2);

  v_detail := public.sale_detail(v_sale);
  perform pg_temp.check_true('a receipt opens in full',
    v_detail is not null and jsonb_array_length(v_detail -> 'lines') = 1);
  perform pg_temp.check_true('the receipt links back to the customer',
    (v_detail -> 'customer' ->> 'id')::uuid = v_cust);
  perform pg_temp.check_true('the receipt carries its share code and settler',
    (v_detail -> 'draft' ->> 'code') = v_code
    and (v_detail -> 'draft' ->> 'settled_by')::uuid = v_sales2);
  perform pg_temp.check_eq('the receipt shows the payment taken',
    jsonb_array_length(v_detail -> 'payments'), 1);

  select count(*) into v_n from public.product_history(v_coke);
  perform pg_temp.check_true('a product shows its own history', v_n >= 2);

  -- ─── Activity log ────────────────────────────────────────────────────────────────
  select count(*) into v_n from public.activity_feed(v_store, 500);
  perform pg_temp.check_true('the change log has entries', v_n > 0);

  select count(*) into v_n from public.activity_feed(v_store, 500) where source = 'stock';
  perform pg_temp.check_true('stock movements appear in the log', v_n >= 3);

  select count(*) into v_n from public.activity_feed(v_store, 500) where source = 'payment';
  perform pg_temp.check_true('payments appear in the log', v_n >= 1);

  select count(*) into v_n from public.activity_feed(v_store, 500) where source = 'change';
  perform pg_temp.check_true('document edits appear in the log', v_n >= 1);

  -- ─── Printer width is a value, not a fixed list ──────────────────────────────────
  perform public.ensure_store_settings(v_store);
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales1::text)::text, true);
  update public.store_settings set printer_width_mm = 57.5 where store_id = v_store;
  perform pg_temp.check_eq('an unusual printer width is accepted',
    (select printer_width_mm from public.store_settings where store_id = v_store), 57.5);
end;
$$;

select case when passed then 'ok  ' else 'FAIL' end as status, label, got, want
from pg_temp.results order by seq;

rollback;
