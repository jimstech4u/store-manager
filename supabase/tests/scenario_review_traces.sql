-- =====================================================================================
-- Verification: add-as-you-go with review, and the movement trace
--
-- The workflow that removes the "enter 1,000 products first" wall: staff add what they need in
-- the moment, a manager confirms afterwards. Checks that both halves hold — juniors are not
-- blocked, and nothing they create is silently treated as vouched for.
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
  v_owner uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
  v_store uuid;
  v_res   jsonb;
  v_prod  uuid;
  v_cust  uuid;
  v_queue jsonb;
  v_sale  uuid;
  v_mv    uuid;
  v_failed boolean;
begin
  insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, aud, role)
  values (v_owner, '00000000-0000-0000-0000-000000000000', 'owner@t.local', 'x', now(), now(),
          'authenticated', 'authenticated'),
         (v_staff, '00000000-0000-0000-0000-000000000000', 'staff@t.local', 'x', now(), now(),
          'authenticated', 'authenticated');

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner::text)::text, true);
  perform set_config('role', 'authenticated', true);

  v_store := public.create_store('Review Test', 'review-test');
  insert into public.store_members (store_id, user_id, role_code)
  values (v_store, v_staff, 'staff');

  -- ─── Staff add mid-sale; it works, and it is marked unconfirmed ──────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff::text)::text, true);

  v_res := public.quick_add_product(v_store, 'Eva 75cl', 'piece', 'Pack', 12, 2400, 240, 180);
  v_prod := (v_res ->> 'product_id')::uuid;

  perform pg_temp.check_true('staff can add a product without being blocked', v_prod is not null);
  perform pg_temp.check_true('and it is NOT auto-confirmed', not (v_res ->> 'confirmed')::boolean);
  perform pg_temp.check_true('the record says so',
    (select confirmed_at from public.products where id = v_prod) is null);

  -- Usable immediately — the whole point. A pending product that cannot be sold would just be a
  -- different kind of wall.
  perform pg_temp.check_eq('the stock they entered is live',
    public.stock_on_hand(v_prod), 240);

  v_res := public.quick_add_customer(v_store, '08031234567', 'Mama Blessing');
  v_cust := (v_res ->> 'customer_id')::uuid;
  perform pg_temp.check_true('staff can add a customer', v_cust is not null);
  perform pg_temp.check_true('also unconfirmed', not (v_res ->> 'confirmed')::boolean);

  -- Selling to them works right away, including on credit.
  v_sale := public.record_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'qty', 2, 'base_qty', 24, 'unit_price', 2400, 'line_total', 4800)),
    v_cust);
  perform pg_temp.check_true('a pending product and customer can transact', v_sale is not null);

  -- Staff cannot confirm their own work.
  v_failed := false;
  begin
    perform public.confirm_product(v_prod);
  exception when others then v_failed := true;
  end;
  perform pg_temp.check_true('staff cannot confirm their own product', v_failed);

  v_failed := false;
  begin
    perform public.review_movement(
      (select id from public.stock_movements where product_id = v_prod and kind = 'opening'),
      true);
  exception when others then v_failed := true;
  end;
  perform pg_temp.check_true('staff cannot sign off stock', v_failed);

  -- ─── The queue the manager sees ──────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner::text)::text, true);

  v_queue := public.pending_review(v_store);
  perform pg_temp.check_eq('one product waiting',
    jsonb_array_length(v_queue -> 'products'), 1);
  perform pg_temp.check_eq('one customer waiting',
    jsonb_array_length(v_queue -> 'customers'), 1);
  perform pg_temp.check_eq('one stock entry waiting',
    jsonb_array_length(v_queue -> 'stock_entries'), 1);

  -- Sales are deliberately NOT in the queue: a sale is evidenced by its receipt and its money,
  -- and queueing every one would bury the entries that need a second look.
  perform pg_temp.check_true('sales are not queued for review',
    not exists (
      select 1 from jsonb_array_elements(v_queue -> 'stock_entries') e
      where e ->> 'kind' = 'sale'));

  -- ─── Confirming ──────────────────────────────────────────────────────────────────
  perform public.confirm_product(v_prod);
  perform public.confirm_customer(v_cust);
  perform pg_temp.check_true('the owner can confirm the product',
    (select confirmed_at from public.products where id = v_prod) is not null);
  perform pg_temp.check_true('and the customer',
    (select confirmed_at from public.store_customers where id = v_cust) is not null);

  v_queue := public.pending_review(v_store);
  perform pg_temp.check_eq('the product leaves the queue',
    jsonb_array_length(v_queue -> 'products'), 0);
  perform pg_temp.check_eq('and the customer', jsonb_array_length(v_queue -> 'customers'), 0);

  -- ─── Rejecting a stock claim ─────────────────────────────────────────────────────
  select id into v_mv from public.stock_movements
   where product_id = v_prod and kind = 'opening';

  perform public.review_movement(v_mv, false, 'only 200 were actually there');

  -- Rejection reverses; it does not erase. The claim and the correction both stay visible,
  -- which is the entire point of reviewing rather than editing.
  perform pg_temp.check_true('the original claim is still on record',
    exists (select 1 from public.stock_movements where id = v_mv));
  perform pg_temp.check_true('a reversing entry was appended',
    exists (select 1 from public.stock_movements where reverses_id = v_mv));
  perform pg_temp.check_eq('and the stock came back down',
    public.stock_on_hand(v_prod), -24);   -- 240 in, 24 sold, 240 reversed

  v_queue := public.pending_review(v_store);
  perform pg_temp.check_true('the reviewed entry has left the queue',
    not exists (
      select 1 from jsonb_array_elements(v_queue -> 'stock_entries') e
      where (e ->> 'id')::uuid = v_mv));

  -- ─── The trace ───────────────────────────────────────────────────────────────────
  -- "What was there before this sale, and after."
  perform pg_temp.check_eq('before the sale there were 240',
    (select balance_before from public.stock_movements
      where product_id = v_prod and kind = 'sale'), 240);
  perform pg_temp.check_eq('after it, 216',
    (select balance_after from public.stock_movements
      where product_id = v_prod and kind = 'sale'), 216);

  perform pg_temp.check_eq('the opening entry started from nothing',
    (select balance_before from public.stock_movements where id = v_mv), 0);
  perform pg_temp.check_eq('and left 240',
    (select balance_after from public.stock_movements where id = v_mv), 240);

  -- Each step joins to the next, so the history reads as a continuous story.
  perform pg_temp.check_true('every movement carries a before and after',
    not exists (select 1 from public.stock_movements
                where product_id = v_prod
                  and (balance_before is null or balance_after is null)));

  -- ─── A manager adding is vouched for immediately ─────────────────────────────────
  v_res := public.quick_add_product(v_store, 'Coca-Cola PET', 'piece', 'Pack', 12, 4500);
  perform pg_temp.check_true('an owner-added product is confirmed at once',
    (v_res ->> 'confirmed')::boolean);
end;
$$;

select case when passed then 'ok  ' else 'FAIL' end as status, label, got, want
from pg_temp.results order by seq;

rollback;
