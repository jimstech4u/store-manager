-- =====================================================================================
-- 0011 — Customer and product helpers, and finishing onboarding
--
-- Each of these replaces a sequence the client would otherwise have to perform as several
-- round trips. That matters beyond tidiness: a half-completed sequence (an identity created
-- with no store record, a product with no pack) leaves rows that look like corruption later,
-- and on the flaky connections this product is built for, half-completion is the normal case
-- rather than the exception.
-- =====================================================================================

-- ─── Find a customer ────────────────────────────────────────────────────────────────
--
-- Fuzzy on purpose. Whoever is at the counter is often a child sent by the business owner and
-- knows an approximate name and a phone number; an exact-match search would fail exactly when
-- it is needed. Phone is matched on normalised digits so 0803…, +234803… and 234803… all find
-- the same person.
--
-- Only ever returns THIS store's labels (GAP 10): a name another shop recorded is that shop's
-- data, and surfacing it here would leak a competitor's customer list to anyone who can type a
-- phone number.

create or replace function public.find_customers(
  p_store_id uuid,
  p_query    text,
  p_limit    int default 20
)
returns table (
  id            uuid,
  identity_id   uuid,
  display_name  text,
  business_name text,
  phone         text,
  balance       money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sc.id,
         sc.identity_id,
         sc.display_name,
         sc.business_name,
         i.phone,
         public.customer_balance_total(sc.id) as balance
  from public.store_customers sc
  join public.identities i on i.id = sc.identity_id
  where sc.store_id = p_store_id
    and public.is_store_member(p_store_id)
    and (
      coalesce(trim(p_query), '') = ''
      or i.phone like '%' || public.normalize_phone(p_query) || '%'
      or sc.display_name  ilike '%' || p_query || '%'
      or sc.business_name ilike '%' || p_query || '%'
      -- Trigram similarity catches the misspellings an exact ILIKE cannot: "Chidi" typed as
      -- "Chidy" is the same customer, and refusing to find them creates a duplicate record with
      -- a split balance.
      or similarity(sc.display_name, p_query) > 0.3
    )
  order by
    case when i.phone = public.normalize_phone(p_query) then 0 else 1 end,
    similarity(sc.display_name, coalesce(p_query, '')) desc,
    sc.display_name
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

-- ─── Create or find a customer ──────────────────────────────────────────────────────
--
-- Resolves the phone to a cross-tenant identity, then attaches this store's own record to it.
-- One call, one transaction: doing it as resolve-then-insert from the client can leave an
-- identity with no store record if the second call is lost, and the next attempt would then
-- appear to "find" a customer with no name.

create or replace function public.upsert_customer(
  p_store_id      uuid,
  p_phone         text,
  p_display_name  text,
  p_business_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_identity uuid;
  v_id       uuid;
begin
  if not public.has_permission(p_store_id, 'customers.manage') then
    raise exception 'you do not have permission to add customers' using errcode = '42501';
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'a customer needs a name' using errcode = '22023';
  end if;

  v_identity := public.resolve_identity(p_phone);

  insert into public.store_customers (store_id, identity_id, display_name, business_name)
  values (p_store_id, v_identity, trim(p_display_name), nullif(trim(p_business_name), ''))
  on conflict (store_id, identity_id) do update
    -- An existing customer keeps their name unless a new one is actually supplied: re-selecting
    -- someone during a sale must not blank the label this store already recorded for them.
    set display_name  = excluded.display_name,
        business_name = coalesce(excluded.business_name, public.store_customers.business_name)
  returning id into v_id;

  return v_id;
end;
$$;

-- ─── Create a product with its pack ─────────────────────────────────────────────────
--
-- A product and the pack it is bought and sold in arrive together, because a product without a
-- pack cannot express "one crate" — and being unable to say "one crate" is precisely the
-- problem this software exists to solve.

create or replace function public.create_product(
  p_store_id       uuid,
  p_name           text,
  p_base_unit      text,
  p_pack_name      text default null,
  p_pack_qty       qty  default null,
  p_list_price     money_amt default null,
  p_price_per_pack boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product uuid;
  v_pack    uuid;
begin
  if not public.has_permission(p_store_id, 'products.manage') then
    raise exception 'you do not have permission to add products' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'a product needs a name' using errcode = '22023';
  end if;

  insert into public.products (store_id, name, base_unit)
  values (p_store_id, trim(p_name), p_base_unit)
  returning id into v_product;

  if coalesce(trim(p_pack_name), '') <> '' and coalesce(p_pack_qty, 0) > 0 then
    insert into public.product_packs (product_id, name, base_unit_qty)
    values (v_product, trim(p_pack_name), p_pack_qty)
    returning id into v_pack;

    -- Default to showing this product in packs, since that is how a distributor speaks about it.
    update public.products set default_display_pack_id = v_pack where id = v_product;
  end if;

  if p_list_price is not null then
    insert into public.product_prices (product_id, pack_id, price)
    values (v_product, case when p_price_per_pack then v_pack else null end, p_list_price);
  end if;

  return v_product;
end;
$$;

-- ─── Finish onboarding ──────────────────────────────────────────────────────────────
--
-- Stamping `onboarded_at` is what moves a store from "being set up" to "in use", and it opens
-- the first CRODS period for everything backfilled — so the first real day builds on the
-- entered position rather than on zero.

create or replace function public.complete_onboarding(p_store_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  if not public.has_permission(p_store_id, 'backfill.manage') then
    raise exception 'you do not have permission to finish setting up this shop'
      using errcode = '42501';
  end if;

  for r in select id from public.products where store_id = p_store_id and status = 'active' loop
    perform public.ensure_open_period(r.id);
  end loop;

  update public.stores
     set onboarded_at = coalesce(onboarded_at, now())
   where id = p_store_id;
end;
$$;

grant execute on function public.find_customers(uuid, text, int)                          to authenticated;
grant execute on function public.upsert_customer(uuid, text, text, text)                  to authenticated;
grant execute on function public.create_product(uuid, text, text, text, qty, money_amt, boolean) to authenticated;
grant execute on function public.complete_onboarding(uuid)                                to authenticated;
