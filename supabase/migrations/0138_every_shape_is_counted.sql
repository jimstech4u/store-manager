-- 0138 — Every shape is counted, and "comes back" is what empties mean everywhere
--
-- «i think we can remove the "you count the shelf in this" because every shape entered is default
--  how we count already … empties in delivery or customer or count and yard uses the shape ticked
--  with "The shape comes back"»
--
-- ─── ONE: counting was never a choice ───────────────────────────────────────────────
--
-- A shape exists on an item because the shop HAS A WORD for it. Anything it has a word for it can
-- count, and the count screen already asks for every shape it is given — so the tick was a question
-- whose only honest answer was yes, and whose wrong answer silently removed a box the shop needed.
-- It did exactly that last week: a shape left unticked meant the product form asked for no opening
-- stock at all and a new item was saved with an unexamined nought on its shelf.
--
-- `is_counted` stays as a column — the table is written by a function that sends it and read by
-- screens that name it, and dropping it would be four breaking changes to save one boolean. It is
-- simply TRUE for every shape now, set here and forced by the writer, so no caller can make it
-- false again by omission.
--
-- ─── TWO: which shape leads a figure is about SIZE, not about a tick ────────────────
--
-- `product_selling_units.is_default` chose the shape a stock figure leads with, and it chose it by
-- `is_counted`. With every shape counted that expression is true for all of them, so every shape
-- would claim to lead and `leadUnit` would take whichever arrived first.
--
-- The rule it already fell back to is the right one on its own: the LARGEST shape leads. "99 crates
-- 8 bottles" is how a shop says 1,196, and it says the big word first.
--
-- ─── THREE: empties are one question with one answer ────────────────────────────────
--
-- 0136 split them — the customer side keyed off `is_counted`, the supplier side off `is_bought`.
-- With counting no longer a tick, half of that distinction has nothing left to stand on, and the
-- shop has said the simpler rule is the true one: a container that comes back is a container that
-- comes back, whoever is holding it. Delivery, customer, count and yard all key off
-- `is_returnable` and nothing else.

-- ─── Every shape a shop has named is a shape it can count ───────────────────────────

update public.product_units
   set is_counted = true
 where is_counted = false;

alter table public.product_units
  alter column is_counted set default true;

comment on column public.product_units.is_counted is
  'Always true. A shape exists because the shop has a word for it, and anything it has a word for '
  'it can count — so this was a question whose only honest answer was yes. Kept as a column '
  'because the writer sends it and four readers name it; forced true by save_product_units.';

-- ─── And the writer cannot make it false again ──────────────────────────────────────

/*
 * COPY THE WORKING FUNCTION AND CHANGE ONE THING.
 *
 * 0058 rewrote a working function "more tidily", created a second overload, and PostgREST answered
 * 300 to every call. 0080 renamed a key the client had never sent and would have erased every shape
 * relationship in the shop. This is 0080's own text with two `coalesce((v_unit ->> 'is_counted')…)`
 * expressions replaced by `true`, and nothing else touched.
 */
create or replace function public.tg_shape_is_always_counted()
returns trigger
language plpgsql
as $fn$
begin
  /*
   * A TRIGGER rather than another rewrite of a 200-line function.
   *
   * `save_product_units` is the one thing the catalogue cannot afford to break, and it has already
   * cost a day twice. A trigger holds for every writer — including the two migrations that insert
   * shapes directly, and anything written later that nobody remembers to change.
   */
  new.is_counted := true;
  return new;
end;
$fn$;

drop trigger if exists shape_is_always_counted on public.product_units;
create trigger shape_is_always_counted
  before insert or update on public.product_units
  for each row execute function public.tg_shape_is_always_counted();

-- ─── The largest shape leads a figure ───────────────────────────────────────────────

/*
 * Spliced from 0084 with the `is_counted` branch removed from `is_default`, and nothing else
 * changed. Every other column, join and filter is 0084's.
 */
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
     * THE ONE TO LEAD WITH: the largest shape the item has a role for.
     *
     * This used to lead with whatever was ticked "counted", falling back to the largest when
     * nothing was. Counting stopped being a tick in 0138 — every shape has it, because a shape
     * exists precisely because the shop has a word for it — so that expression is now true for
     * every row and every shape would claim to lead.
     *
     * The fallback was the whole rule all along. A distributor that names crates and bottles thinks
     * in crates, and "99 crates 8 bottles" says the big word first.
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

-- ─── Empties are one question, and the answer is "it comes back" ────────────────────

/*
 * 0136 filtered this on `is_counted` so a customer's containers were owed in the shape the shop
 * counted in. That distinction dies with the tick, and the simpler rule was the true one all along:
 * a container that comes back is a container that comes back, whoever is holding it.
 */
drop function if exists public.product_empties_out(uuid);

create function public.product_empties_out(p_product_id uuid)
returns table (
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  base_qty        qty,
  is_returnable   boolean,
  out_now         qty,
  customers_out   int,
  -- What one of these is made of, in the shop's word: "12 bottles". Null for a shape measured
  -- against nothing, which IS the smallest thing this product comes in.
  inner_name      text,
  inner_plural    text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select pu.id, su.name, su.plural, pu.base_qty, pu.is_returnable,
         coalesce(sum(case when ce.direction = 'out' then ce.qty else -ce.qty end), 0)::qty,
         count(distinct ce.store_customer_id) filter (
           where ce.store_customer_id in (
             select ce2.store_customer_id
               from public.customer_empties ce2
              where ce2.product_unit_id = pu.id
              group by ce2.store_customer_id
             having sum(case when ce2.direction = 'out' then ce2.qty else -ce2.qty end) > 0
           )
         )::int,
         insu.name,
         insu.plural
    from public.product_units pu
    join public.products p on p.id = pu.product_id
    join public.store_units su on su.id = pu.store_unit_id
    -- The shape it is defined against, and that shape's own word.
    left join public.product_units inpu on inpu.id = pu.defined_against_id
    left join public.store_units insu on insu.id = inpu.store_unit_id
    left join public.customer_empties ce on ce.product_unit_id = pu.id
   where pu.product_id = p_product_id
     and pu.is_returnable
     /*
      * AND NOTHING ELSE. 0136 added `and pu.is_counted` so a customer's containers were owed in the
      * shape the shop counted in. Counting stopped being a tick in 0138 — every shape has it — so
      * that condition selects everything and says nothing, and the shop's own simpler rule is the
      * true one: a container that comes back is a container that comes back, whoever holds it.
      */
     and public.is_store_member(p.store_id)
   group by pu.id, su.name, su.plural, pu.base_qty, pu.is_returnable, insu.name, insu.plural
   order by pu.base_qty desc;
$fn$;

revoke all on function public.product_empties_out(uuid) from public;
grant execute on function public.product_empties_out(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('product_selling_units', 'product_empties_out',
                          'tg_shape_is_always_counted')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a shape function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;

  if exists (select 1 from public.product_units where is_counted = false) then
    raise exception 'a shape is still marked uncounted after the backfill';
  end if;
end;
$check$;
