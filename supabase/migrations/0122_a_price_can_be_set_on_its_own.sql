-- 0122 — A price can be set on its own
--
-- The only way to change what a shape sells for was `save_product_units`, which replaces the whole
-- set: every shape, every tick, every relationship, in one call. Changing one price meant sending
-- the entire tree back and trusting it to arrive intact — and 0080 is the migration where a copy of
-- that function nearly erased every relationship in the shop by reading one key under a name the
-- client had never sent.
--
-- Setting a price is not that. It touches one row and one column, and the shape's meaning does not
-- move.
--
-- WHAT IT DELIBERATELY DOES NOT DO is refuse a price below cost. A shop sells below cost on
-- purpose — clearing short-dated stock, matching a competitor, a favour to a good customer — and a
-- system that refuses is a system somebody works around. `price_check` already exists to tell the
-- seller what the margin is; the decision stays theirs.

create or replace function public.set_shape_price(
  p_product_unit_id uuid,
  p_price           money_amt default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store  uuid;
  v_is_sold boolean;
begin
  select p.store_id, pu.is_sold
    into v_store, v_is_sold
    from public.product_units pu
    join public.products p on p.id = pu.product_id
   where pu.id = p_product_unit_id;

  if v_store is null then
    raise exception 'that shape does not exist' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to change prices' using errcode = '42501';
  end if;

  /*
   * A PRICE ON A SHAPE NOBODY BUYS IN IS A PRICE NOBODY WILL SEE.
   *
   * The till offers the shapes ticked "customers buy this". Setting a price on any other is a
   * figure that can never appear on a receipt, which is the same class of thing as a field that
   * cannot change anything — it looks answered and is not.
   */
  if not v_is_sold then
    raise exception 'customers do not buy this shape — tick it on the item first'
      using errcode = '23514';
  end if;

  if p_price is not null and p_price < 0 then
    raise exception 'a price cannot be negative' using errcode = '22023';
  end if;

  update public.product_units
     set sell_price = p_price
   where id = p_product_unit_id;
end;
$fn$;

revoke all on function public.set_shape_price(uuid, money_amt) from public;
grant execute on function public.set_shape_price(uuid, money_amt) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'set_shape_price';
  if n <> 1 then
    raise exception 'set_shape_price has % overloads', n;
  end if;
end;
$check$;
