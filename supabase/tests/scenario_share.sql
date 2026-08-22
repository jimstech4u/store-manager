-- =====================================================================================
-- Verification: shareable receipts
--
-- This is the one place unauthenticated access to a business record exists, so the checks are
-- weighted towards what it must NOT do: reveal costs, survive revocation, leak whether a token
-- ever existed, or expose anything beyond the single record it was issued for.
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
  v_prod   uuid;
  v_pack   uuid;
  v_cust   uuid;
  v_sale   uuid;
  v_token  text;
  v_token2 text;
  v_doc    jsonb;
begin
  insert into auth.users (id, instance_id, email, encrypted_password, created_at, updated_at, aud, role)
  values (v_uid, '00000000-0000-0000-0000-000000000000', 'share@test.local', 'x', now(), now(),
          'authenticated', 'authenticated');
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  perform set_config('role', 'authenticated', true);

  v_store := public.create_store('Share Test', 'share-test');
  v_prod  := public.create_product(v_store, 'Coca-Cola PET 60cl', 'piece', 'Pack', 12, 3700, true);
  select id into v_pack from public.product_packs where product_id = v_prod;
  perform public.backfill_stock(v_store, v_prod, 1200, 283.333334, current_date, true);

  v_cust := public.upsert_customer(v_store, '08031234567', 'Mama Blessing');

  perform public.ensure_store_settings(v_store);
  update public.store_settings
     set printer_width_mm = 57.5, receipt_footer = 'Thank you'
   where store_id = v_store;

  v_sale := public.settle_sale(
    v_store,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_prod, 'qty', 2, 'pack_id', v_pack, 'unit_price', 3700, 'line_total', 7400)),
    jsonb_build_array(jsonb_build_object('amount', 3000, 'method', 'cash')),
    v_cust, 500, 'Delivery', 'Ring on arrival'
  );

  -- ─── Issuing ─────────────────────────────────────────────────────────────────────
  v_token := public.create_share_link(v_store, 'receipt', v_sale);
  perform pg_temp.check_true('a share token is issued', v_token is not null and length(v_token) >= 20);

  -- Asking twice must not mint a second live link: revoking one while another still worked
  -- would make "revoke" a promise the system does not keep.
  v_token2 := public.create_share_link(v_store, 'receipt', v_sale);
  perform pg_temp.check_true('asking again reuses the same link', v_token = v_token2);

  -- ─── Reading it as the public ────────────────────────────────────────────────────
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', null, true);

  v_doc := public.read_shared_receipt(v_token);
  perform pg_temp.check_true('an anonymous visitor can open the receipt', v_doc is not null);
  perform pg_temp.check_eq('the total is shown', (v_doc -> 'sale' ->> 'total')::numeric, 7900);
  perform pg_temp.check_eq('the lines are shown', jsonb_array_length(v_doc -> 'lines'), 1);
  perform pg_temp.check_eq('the payment is shown', jsonb_array_length(v_doc -> 'payments'), 1);
  perform pg_temp.check_true('the shop name is shown',
    (v_doc -> 'shop' ->> 'name') = 'Share Test');
  perform pg_temp.check_eq('the printer width travels with it',
    (v_doc -> 'shop' ->> 'printer_width_mm')::numeric, 57.5);
  perform pg_temp.check_true('the customer name is shown',
    (v_doc -> 'customer' ->> 'name') = 'Mama Blessing');

  -- What must NOT be there. A receipt handed to a customer is not a window into the shop's
  -- buying prices or the customer's whole account.
  perform pg_temp.check_true('cost is NOT disclosed',
    not (v_doc -> 'lines' -> 0 ? 'unit_cost_at_sale'));
  perform pg_temp.check_true('the customer balance is NOT disclosed',
    not (v_doc -> 'customer' ? 'balance'));
  perform pg_temp.check_true('the customer phone is NOT disclosed',
    not (v_doc -> 'customer' ? 'phone'));

  -- A wrong token gives nothing, and gives it the same way an expired one does.
  perform pg_temp.check_true('an unknown token returns nothing',
    public.read_shared_receipt('not-a-real-token') is null);

  -- The public may not reach the underlying tables, only the one function.
  begin
    perform 1 from public.sales where id = v_sale;
    perform pg_temp.check_true('anon cannot read sales directly',
      not exists (select 1 from public.sales where id = v_sale));
  exception when others then
    perform pg_temp.check_true('anon cannot read sales directly', true);
  end;

  begin
    perform 1 from public.share_links where token = v_token;
    perform pg_temp.check_true('anon cannot list share links',
      not exists (select 1 from public.share_links where token = v_token));
  exception when others then
    perform pg_temp.check_true('anon cannot list share links', true);
  end;

  -- ─── Revoking ────────────────────────────────────────────────────────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  perform public.revoke_share_link(v_token);

  perform set_config('role', 'anon', true);
  perform pg_temp.check_true('a revoked link stops working',
    public.read_shared_receipt(v_token) is null);

  -- After revoking, a fresh link must be a DIFFERENT token — otherwise revocation could be
  -- undone by anyone who kept the old URL.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid::text)::text, true);
  v_token2 := public.create_share_link(v_store, 'receipt', v_sale);
  perform pg_temp.check_true('re-sharing after revoking issues a new token', v_token2 <> v_token);

  perform set_config('role', 'anon', true);
  perform pg_temp.check_true('the old token stays dead',
    public.read_shared_receipt(v_token) is null);
  perform pg_temp.check_true('the new token works',
    public.read_shared_receipt(v_token2) is not null);
end;
$$;

select case when passed then 'ok  ' else 'FAIL' end as status, label, got, want
from pg_temp.results order by seq;

rollback;
