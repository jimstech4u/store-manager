-- 0104 — The till reads the shape's own ticks
--
-- Two flags on the shape decide what the till does with it, and neither was being read properly.
--
-- `is_returnable` was not read from the shape at all. `product_sale_units_for` computed it as
-- "does this PRODUCT have any returnable pool", so on a Goldberg every sold shape came back true —
-- the crate, which does come back, and anything else the shop sells it in, which may not. A shape
-- says whether it comes back; that is what the tick is for.
--
-- `is_deposit` was not read anywhere. It has been on the shape since 0080, it is one of four ticks
-- the form asks for, and nothing in the app has ever consulted it: a question that cannot change
-- anything, which is worse than a missing one because it looks answered.
--
-- Both come from the shape now, so the till can ask the two separate questions a shop is actually
-- answering: does this come back, and do you hold money against it.

drop function if exists public.product_sale_units_for(uuid);

create function public.product_sale_units_for(p_product_id uuid)
returns table (
  id                  uuid,
  name                text,
  base_qty            qty,
  price               money_amt,
  whole_digit         boolean,
  allow_quarter       boolean,
  allow_half          boolean,
  allow_three_quarter boolean,
  is_returnable       boolean,
  is_deposit          boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select su.id, su.name, su.base_qty, su.price,
         su.whole_digit, su.allow_quarter, su.allow_half, su.allow_three_quarter,
         /*
          * THE SHAPE'S OWN ANSWER, not the product's.
          *
          * This was `exists (select 1 from product_returnables where product_id = ...)`, which is
          * true of every shape on a product that has any pool at all. A shop selling Goldberg by
          * the crate and by the bottle got "comes back" on both whether or not it had said so.
          */
         coalesce(pu.is_returnable, false),
         /*
          * And whether money is held against it.
          *
          * On the shape since 0080 and read by nothing until now. A crate and a bottle can each
          * hold a deposit, separately — which is the whole reason a shop ticks them separately.
          */
         coalesce(pu.is_deposit, false)
    from public.product_sale_units su
    join public.products p on p.id = su.product_id
    left join public.product_units pu on pu.id = su.id
   where su.product_id = p_product_id
     and public.is_store_member(p.store_id)
   order by su.sort_order, su.base_qty desc;
$$;

revoke all on function public.product_sale_units_for(uuid) from public;
grant execute on function public.product_sale_units_for(uuid) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'product_sale_units_for';
  if n <> 1 then
    raise exception 'product_sale_units_for has % overloads', n;
  end if;
end;
$check$;
