-- 0081 — Stock read the way a shop counts it
--
-- «we can say we have 100 crates in stock… stock now becomes 99 crates 8 bottles left»
--
-- `product_selling_units` divides: `on_hand / base_qty`. So 1,196 bottles of Star is "99.6667
-- crates", which the screen rounds to 99.67 — a figure no shop has ever said out loud and nobody
-- can check against a shelf. The eight loose bottles, which are the whole reason the number is not
-- round, disappear into a decimal.
--
-- Two changes, both small:
--
--   · the reader hands back the RAW total in base units as well, so the client can decompose it
--     down the shape tree — 99 crates and 8 bottles — for a tree of any depth. Doing that in SQL
--     would fix it at two levels;
--   · the shape to LEAD with is the one the shop said it counts in (`is_counted`, 0080), falling
--     back to the largest sold shape, which is what this has always guessed.
--
-- Dropped and recreated rather than replaced: the return type changes, Postgres refuses that in
-- `create or replace`, and a second overload makes PostgREST answer 300 to every call.

drop function if exists public.product_selling_units(uuid);

create function public.product_selling_units(p_store_id uuid)
returns table (
  product_id     uuid,
  product_unit_id uuid,
  unit_name      text,
  unit_plural    text,
  base_qty       qty,
  is_default     boolean,
  on_hand_units  qty,
  cost_per_unit  unit_cost,
  avg_cost_per_unit unit_cost,
  price_per_unit money_amt,
  is_returnable  boolean,
  whole_digit    boolean,
  allow_quarter  boolean,
  allow_half     boolean,
  allow_three_quarter boolean,
  /** The shop's whole position for this product, in base units, undivided. */
  on_hand_base   qty,
  is_counted     boolean,
  is_deposit     boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.id,
    pu.id,
    su.name,
    su.plural,
    pu.base_qty,
    /*
     * The one to lead with.
     *
     * What the shop SAID it counts in, if it has said. Otherwise the largest shape it sells, which
     * is the guess this has always made — a distributor that sells crates and bottles thinks in
     * crates, and "99 crates" is the sentence somebody wants first.
     */
    case
      when bool_or(pu.is_counted) over (partition by p.id)
        then pu.is_counted
      else pu.base_qty = max(pu.base_qty) over (partition by p.id)
    end,
    coalesce(onhand.qty, 0) / pu.base_qty,
    public.dearest_live_cost(p.id) * pu.base_qty,
    p.avg_unit_cost * pu.base_qty,
    pu.sell_price,
    pu.is_returnable,
    pu.whole_digit,
    pu.allow_quarter,
    pu.allow_half,
    pu.allow_three_quarter,
    coalesce(onhand.qty, 0),
    pu.is_counted,
    pu.is_deposit
  from public.products p
  join public.product_units pu on pu.product_id = p.id and pu.is_sold
  join public.store_units su on su.id = pu.store_unit_id
  left join lateral (
    select sum(m.qty_delta) as qty
      from public.stock_movements m
     where m.product_id = p.id
  ) onhand on true
  where p.store_id = p_store_id
    and p.status = 'active'
    and public.is_store_member(p_store_id)
  order by p.name, pu.base_qty desc;
$$;

revoke all on function public.product_selling_units(uuid) from public;
grant execute on function public.product_selling_units(uuid) to authenticated;

do $$
declare n int;
begin
  select count(*) into n
    from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'product_selling_units';
  if n <> 1 then
    raise exception 'product_selling_units has % overloads; PostgREST answers 300 to every call', n;
  end if;
end;
$$;
