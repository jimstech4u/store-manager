-- ════════════════════════════════════════════════════════════════════════════════════════════
-- A shop sells what it sells, not everything it could
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- 0061 copied the catalogue into `product_units` and marked EVERY unit as both bought and sold,
-- because at the time nothing read the flag and it had no way to know better. That was harmless
-- while `product_units` was a model nothing consumed.
--
-- 0069 made the till derive from it, and the guess became visible: "American Cola PET 60cl" is sold
-- by the bottle and only by the bottle, and it acquired an unpriced "Piece" on the sell screen —
-- an option a seller could pick, with no price on it, for a shape the shop does not sell.
--
-- WHAT THE SHOP ACTUALLY SELLS IS ALREADY WRITTEN DOWN, in the sale units it has been using. So
-- that is read back rather than guessed at again: for any product that has them, a unit is sold if
-- and only if the shop had a sale unit by that name. A product with none is left alone — there is
-- nothing to learn from, and clearing its flags would take away the only thing it has.
--
-- Bought-in flags are untouched. Nothing has ever recorded what a delivery arrived in, so there is
-- nothing to read back, and "it can arrive in this" is the safe way to be wrong: it costs a shop a
-- tick in a form, where the other direction refuses a delivery that really happened.

/*
 * ONLY WHAT THE SHOP HAD BEFORE THE DERIVATION RAN.
 *
 * Written without the date first, and it read back the row it was trying to remove: 0069's
 * backfill had already created "Piece", so asking "is there a sale unit called Piece?" answered
 * yes, and the guess proved itself. The cutoff is what separates the shop's own record from a
 * conclusion this migration series drew a few minutes earlier.
 *
 * 2026-08-30 is the day 0069 was applied. Every sale unit a shop actually set up predates it.
 */
update public.product_units pu
   set is_sold = exists (
         select 1
           from public.product_sale_units su
           join public.store_units stu on stu.id = pu.store_unit_id
          where su.product_id = pu.product_id
            and su.name = stu.name
            and su.created_at < date '2026-08-30'
       )
 where exists (
         select 1
           from public.product_sale_units su
          where su.product_id = pu.product_id
            and su.created_at < date '2026-08-30'
       );

/*
 * And the till catches up.
 *
 * The trigger from 0069 fires per row, so the update above has already re-derived everything it
 * touched — including deleting the invented row. This is here for the products the update did not
 * touch at all, so the two tables are known to agree from this point rather than assumed to.
 */
do $sync$
declare
  v_id uuid;
begin
  for v_id in select distinct product_id from public.product_units loop
    perform public.sync_sale_units(v_id);
  end loop;
end;
$sync$;
