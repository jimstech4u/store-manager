-- =====================================================================================
-- 0029 — A permission for CONFIRMING, distinct from creating
--
-- Caught by the review tests: a customer added by staff came back already confirmed.
--
-- The cause was reusing `customers.manage` to mean "may vouch for a record". Staff legitimately
-- hold that permission — they must, or they could not add a customer to sell on credit — so the
-- auto-confirm check passed for them and the review queue silently did nothing. The workflow
-- looked correct in the code and was a no-op in practice.
--
-- The real lesson: "may create X" and "may vouch for X" are different capabilities, and
-- expressing the second with the first collapses them. A permission named after what it actually
-- authorises cannot make that mistake.
--
-- `records.confirm` goes to owner and manager only. Staff keep the ability to create; what they
-- lose is the ability to sign off their own work, which is the entire point of the review step.
-- =====================================================================================

insert into public.permissions (code, description)
values ('records.confirm', 'Confirm products, customers and stock entered by others')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code)
values ('owner', 'records.confirm'), ('manager', 'records.confirm')
on conflict do nothing;

-- ─── Auto-confirm now asks the right question ───────────────────────────────────────

create or replace function public.quick_add_product(
  p_store_id   uuid,
  p_name       text,
  p_base_unit  text default 'piece',
  p_pack_name  text default null,
  p_pack_qty   qty  default null,
  p_price      money_amt default null,
  p_open_qty   qty  default null,
  p_unit_cost  unit_cost default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product   uuid;
  v_pack      uuid;
  -- "May I vouch for this?", not "may I create it?".
  v_confirmed boolean := public.has_permission(p_store_id, 'records.confirm');
begin
  if not (v_confirmed
          or public.has_permission(p_store_id, 'products.manage')
          or public.has_permission(p_store_id, 'sales.record')) then
    raise exception 'you do not have permission to add products' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'a product needs a name' using errcode = '22023';
  end if;

  insert into public.products (store_id, name, base_unit, confirmed_at, confirmed_by)
  values (p_store_id, trim(p_name), p_base_unit,
          case when v_confirmed then now() end,
          case when v_confirmed then auth.uid() end)
  returning id into v_product;

  if coalesce(trim(p_pack_name), '') <> '' and coalesce(p_pack_qty, 0) > 0 then
    insert into public.product_packs (product_id, name, base_unit_qty)
    values (v_product, trim(p_pack_name), p_pack_qty)
    returning id into v_pack;
    update public.products set default_display_pack_id = v_pack where id = v_product;
  end if;

  if p_price is not null then
    insert into public.product_prices (product_id, pack_id, price)
    values (v_product, v_pack, p_price);
  end if;

  if p_open_qty is not null and p_open_qty > 0 then
    perform public.initialise_stock(p_store_id, v_product, p_open_qty, p_unit_cost);
  end if;

  return jsonb_build_object('product_id', v_product, 'pack_id', v_pack, 'confirmed', v_confirmed);
end;
$$;

create or replace function public.quick_add_customer(
  p_store_id      uuid,
  p_phone         text,
  p_display_name  text,
  p_business_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id        uuid;
  v_confirmed boolean := public.has_permission(p_store_id, 'records.confirm');
begin
  if not (v_confirmed
          or public.has_permission(p_store_id, 'customers.manage')
          or public.has_permission(p_store_id, 'sales.record')) then
    raise exception 'you do not have permission to add customers' using errcode = '42501';
  end if;

  v_id := public.upsert_customer(p_store_id, p_phone, p_display_name, p_business_name);

  if v_confirmed then
    update public.store_customers
       set confirmed_at = coalesce(confirmed_at, now()),
           confirmed_by = coalesce(confirmed_by, auth.uid())
     where id = v_id;
  else
    -- upsert_customer may have touched an existing row; make sure a staff-created one is left
    -- pending rather than inheriting a confirmation it never received.
    update public.store_customers
       set confirmed_at = null, confirmed_by = null
     where id = v_id and created_at > now() - interval '5 seconds' and confirmed_by is null;
  end if;

  return jsonb_build_object('customer_id', v_id, 'confirmed', v_confirmed);
end;
$$;

-- ─── Confirming requires the confirm permission ─────────────────────────────────────

create or replace function public.confirm_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_store uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if not public.has_permission(v_store, 'records.confirm') then
    raise exception 'only a manager or owner can confirm a product' using errcode = '42501';
  end if;

  update public.products
     set confirmed_at = now(), confirmed_by = auth.uid(), amend_reason = 'confirmed'
   where id = p_product_id and confirmed_at is null;
end;
$$;

create or replace function public.confirm_customer(p_customer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_store uuid;
begin
  select store_id into v_store from public.store_customers where id = p_customer_id;
  if not public.has_permission(v_store, 'records.confirm') then
    raise exception 'only a manager or owner can confirm a customer' using errcode = '42501';
  end if;

  update public.store_customers
     set confirmed_at = now(), confirmed_by = auth.uid(), amend_reason = 'confirmed'
   where id = p_customer_id and confirmed_at is null;
end;
$$;

grant execute on function public.quick_add_product(uuid, text, text, text, qty, money_amt, qty, unit_cost) to authenticated;
grant execute on function public.quick_add_customer(uuid, text, text, text) to authenticated;
grant execute on function public.confirm_product(uuid)  to authenticated;
grant execute on function public.confirm_customer(uuid) to authenticated;
