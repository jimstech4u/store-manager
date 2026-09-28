-- 0207 - A cheaper price survives the shape being taken off sale
--
-- Reported from the shop: "when I edit product cheaper price that seems to clear ... something is
-- not making a consistent data retaining in edit, new, price and shape of product".
--
-- It was not the form. It was two correct-looking pieces meeting:
--
--   · `sync_sale_units` DELETES the `product_sale_units` row for any shape that is no longer sold.
--     That is right — that table is what the storefront and `resolve_price` read as "what can be
--     bought", and leaving an unsold shape there would offer it online.
--
--   · `product_price_tiers.sale_unit_id` referenced it `ON DELETE CASCADE`.
--
-- So taking a shape off sale silently and permanently destroyed every quantity price on it. No
-- warning, nothing in the audit log — `product_price_tiers` is not audited — and no way back. Any
-- edit that changed which shapes were sold quietly threw away the bands for the rest.
--
-- I HIT THIS MYSELF. Unticking Piece and Bottle across 85 shapes went through exactly this path.
-- Two bands survive in Ashabi, both on Pack; whether any existed on a piece or a bottle beforehand
-- cannot now be established, because nothing recorded their going.
--
-- ── THE ANCHOR ──────────────────────────────────────────────────────────────────
--
-- A band belongs to a SHAPE — "five or more crates" — and `product_units` is where a shape lives.
-- `product_sale_units` is a mirror of the sellable ones, rebuilt whenever anything changes, and
-- hanging the only reference off a table that is rebuilt is what made the loss possible.
--
-- So the band now names the shape directly, and keeps the mirror link beside it as the derived
-- thing it always was. Taking a shape off sale detaches the band; putting it back on sale links it
-- up again, in `sync_sale_units`, under the same id the mirror has always carried (0148).

alter table public.product_price_tiers
  add column if not exists product_unit_id uuid references public.product_units(id) on delete cascade;

/*
 * Backfilled from the link that exists today. `product_sale_units.id` IS the shape's own id — the
 * mirror has carried it since 0148 — so this is the same fact written where it cannot be swept
 * away by a rebuild.
 */
update public.product_price_tiers t
   set product_unit_id = t.sale_unit_id
 where t.product_unit_id is null
   and t.sale_unit_id is not null
   and exists (select 1 from public.product_units pu where pu.id = t.sale_unit_id);

create index if not exists product_price_tiers_shape_idx
  on public.product_price_tiers (product_unit_id) where product_unit_id is not null;

-- ── And the mirror stops taking the band with it ────────────────────────────────
alter table public.product_price_tiers
  drop constraint if exists product_price_tiers_sale_unit_id_fkey;

alter table public.product_price_tiers
  add constraint product_price_tiers_sale_unit_id_fkey
  foreign key (sale_unit_id) references public.product_sale_units(id)
  on update cascade on delete set null;

create or replace function public.sync_sale_units(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    id, product_id, name, base_qty, price, sort_order,
    whole_digit, allow_quarter, allow_half, allow_three_quarter
  )
  select pu.id, pu.product_id, stu.name, pu.base_qty, pu.sell_price, pu.sort_order,
         pu.whole_digit, pu.allow_quarter, pu.allow_half, pu.allow_three_quarter
    from public.product_units pu
    join public.store_units stu on stu.id = pu.store_unit_id
   where pu.product_id = p_product_id
     and pu.is_sold
  on conflict (product_id, name) do update
     set id                  = excluded.id,   -- 0148: the mirror carries the shape's own id
         base_qty            = excluded.base_qty,
         price               = excluded.price,
         sort_order          = excluded.sort_order,
         whole_digit         = excluded.whole_digit,
         allow_quarter       = excluded.allow_quarter,
         allow_half          = excluded.allow_half,
         allow_three_quarter = excluded.allow_three_quarter;

  /*
   * AND THE CHEAPER PRICES FIND THEIR SHAPE AGAIN.
   *
   * The delete above detaches any band on a shape that has stopped being sold (0207 — it used to
   * DESTROY it, through `on delete cascade`). Re-ticking the shape puts the mirror row back under
   * the same id, so the band it had is linked up again and the shop's typed work comes back with
   * it rather than having to be remembered and re-entered.
   */
  update public.product_price_tiers t
     set sale_unit_id = t.product_unit_id
   where t.product_id = p_product_id
     and t.sale_unit_id is null
     and t.product_unit_id is not null
     and exists (select 1 from public.product_sale_units su where su.id = t.product_unit_id);
end;
$$;

notify pgrst, 'reload schema';
