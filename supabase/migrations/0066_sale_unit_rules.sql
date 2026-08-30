-- ════════════════════════════════════════════════════════════════════════════════════════════
-- The shop decides which part-amounts it sells
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- The till offers ¼, ½ and ¾ on a line when those fractions land on whole base units — a quarter
-- of a twelve-pack is three pieces, so it is offered; a quarter of a single bottle is not. That is
-- sound arithmetic and the wrong rule.
--
-- A SHOP SELLING HALF CRATES OF GULDER AND NOTHING ELSE gets offered quarters and three-quarters
-- too, because twelve divides by four. It does not sell those, and every one on the screen is a
-- way for a tired seller to record something the shop cannot deliver. Meanwhile a shop that sells
-- oil by any amount at all is held to quarters because that is what the arithmetic permits.
--
-- So the rule becomes the shop's, stated once per unit and obeyed everywhere. `whole_digit` off
-- means any quantity — oil, rice by weight. On, with halves allowed, means 0.5, 1, 1.5 and
-- nothing between.
--
-- SEEDED FROM WHAT THE TILL ALREADY DOES, so nothing changes for any existing shop on the day this
-- lands: every unit keeps exactly the fractions it was being offered. What changes is that a shop
-- can now say otherwise.
--
-- These live on `product_sale_units` because that is what the sell path reads end to end today.
-- `product_units` from 0061 is the model they merge into when the readers cut over; until then this
-- is one table's flags, not two competing answers.

alter table public.product_sale_units
  add column if not exists whole_digit         boolean not null default true,
  add column if not exists allow_quarter       boolean not null default false,
  add column if not exists allow_half          boolean not null default false,
  add column if not exists allow_three_quarter boolean not null default false;

/*
 * Exactly today's behaviour, written down.
 *
 * A fraction was offered when it landed on a whole number of base units. Each unit keeps precisely
 * that set, so the first time a seller opens this screen after the change it looks identical.
 */
update public.product_sale_units
   set allow_quarter       = (base_qty * 0.25) = floor(base_qty * 0.25),
       allow_half          = (base_qty * 0.5)  = floor(base_qty * 0.5),
       allow_three_quarter = (base_qty * 0.75) = floor(base_qty * 0.75)
 where not (allow_quarter or allow_half or allow_three_quarter);

/**
 * The unit, with the rules that govern selling in it.
 *
 * The till reads this to decide which part-buttons to show, what a typed quantity is snapped to,
 * and whether a line starts at one or at nothing.
 */
-- Dropped first: the shape of what it returns is changing, and `create or replace` cannot alter a
-- function's OUT parameters.
drop function if exists public.product_sale_units_for(uuid);

create function public.product_sale_units_for(p_product_id uuid)
returns table (
  id       uuid,
  name     text,
  base_qty qty,
  price    money_amt,
  whole_digit boolean,
  allow_quarter boolean,
  allow_half boolean,
  allow_three_quarter boolean,
  is_returnable boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select su.id, su.name, su.base_qty, su.price,
         su.whole_digit, su.allow_quarter, su.allow_half, su.allow_three_quarter,
         /*
          * Whether the container comes back.
          *
          * Read from the product's returnable setup rather than stored again here: a crate is
          * returnable because of what it IS, and a second copy of that fact is a second thing to
          * keep in step.
          */
         exists (
           select 1 from public.product_returnables pe
            where pe.product_id = su.product_id
         )
  from public.product_sale_units su
  join public.products p on p.id = su.product_id
  where su.product_id = p_product_id
    and public.is_store_member(p.store_id)
  order by su.sort_order, su.base_qty desc;
$$;

grant execute on function public.product_sale_units_for(uuid) to authenticated;
