-- 0082 — The deposit rate a shop actually charges
--
-- «the bad container out you collect 125 naira each that is sitting on ui and no where to manage
--  that and we have even changed it»
--
-- `empties_categories.deposit` is printed in three places — the product's containers-out section,
-- the settle screen, the deposit suggestion — and could be changed in NONE of them. It was written
-- once by whoever seeded the shop and has been quietly wrong ever since: NBL bottles at ₦125 and
-- NBL crates at ₦1,500, figures from whenever that seed ran.
--
-- A number on screen that nobody can correct is worse than no number: it is read as the shop's
-- rate, and the shop cannot make it so.
--
-- Also renameable, because a pool's name is what a seller reads on the settle screen when deciding
-- which stack of crates they are holding — "NBL crate" against "Nigerian Breweries crate" is the
-- difference between recognising it and guessing.

create or replace function public.save_empties_category(
  p_category_id uuid,
  p_name        text default null,
  p_deposit     money_amt default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
begin
  select store_id into v_store from public.empties_categories where id = p_category_id;
  if v_store is null then
    raise exception 'That pool does not exist.' using errcode = '22023';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'You do not have permission to change deposit rates.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_deposit is not null and p_deposit < 0 then
    raise exception 'A deposit cannot be less than nothing.' using errcode = '22023';
  end if;

  /*
   * THE RATE IS A SUGGESTION, AND CHANGING IT CHANGES NOTHING ALREADY AGREED.
   *
   * Deposits actually taken live in `deposit_holdings`, against the receipt they were agreed on.
   * This figure is only what the till OFFERS next time — so a shop raising its rate does not
   * thereby owe more on money it took last year, and does not have to think about that when it
   * puts the right number in.
   *
   * `coalesce` so a caller can change one field without stating the other.
   */
  update public.empties_categories
     set name    = coalesce(nullif(btrim(p_name), ''), name),
         deposit = coalesce(p_deposit, deposit)
   where id = p_category_id;
end;
$fn$;

revoke all on function public.save_empties_category(uuid, text, money_amt) from public;
grant execute on function public.save_empties_category(uuid, text, money_amt) to authenticated;

-- ─── The pool, read whole ───────────────────────────────────────────────────────────
--
-- The screen that manages a pool needs its name, its kind and its rate; it was reaching for the
-- rate through the product that happened to lead there, which is the wrong way round.

create or replace function public.empties_category(p_category_id uuid)
returns table (
  id       uuid,
  name     text,
  kind     text,
  deposit  money_amt,
  products int,
  units_out qty
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select ec.id,
         ec.name,
         ec.kind,
         ec.deposit,
         (select count(*)::int from public.product_returnables pr
           where pr.empties_category_id = ec.id),
         coalesce((select sum(d.qty_units) from public.deposit_ledger d
                    where d.empties_category_id = ec.id and d.direction = 'collected'), 0)::qty
    from public.empties_categories ec
   where ec.id = p_category_id
     and public.is_store_member(ec.store_id);
$fn$;

revoke all on function public.empties_category(uuid) from public;
grant execute on function public.empties_category(uuid) to authenticated;
