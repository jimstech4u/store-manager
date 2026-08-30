-- ════════════════════════════════════════════════════════════════════════════════════════════
-- One place a shop says what it sells in
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- There are two tables holding the same fact. `product_sale_units` came first and is what the till
-- reads end to end — six functions depend on it, `resolve_price` and `assert_sale_unit_allowed`
-- among them. `product_units` came with 0061 and is the richer model: it knows what a product is
-- BOUGHT in as well, and since 0067 it knows what each unit is worth in terms of another.
--
-- The new editor writes `product_units`. Nothing carried that to the till, so a shop could set up
-- exactly how it sells something, save it, and find the sell screen had never heard of any of it.
-- A probe caught this by returning zero sale-unit rows for a product that had just been configured.
--
-- TWO WRITERS WOULD BE WORSE THAN ONE WRONG ONE. Mirroring by hand from the save function means the
-- two agree only as long as nobody ever writes to either by another route, and 0042 already carries
-- a comment about what happens in this codebase when a second path to the same data appears.
--
-- So `product_sale_units` stops being somewhere anybody writes and becomes DERIVED: a trigger keeps
-- it in step with `product_units`, every existing reader carries on untouched, and there is exactly
-- one table a shop edits. The rows keep their ids where a unit already existed, because a draft
-- order sitting on somebody's till is holding one of those ids and must not be orphaned by a
-- catalogue edit made at the counter.

/**
 * Bring one product's sale units in line with what it is sold in.
 *
 * MATCHED ON NAME, which is what makes this safe to run over and over: a crate that was already
 * there keeps its id, so an open receipt referring to it still resolves. Only genuinely new units
 * get new ids, and only units the shop actually removed go away.
 */
create or replace function public.sync_sale_units(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- Units the shop no longer sells in. Deleted first so a rename frees its name before the insert
  -- below tries to claim it.
  delete from public.product_sale_units su
   where su.product_id = p_product_id
     and not exists (
       select 1
         from public.product_units pu
         join public.store_units stu on stu.id = pu.store_unit_id
        where pu.product_id = p_product_id
          and pu.is_sold
          and stu.name = su.name
     );

  insert into public.product_sale_units (
    product_id, name, base_qty, price, sort_order,
    whole_digit, allow_quarter, allow_half, allow_three_quarter
  )
  select pu.product_id, stu.name, pu.base_qty, pu.sell_price, pu.sort_order,
         pu.whole_digit, pu.allow_quarter, pu.allow_half, pu.allow_three_quarter
    from public.product_units pu
    join public.store_units stu on stu.id = pu.store_unit_id
   where pu.product_id = p_product_id
     and pu.is_sold
  on conflict (product_id, name) do update
     set base_qty            = excluded.base_qty,
         price               = excluded.price,
         sort_order          = excluded.sort_order,
         whole_digit         = excluded.whole_digit,
         allow_quarter       = excluded.allow_quarter,
         allow_half          = excluded.allow_half,
         allow_three_quarter = excluded.allow_three_quarter;
end;
$fn$;

revoke all on function public.sync_sale_units(uuid) from public;

/**
 * Whenever what a product is sold in changes.
 *
 * On the row trigger rather than inside `save_product_units` alone, so a unit changed by any route
 * — a repair script, a future importer, a correction cascading down from 0067 — reaches the till
 * too. That is the whole point of deriving it: there is no way to update one and forget the other.
 */
create or replace function public.tg_sync_sale_units()
returns trigger
language plpgsql
as $fn$
begin
  perform public.sync_sale_units(coalesce(new.product_id, old.product_id));
  return null;
end;
$fn$;

drop trigger if exists product_units_sync_sale on public.product_units;
create trigger product_units_sync_sale
  after insert or update or delete on public.product_units
  for each row execute function public.tg_sync_sale_units();

/*
 * Everything already in the catalogue, brought into line once.
 *
 * Only products that HAVE product_units rows: a shop still on the old model has nothing to derive
 * from, and deriving an empty set for it would delete the sale units its till is using today.
 */
do $sync$
declare
  v_id uuid;
begin
  for v_id in
    select distinct product_id from public.product_units where is_sold
  loop
    perform public.sync_sale_units(v_id);
  end loop;
end;
$sync$;

/*
 * And the table stops accepting writes from anywhere else.
 *
 * It is derived now. A browser writing to it directly would be editing a copy — the change would
 * look right until the next time anything touched `product_units` and the trigger overwrote it,
 * which is the worst kind of bug: correct on the screen of the person who made it, gone by the
 * time anybody else looks.
 */
drop policy if exists sale_units_write on public.product_sale_units;
create policy sale_units_write on public.product_sale_units
  for all to authenticated using (false) with check (false);
