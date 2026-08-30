-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Stock, cost and price in the unit the shop actually sells in
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- "1,596 pieces on the shelf" is a true statement about a product bought and sold in packs, and it
-- is useless. Nobody in the shop counts pieces, orders pieces, or prices pieces — they have three
-- hundred packs, and the screen should say three hundred packs.
--
-- BASE UNITS STAY THE ARITHMETIC. Adding two deliveries together, taking stock off in a sale,
-- reconciling a count — all of that needs one common unit or it cannot be done at all. What
-- changes is that base units stop being what anybody READS.
--
-- A PRODUCT MAY BE SOLD IN MORE THAN ONE. Cooking oil bought in litres and kilogrammes, sold in
-- litres, is an ordinary thing here — so this returns a row per selling unit rather than one
-- figure, and the screen shows "300 litres" and "3 kg" side by side instead of picking one and
-- being wrong about the other.
--
-- Everything else that counts stock — counts, opening balances, deliveries, damages — reads this,
-- so the whole product speaks one language.

/**
 * Every selling unit of a product, with what is on the shelf and what it is worth, in that unit.
 *
 * `on_hand_units` is what the shopkeeper would say out loud. It is deliberately not rounded: half
 * a crate is a real thing to be holding, and rounding it away is how a count stops reconciling.
 *
 * `cost_per_unit` is the DEAREST stock still held, converted — the figure to price against, for
 * the reason `dearest_live_cost` exists. `avg_cost_per_unit` is beside it because margin and
 * reports are computed on the average, and a screen showing one while the books use the other is
 * how two people end up arguing with different right answers.
 */
create or replace function public.product_selling_units(p_store_id uuid)
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
  allow_three_quarter boolean
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
     * The LARGEST selling unit: a shop that sells packs and pieces thinks in packs, and "300
     * packs" is the sentence somebody wants first. The smaller ones are still listed.
     */
    pu.base_qty = max(pu.base_qty) over (partition by p.id),
    coalesce(onhand.qty, 0) / pu.base_qty,
    public.dearest_live_cost(p.id) * pu.base_qty,
    p.avg_unit_cost * pu.base_qty,
    pu.sell_price,
    pu.is_returnable,
    pu.whole_digit,
    pu.allow_quarter,
    pu.allow_half,
    pu.allow_three_quarter
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

grant execute on function public.product_selling_units(uuid) to authenticated;

/**
 * The same, for one product.
 *
 * The product screen needs it for a single item and asking for the whole catalogue to find one row
 * is the kind of thing that is fine with eight products and painful with eight hundred.
 */
create or replace function public.selling_units_for_product(p_product_id uuid)
returns table (
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
  allow_three_quarter boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    pu.id,
    su.name,
    su.plural,
    pu.base_qty,
    pu.base_qty = max(pu.base_qty) over (),
    coalesce(onhand.qty, 0) / pu.base_qty,
    public.dearest_live_cost(p.id) * pu.base_qty,
    p.avg_unit_cost * pu.base_qty,
    pu.sell_price,
    pu.is_returnable,
    pu.whole_digit,
    pu.allow_quarter,
    pu.allow_half,
    pu.allow_three_quarter
  from public.products p
  join public.product_units pu on pu.product_id = p.id and pu.is_sold
  join public.store_units su on su.id = pu.store_unit_id
  left join lateral (
    select sum(m.qty_delta) as qty
      from public.stock_movements m
     where m.product_id = p.id
  ) onhand on true
  where p.id = p_product_id
    and public.is_store_member(p.store_id)
  order by pu.base_qty desc;
$$;

grant execute on function public.selling_units_for_product(uuid) to authenticated;

/*
 * The existing packs become selling units carrying their price, so today's catalogue reads
 * correctly the moment this lands.
 *
 * Sale units and tier prices move in the next step; this is the part that can be done without
 * changing what anything writes.
 */
update public.product_units pu
   set sell_price = pr.price
  from public.product_prices pr
  join public.product_packs pk on pk.id = pr.pack_id
  join public.store_units su on su.name = pk.name
 where pu.product_id = pr.product_id
   and pu.store_unit_id = su.id
   and pu.sell_price is null;

update public.product_units pu
   set sell_price = pr.price
  from public.product_prices pr
 where pr.product_id = pu.product_id
   and pr.pack_id is null
   and pu.base_qty = 1
   and pu.sell_price is null;

/*
 * A unit nobody sells in should not clutter the shop's screens.
 *
 * The base unit of a product bought and sold only in packs is an internal fact, not something a
 * seller picks — so it stops being a SELLING unit while remaining the arithmetic. Only done where
 * a larger priced unit exists, so nothing is left unsellable.
 */
update public.product_units pu
   set is_sold = false
 where pu.base_qty = 1
   and pu.sell_price is null
   and exists (
     select 1 from public.product_units bigger
      where bigger.product_id = pu.product_id
        and bigger.base_qty > 1
        and bigger.sell_price is not null
   );
