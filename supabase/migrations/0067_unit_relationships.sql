-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Every unit a product is bought in must reach a unit it is sold in
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Cooking oil is bought in litres AND in kilogrammes, and sold only in litres. Nothing today makes
-- anybody say what a kilogramme IS. Two things then go wrong, and they are opposite ways of being
-- wrong about the same missing sentence:
--
--   THE STOCK STRANDS. Three kilogrammes arrive, nothing is ever sold in kilogrammes, and those
--   three sit on the screen forever — a number that only goes up, that no sale can move, and that
--   every stock count then has to be argued around.
--
--   OR THE STOCK DOUBLES. `product_selling_units` divides ONE pool of base units by each unit's
--   size, so the very same oil reads as "300 litres" on one line and "12.5 kg" on the next. Add
--   them up — and somebody will — and the shop believes it has twice what it has.
--
-- Both stop the moment the shop says the sentence: ONE KILOGRAMME IS TWENTY-FOUR LITRES. Then a
-- kilogramme is not a separate pile, it is a bigger scoop into the same drum. Three kilogrammes
-- arriving is seventy-two litres arriving; it costs what seventy-two litres cost, it sells as
-- litres, and it leaves when they are sold.
--
-- SO THE RELATIONSHIP IS NOT OPTIONAL. A product may not be bought in a unit that cannot be
-- reached from a unit it is sold in. The shop either sells in that unit too, or states what one is
-- worth in a unit it does sell in. There is no third option and no way to skip the question,
-- because skipping it is exactly how stock quietly stops meaning anything.
--
-- WHY THE SENTENCE IS STORED, not just the arithmetic. `base_qty` already held the conversion, but
-- as a number with no memory of where it came from: 24 in a column, with nothing to say whether
-- anybody ever decided it or whether it defaulted. Storing "one KG is 24 LITRE" means the form can
-- read the shop's own words back to them, a correction to that figure carries to everything
-- derived from it, and a unit nobody ever defined is visibly a unit nobody ever defined.

-- ─── The sentence itself ────────────────────────────────────────────────────────────

alter table public.product_units
  -- The unit this one was stated in terms of. Null on the base unit, which is the one thing that
  -- cannot be defined against anything else — it is what the others are measured in.
  add column if not exists defined_against_id uuid references public.product_units (id) on delete restrict,
  -- How many of THAT unit one of THIS unit is. The 24 in "one kilogramme is 24 litres".
  add column if not exists defined_qty qty check (defined_qty > 0);

/*
 * Both halves of the sentence, or neither. "Defined against litres" with no number is not a
 * relationship, it is a half-finished thought, and it would derive a base_qty of null.
 */
alter table public.product_units
  drop constraint if exists product_unit_definition_whole;
alter table public.product_units
  add constraint product_unit_definition_whole
  check ((defined_against_id is null) = (defined_qty is null));

-- A unit defined against itself is a sentence that says nothing.
alter table public.product_units
  drop constraint if exists product_unit_not_self_defined;
alter table public.product_units
  add constraint product_unit_not_self_defined
  check (defined_against_id is distinct from id);

/*
 * What the catalogue already meant, written down as a sentence.
 *
 * Every unit that is not the base unit was already carrying its conversion in `base_qty` — a pack
 * of twelve had 12. That is precisely "one PACK is 12 PIECES", so it is recorded as such, against
 * the product's base unit. Nothing changes value; what changes is that the figure now has a stated
 * origin instead of being a bare number.
 */
update public.product_units pu
   set defined_against_id = base.id,
       defined_qty        = pu.base_qty
  from public.product_units base
 where base.product_id = pu.product_id
   and base.base_qty = 1
   and pu.base_qty <> 1
   and pu.defined_against_id is null;

-- ─── The arithmetic follows the sentence, never the other way round ──────────────────

/**
 * `base_qty` is derived, not entered.
 *
 * One kilogramme stated as 24 litres, where a litre is 1 base unit, is 24 base units. Nobody in
 * the shop should ever be typing a base-unit figure — they know what a kilogramme is worth in
 * litres, and that is the only question they can answer reliably.
 */
create or replace function public.tg_product_unit_base_qty()
returns trigger
language plpgsql
as $fn$
declare
  v_ref_base qty;
  v_cycle    boolean;
begin
  if new.defined_against_id is null then
    -- The base unit, or a unit the shop stated in base units directly. Left as given.
    return new;
  end if;

  /*
   * A chain that comes back to where it started.
   *
   * "A kilogramme is 24 litres" and "a litre is a twenty-fourth of a kilogramme" are the same fact
   * said twice, and storing both means neither can be computed — each waits on the other. Refused
   * at the point somebody tries, where it can still be explained.
   */
  with recursive up as (
    select pu.id, pu.defined_against_id, 1 as depth
      from public.product_units pu
     where pu.id = new.defined_against_id
    union all
    select pu.id, pu.defined_against_id, up.depth + 1
      from public.product_units pu
      join up on pu.id = up.defined_against_id
     where up.depth < 20
  )
  select exists (select 1 from up where up.id = new.id) into v_cycle;

  if v_cycle then
    raise exception 'These units define each other in a circle. Say what one of them is worth on its own first.'
      using errcode = 'check_violation';
  end if;

  select pu.base_qty into v_ref_base
    from public.product_units pu
   where pu.id = new.defined_against_id
     and pu.product_id = new.product_id;

  if v_ref_base is null then
    raise exception 'That unit belongs to a different product.'
      using errcode = 'foreign_key_violation';
  end if;

  new.base_qty := new.defined_qty * v_ref_base;
  return new;
end;
$fn$;

drop trigger if exists product_unit_base_qty on public.product_units;
create trigger product_unit_base_qty
  before insert or update of defined_against_id, defined_qty on public.product_units
  for each row execute function public.tg_product_unit_base_qty();

/**
 * A correction carries.
 *
 * A shop that decides a kilogramme is really 25 litres, not 24, has corrected one sentence — and
 * every unit stated in kilogrammes has just changed too. Leaving those behind would mean the
 * catalogue quietly disagreeing with itself, which is worse than the original mistake because
 * nothing points at it.
 *
 * The chain cannot loop — the trigger above refuses circles — so this recursion ends.
 */
create or replace function public.tg_product_unit_cascade()
returns trigger
language plpgsql
as $fn$
begin
  update public.product_units
     set defined_qty = defined_qty   -- fires the derivation trigger with the new reference figure
   where defined_against_id = new.id;
  return null;
end;
$fn$;

drop trigger if exists product_unit_cascade on public.product_units;
create trigger product_unit_cascade
  after update of base_qty on public.product_units
  for each row when (old.base_qty is distinct from new.base_qty)
  execute function public.tg_product_unit_cascade();

-- ─── Which units have not been answered for ─────────────────────────────────────────

/**
 * The bought-in units that cannot be reached from anything this product is sold in.
 *
 * A unit is answered for when the shop sells in it, or when it was stated in terms of a unit that
 * is itself answered for — kilogrammes stated in litres, litres sold. Anything left over is stock
 * that can arrive and never leave.
 *
 * THE CHECK CARRIES NO MEMBERSHIP TEST, and that is the whole point of it being separate from the
 * reader below. Written the other way round first, and it failed OPEN: the guard asked for the
 * gaps, membership filtering removed every row before it could see one, and a product with a
 * stranded unit saved cleanly while reporting nothing wrong. A guard that goes quiet exactly when
 * it cannot see is worse than no guard, because the screen then says everything is fine.
 *
 * So this one answers the question honestly for any caller, and is reachable only from the two
 * SECURITY DEFINER functions below — never granted to a browser.
 */
create or replace function public.unit_gaps_unchecked(p_product_id uuid)
returns table (
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with recursive answered as (
    select pu.id
      from public.product_units pu
     where pu.product_id = p_product_id
       and pu.is_sold
    union
    select pu.id
      from public.product_units pu
      join answered a on pu.defined_against_id = a.id
     where pu.product_id = p_product_id
  )
  select pu.id, su.name, su.plural
    from public.product_units pu
    join public.store_units su on su.id = pu.store_unit_id
   where pu.product_id = p_product_id
     and pu.is_bought
     and pu.id not in (select id from answered)
   order by su.name;
$fn$;

revoke all on function public.unit_gaps_unchecked(uuid) from public;

/**
 * The same question, asked by a screen.
 *
 * Membership belongs here and only here: a browser may not learn how another shop's catalogue is
 * put together. Empty for a non-member is the right answer to a READ — it is only as the answer to
 * "may this save?" that emptiness lies.
 */
create or replace function public.product_unit_gaps(p_product_id uuid)
returns table (
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select g.*
    from public.products p
    cross join lateral public.unit_gaps_unchecked(p.id) g
   where p.id = p_product_id
     and public.is_store_member(p.store_id);
$fn$;

grant execute on function public.product_unit_gaps(uuid) to authenticated;

/**
 * The same question asked of a whole shop.
 *
 * A gap created before this rule existed, or by an import, would otherwise only be found by
 * opening every product one at a time. The stock screen shows these so they get fixed rather than
 * discovered during a count.
 */
create or replace function public.products_with_unit_gaps(p_store_id uuid)
returns table (
  product_id   uuid,
  product_name text,
  gap_units    text[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id, p.name, array_agg(g.unit_name order by g.unit_name)
    from public.products p
    cross join lateral public.unit_gaps_unchecked(p.id) g
   where p.store_id = p_store_id
     and p.status = 'active'
     and public.is_store_member(p_store_id)
   group by p.id, p.name
   order by p.name;
$fn$;

grant execute on function public.products_with_unit_gaps(uuid) to authenticated;

/**
 * Refuse a product whose units do not add up.
 *
 * Called at the end of saving a product, inside the same transaction, so a half-answered catalogue
 * never reaches the shelf. The message names the unit, because "invalid configuration" tells a
 * shopkeeper nothing they can act on.
 */
create or replace function public.assert_product_units_settled(p_product_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_gaps text;
  v_sold int;
begin
  select count(*) into v_sold
    from public.product_units
   where product_id = p_product_id and is_sold;

  if v_sold = 0 then
    raise exception 'Say what this is sold in before saving it.'
      using errcode = 'check_violation';
  end if;

  select string_agg(unit_name, ', ') into v_gaps
    from public.unit_gaps_unchecked(p_product_id);

  if v_gaps is not null then
    raise exception 'Nothing is sold in %. Either sell in it too, or say what one is worth in a unit you do sell in.', v_gaps
      using errcode = 'check_violation';
  end if;
end;
$fn$;

grant execute on function public.assert_product_units_settled(uuid) to authenticated;
