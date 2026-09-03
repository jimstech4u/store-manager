-- 0084 — Stock is read across every shape a shop uses, not only the ones it sells
--
-- «some stores do not sell pieces or bottles or can, only say crate, pack… malta guiness can pack
--  that has 24 pieces but store sells only in pack. Then some retailers only on pieces, bottles…
--  or some stores in kg, or dirica, or paint»
--
-- `product_selling_units` filters `is_sold`, which is right for a sell screen and wrong for a stock
-- one. A shop that sells Malta only by the pack of 24 has no SOLD shape smaller than a pack — so
-- 250 cans decompose as ten packs and a remainder of ten, and with only packs to say it in, the
-- remainder reads "0.42 packs". A sentence nobody can act on, from a shop that keeps perfectly
-- ordinary stock.
--
-- The fix is not to assume a small shape exists. It is to use every shape the shop has GIVEN A ROLE
-- — bought, sold, counted or deposited — because those are exactly the shapes it has words for.
-- A wholesaler that names only crates gets crates. A retailer that names only bottles gets bottles.
-- A shop weighing in kilogrammes, or measuring in a paint tin or a dirica, gets those, because it
-- said so.
--
-- Consumers are the stock page, the product page and the two counting screens — none of them a
-- selling path. `is_sold` comes back on every row so a screen that needs only sellable shapes can
-- still say so.

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
  on_hand_base   qty,
  is_counted     boolean,
  is_deposit     boolean,
  is_sold        boolean,
  is_bought      boolean
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
     * The one to lead with: what the shop said it COUNTS in, if it has said.
     *
     * Otherwise the largest shape it has a role for — a distributor that names crates and bottles
     * thinks in crates, and "99 crates" is the sentence somebody wants first.
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
    pu.is_deposit,
    pu.is_sold,
    pu.is_bought
  from public.products p
  join public.product_units pu
    on pu.product_id = p.id
   /*
    * ANY ROLE, not just sold. A shape with no role at all is one the shop has stopped using and
    * has not deleted; leaving it out keeps it from reappearing in a stock sentence.
    */
   and (pu.is_sold or pu.is_bought or pu.is_counted or pu.is_deposit)
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
