-- =====================================================================================
-- 0031 — create_product must confirm what an authorised user creates
--
-- Found by seeding a real shop and looking at the public storefront: the shop appeared with
-- five products, and the marketplace showed zero.
--
-- create_product() predates the review workflow (0028/0029) and never set `confirmed_at`. The
-- backfill in 0028 confirmed everything that existed AT THAT MOMENT, so the gap was invisible
-- until something new was created afterwards. Every product made through the setup flow or the
-- seed was therefore stuck pending forever — invisible on the storefront, and sitting in a
-- review queue no one had a reason to open.
--
-- Two lessons, both worth more than the fix:
--
--   · adding a lifecycle column means auditing EVERY writer of that table, not just the new one.
--     quick_add_product was written with confirmation in mind; create_product was simply missed.
--   · a one-time backfill hides exactly this class of omission, because it makes the present
--     look correct while the next insert reintroduces the fault.
--
-- Same rule as quick_add_product: the caller's permission decides. Someone with records.confirm
-- vouches for what they create; anyone else creates something pending.
-- =====================================================================================

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
  v_product   uuid;
  v_pack      uuid;
  v_confirmed boolean := public.has_permission(p_store_id, 'records.confirm');
begin
  if not (v_confirmed or public.has_permission(p_store_id, 'products.manage')) then
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

  if p_list_price is not null then
    insert into public.product_prices (product_id, pack_id, price)
    values (v_product, case when p_price_per_pack then v_pack else null end, p_list_price);
  end if;

  return v_product;
end;
$$;

grant execute on function public.create_product(uuid, text, text, text, qty, money_amt, boolean)
  to authenticated;

-- Confirm what the owner of an already-onboarded shop created before this fix. Scoped to
-- products belonging to a store whose owner clearly intended them to exist — not a blanket
-- update that would also wave through genuinely pending staff entries.
update public.products p
   set confirmed_at = now()
 where p.confirmed_at is null
   and exists (
     select 1 from public.stores s
     where s.id = p.store_id and s.onboarded_at is not null
   )
   -- Only products with no review history: anything a manager has already looked at keeps
   -- whatever state that review left it in.
   and not exists (
     select 1 from public.movement_reviews r
     join public.stock_movements m on m.id = r.movement_id
     where m.product_id = p.id
   );
