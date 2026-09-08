-- 0102 — What is owed back is owed in the shape it was sold in
--
-- «when store sells in crate and we are saying 48 bottles, that is not professional … we sell 4
--  Goldberg crates, we know we are expected to get 4 crates — but reality could have us return 3
--  crates and 8 bottles»
--
-- Two different things were being confused, and the result was a double obligation.
--
-- `returnables_for_sale` returns a row for every pool the product belongs to. A Goldberg that names
-- a crate pool AND a bottle pool therefore owes BOTH on one sale: forty-eight bottles and four
-- crates, for four crates sold. The customer took four things and the ledger says they have
-- fifty-two.
--
-- What a shop means is simpler. Four crates went out, so four crates are owed — in the shape they
-- were sold in. The bottle pool is not a second debt; it is the UNIT THE RETURN CAN BE COUNTED IN,
-- because three crates and eight loose bottles is what actually comes back once something is broken
-- or lost, and a shop needs to be able to say that.
--
-- So the pool learns which shape it belongs to, and the sale owes against the shape it sold.

alter table public.product_returnables
  add column if not exists product_unit_id uuid
    references public.product_units (id) on delete set null;

comment on column public.product_returnables.product_unit_id is
  'Which shape this pool is the container for. A sale owes into the pool of the shape it SOLD — four '
  'crates owe four crates — and the other pools on the product exist so a return can be counted in '
  'them, through the tree: twelve bottles settle one crate.';

/*
 * What the existing rows meant.
 *
 * Pools have been named "<maker> <shape>" since the shapes carried them, so the shape is recoverable
 * by name. Matched case-insensitively on the ending, because "Nigerian Breweries (NBL) crate" ends
 * in the shape and begins with whatever the shop calls the maker.
 *
 * A row that matches nothing keeps a null shape and goes on behaving exactly as it does today —
 * which is what the reader falls back to.
 */
update public.product_returnables pr
   set product_unit_id = (
     select pu.id
       from public.product_units pu
       join public.store_units su on su.id = pu.store_unit_id
      where pu.product_id = pr.product_id
        and lower(btrim((select ec.name from public.empties_categories ec
                          where ec.id = pr.empties_category_id)))
            like '%' || lower(btrim(su.name))
      limit 1
   )
 where pr.product_unit_id is null;

-- ─── And the sale owes against the shape it sold ────────────────────────────────────

drop function if exists public.returnables_for_sale(uuid, qty, qty);

create function public.returnables_for_sale(
  p_product_id   uuid,
  p_base_qty     qty,
  p_containers   qty default 0,
  p_sale_unit_id uuid default null
)
returns table (
  empties_category_id uuid,
  category_name       text,
  kind                text,
  qty_units           qty,
  deposit_per_unit    money_amt,
  deposit_total       money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with owed as (
    select ec.id,
           ec.name,
           ec.kind,
           case
             /*
              * SOLD IN THIS SHAPE: owed one for one, in this shape.
              *
              * Four crates out is four crates owed. `p_containers` is what the till says actually
              * left — the same figure unless the customer brought their own.
              */
             when p_sale_unit_id is not null and pr.product_unit_id = p_sale_unit_id
               then coalesce(p_containers, 0)

             /*
              * ANOTHER SHAPE ON THE SAME PRODUCT: owed nothing.
              *
              * The bottle pool on a crate sale is not a second debt. It exists so a RETURN can be
              * counted in bottles — three crates and eight bottles — and settle against the crates
              * that are owed, through the tree.
              */
             when p_sale_unit_id is not null and pr.product_unit_id is not null
               then 0

             /*
              * AND WHERE NOTHING SAYS WHICH SHAPE — an older row, or a caller that does not know —
              * exactly what this function did before: content counted from what was sold, a
              * container counted from what physically left.
              */
             when ec.kind = 'content'
               then p_base_qty * coalesce(pr.qty_per_base_unit, 0)
             else coalesce(p_containers, 0)
           end as qty_units,
           ec.deposit
      from public.product_returnables pr
      join public.empties_categories ec on ec.id = pr.empties_category_id
      join public.products p on p.id = pr.product_id
     where pr.product_id = p_product_id
       and public.is_store_member(p.store_id)
  )
  select owed.id, owed.name, owed.kind, owed.qty_units, owed.deposit,
         (owed.qty_units * owed.deposit)::money_amt
    from owed
   where owed.qty_units > 0;
$$;

revoke all on function public.returnables_for_sale(uuid, qty, qty, uuid) from public;
grant execute on function public.returnables_for_sale(uuid, qty, qty, uuid) to authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'returnables_for_sale';
  if n <> 1 then
    raise exception 'returnables_for_sale has % overloads; every caller would answer 300', n;
  end if;
end;
$check$;
