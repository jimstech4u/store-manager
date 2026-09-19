-- 0148 — A shape has one id, and a sale line always knows its shape
--
-- «the receipt is not printing 'still with them' and the empties page did not get updated with new
--  sales' empties records … every item sold that has returnable true needs a customer and adds a
--  record to the empties»
--
-- ─── What was actually wrong ────────────────────────────────────────────────────────
--
-- Nothing about empties. The SHAPE never reached the sale.
--
-- `sync_sale_units` mirrors each sold shape into `product_sale_units`, keyed (product, name) — under a
-- NEW id. The till reads its shapes from that mirror (`product_sale_units_for`), so every line it
-- builds carries a mirror id. `save_draft_order` then looks that id up among the REAL shapes
-- (`product_units`), finds nothing, and writes NULL. Of 361 mirror rows, not one shared an id with
-- the shape it mirrors.
--
-- With no shape on the line:
--   · `sale_line_owes_containers` cannot see that a returnable crate went out, so nothing is owed —
--     no row on the customer's empties, nothing under "Still with them", nothing on the Empties page;
--   · `returnable_needs_a_customer` (0142) cannot see it either, so a walk-in takes crates freely;
--   · the stock was still right, because the legacy `pack_id` carried the multiplier — which is why
--     nothing looked broken on the shelf.
--
-- The benchmark passed throughout, because it sends REAL shape ids straight to the server. The app
-- never did. (CLAUDE.md: a harness that writes what the app does not is the one thing that must never
-- pass while the app is broken — and this is that.)
--
-- ─── The fix ────────────────────────────────────────────────────────────────────────
--
--  1. ONE ID PER SHAPE. Each mirror row takes the id of the shape it mirrors, and `sync_sale_units`
--     keeps it that way. Prices and bulk tiers are keyed on the mirror id and follow it (the tier
--     foreign key now cascades on update). Every reader — the till, prices, tiers, the public order
--     page — now speaks the same id as the sale line.
--  2. `line_shape` resolves what a line was given: a real shape id; a RETIRED mirror id still held by a
--     till that was open during this migration; or, when none was given, the only shape the product
--     is sold in — a product sold only by the crate was sold by the crate.
--  3. `save_draft_order` resolves through it (one expression changed, spliced from the live
--     definition), and a trigger on `sale_lines` does the same as a last net, named to fire before the
--     customer check so that check sees the shape too.
--  4. The damage is repaired: open drafts get their shapes back, settled lines whose shape can be
--     worked out get it, and the containers those sales sent out are written to the customer's
--     empties — exactly the row the sale would have written.

-- ─── Old mirror ids, kept so a till open during this change still resolves ───────────

create table if not exists public.retired_sale_unit_ids (
  old_id          uuid primary key,
  product_unit_id uuid not null references public.product_units (id) on delete cascade,
  retired_at      timestamptz not null default now()
);

alter table public.retired_sale_unit_ids enable row level security;
-- No policies: read only by SECURITY DEFINER functions.

-- ─── 1. One id per shape ────────────────────────────────────────────────────────────

create temporary table shape_map as
select su.id as old_id, pu.id as new_id
  from public.product_sale_units su
  join public.product_units pu on pu.product_id = su.product_id and pu.is_sold
  join public.store_units stu on stu.id = pu.store_unit_id and stu.name = su.name
 where su.id <> pu.id;

insert into public.retired_sale_unit_ids (old_id, product_unit_id)
select old_id, new_id from shape_map
on conflict (old_id) do nothing;

alter table public.product_price_tiers
  drop constraint if exists product_price_tiers_sale_unit_id_fkey;

update public.product_price_tiers t
   set sale_unit_id = m.new_id
  from shape_map m
 where t.sale_unit_id = m.old_id;

update public.product_sale_units su
   set id = m.new_id
  from shape_map m
 where su.id = m.old_id;

alter table public.product_price_tiers
  add constraint product_price_tiers_sale_unit_id_fkey
  foreign key (sale_unit_id) references public.product_sale_units (id)
  on delete cascade on update cascade;

-- The mirror keeps the shape's own id from now on, including across a rename or a re-add.
create or replace function public.sync_sale_units(p_product_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
end;
$function$;

-- ─── 2. What shape a line is in ─────────────────────────────────────────────────────

create or replace function public.line_shape(
  p_product_id    uuid,
  p_given         uuid,
  p_per_unit_base numeric
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    -- A real shape of this product.
    (select pu.id from public.product_units pu
      where pu.id = p_given and pu.product_id = p_product_id),
    -- A mirror id retired by 0148, still held by a till that was open at the time.
    (select r.product_unit_id from public.retired_sale_unit_ids r
       join public.product_units pu on pu.id = r.product_unit_id
      where r.old_id = p_given and pu.product_id = p_product_id),
    -- Nothing usable given: the one sold shape whose size matches what went out…
    (select min(pu.id::text)::uuid from public.product_units pu
      where pu.product_id = p_product_id and pu.is_sold
        and p_per_unit_base is not null and pu.base_qty = p_per_unit_base
     having count(*) = 1),
    -- …or the only shape the product is sold in at all.
    (select min(pu.id::text)::uuid from public.product_units pu
      where pu.product_id = p_product_id and pu.is_sold
     having count(*) = 1)
  );
$fn$;

revoke all on function public.line_shape(uuid, uuid, numeric) from public;

-- ─── 3a. Saving a draft resolves the shape (spliced from the live definition) ───────

CREATE OR REPLACE FUNCTION public.save_draft_order(p_store_id uuid, p_lines jsonb, p_draft_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_label text DEFAULT NULL::text, p_fee_amount money_amt DEFAULT 0, p_fee_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_client_uuid uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id   uuid := p_draft_id;
  v_line jsonb;
  v_pos  int := 0;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to record sales' using errcode = '42501';
  end if;

  if v_id is null and p_client_uuid is not null then
    select id into v_id from public.draft_orders where client_uuid = p_client_uuid;
  end if;

  if v_id is null then
    insert into public.draft_orders (store_id, store_customer_id, label, code,
                                     fee_amount, fee_label, note, held_by, client_uuid)
    values (p_store_id, p_customer_id, nullif(trim(p_label), ''),
            public.generate_draft_code(p_store_id),
            coalesce(p_fee_amount, 0), nullif(trim(p_fee_label), ''),
            nullif(trim(p_note), ''), auth.uid(), p_client_uuid)
    returning id into v_id;
  else
    update public.draft_orders
       set store_customer_id = p_customer_id,
           label      = nullif(trim(p_label), ''),
           fee_amount = coalesce(p_fee_amount, 0),
           fee_label  = nullif(trim(p_fee_label), ''),
           note       = nullif(trim(p_note), '')
     where id = v_id and status = 'open';

    if not found then
      raise exception 'that order is no longer open' using errcode = '22023';
    end if;
  end if;

  -- Replace the lines wholesale: the client's copy is the truth for an open draft, and merging
  -- would need conflict rules for a workspace that has no concurrent editors by design.
  delete from public.draft_order_lines where draft_order_id = v_id;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    insert into public.draft_order_lines (draft_order_id, product_id, entered_qty,
                                          entered_pack_id, unit_price, line_total,
                                          containers_out, position, deposit_charged,
                                          -- THE ONE ADDITION. Everything else is the live
                                          -- definition, byte for byte.
                                          sale_unit_id)
    values (v_id,
            (v_line ->> 'product_id')::uuid,
            (v_line ->> 'qty')::qty,
            nullif(v_line ->> 'pack_id', '')::uuid,
            (v_line ->> 'unit_price')::money_amt,
            (v_line ->> 'line_total')::money_amt,
            coalesce((v_line ->> 'containers_out')::qty, 0),
            v_pos,
            -- Missing means nothing was taken, which is what a shop sending containers out on
            -- trust has done. It is not the same as the till failing to ask, but the draft cannot
            -- tell those apart and must not invent a figure to cover the difference.
            coalesce((v_line ->> 'deposit_charged')::money_amt, 0),
            /*
             * Checked against the product, not taken on trust.
             *
             * A draft is client-authored, and a shape id belonging to another product would put a
             * word on a receipt that has nothing to do with what was sold. Rejected rather than
             * corrected: silently swapping it would hide a client bug for as long as it took
             * somebody to notice a wrong receipt.
             */
            /*
             * RESOLVED, not merely checked (0148).
             *
             * This was a subquery that returned no row for an id it did not recognise — which is a
             * NULL, not a rejection, whatever the note above says. The till offered shape ids from a
             * mirror table that never shared its ids with the real shapes, so every line it saved
             * lost its shape here, silently: no container was ever owed, no receipt said what was
             * still with the customer, and the rule that a returnable sale needs a customer never
             * fired. `line_shape` accepts the real id, translates a retired mirror id, and fills the
             * only shape a product is sold in when none was given.
             */
            public.line_shape((v_line ->> 'product_id')::uuid,
                              nullif(v_line ->> 'sale_unit_id', '')::uuid,
                              null));
    v_pos := v_pos + 1;
  end loop;

  -- Named charges, replaced wholesale each save.
  --
  -- A draft is edited over and over while a customer is being served, so the charges are rewritten
  -- rather than diffed — there is no history to preserve on a draft, and the settled sale is where
  -- charges become permanent.
  --
  -- NULL means "the caller did not mention charges", which must not wipe them; an empty array
  -- means "there are none left", which must.
  if p_charges is not null then
    delete from public.draft_order_charges where draft_order_id = v_id;
    insert into public.draft_order_charges (draft_order_id, label, amount, note, sort_order)
    select v_id,
           coalesce(nullif(trim(c ->> 'label'), ''), 'Charge'),
           (c ->> 'amount')::money_amt,
           -- The only line that differs from the definition this restores. A note per charge,
           -- because a receipt with a delivery fee and a deposit has two things to explain.
           nullif(trim(c ->> 'note'), ''),
           (row_number() over ())::int
      from jsonb_array_elements(p_charges) c
     where coalesce((c ->> 'amount')::money_amt, 0) > 0;
  end if;

  return v_id;
end;
$function$;

-- ─── 3b. And a sale line resolves it, before anything else looks at it ──────────────

create or replace function public.tg_sale_line_knows_its_shape()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.sale_unit_id is null
     or not exists (select 1 from public.product_units pu
                     where pu.id = new.sale_unit_id and pu.product_id = new.product_id) then
    new.sale_unit_id := public.line_shape(
      new.product_id,
      new.sale_unit_id,
      case when coalesce(new.entered_qty, 0) > 0 then new.base_qty / new.entered_qty end
    );
  end if;
  return new;
end;
$fn$;

-- BEFORE triggers fire in name order: this one must run before `returnable_needs_a_customer`
-- and `sale_line_needs_todays_count`, so both see the shape it fills in.
drop trigger if exists a_sale_line_knows_its_shape on public.sale_lines;
create trigger a_sale_line_knows_its_shape
  before insert on public.sale_lines
  for each row execute function public.tg_sale_line_knows_its_shape();

-- ─── 4. Repair ──────────────────────────────────────────────────────────────────────

-- Open drafts: every line gets the shape it can be shown to be in.
update public.draft_order_lines dl
   set sale_unit_id = public.line_shape(dl.product_id, null, null)
  from public.draft_orders d
 where d.id = dl.draft_order_id
   and d.status = 'open'
   and dl.sale_unit_id is null
   and public.line_shape(dl.product_id, null, null) is not null;

-- Settled lines: the shape, where the size of what went out says which one it was.
create temporary table repaired_lines as
select sl.id,
       public.line_shape(sl.product_id, null,
         case when coalesce(sl.entered_qty, 0) > 0 then sl.base_qty / sl.entered_qty end) as shape
  from public.sale_lines sl
 where sl.sale_unit_id is null;

update public.sale_lines sl
   set sale_unit_id = r.shape
  from repaired_lines r
 where r.id = sl.id
   and r.shape is not null;

-- And the containers those sales sent out — the row the sale itself would have written.
insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                     direction, qty, reason, ref_table, ref_id, occurred_at, side)
select s.store_id,
       s.store_customer_id,
       sl.product_id,
       sl.sale_unit_id,
       'out',
       sl.entered_qty,
       'Backfilled: the sale lost its shape on the way in (0148)',
       'sale_lines',
       sl.id,
       s.occurred_at,
       'they_hold'
  from repaired_lines r
  join public.sale_lines sl on sl.id = r.id and r.shape is not null
  join public.sales s
    on s.id = sl.sale_id
   and s.status = 'posted'
   and s.store_customer_id is not null
  join public.stores st on st.id = s.store_id
  join public.store_customers sc on sc.id = s.store_customer_id
  join public.product_units pu on pu.id = sl.sale_unit_id and pu.is_returnable
 where sl.entered_qty > 0
   and not exists (select 1 from public.customer_empties ce
                    where ce.ref_table = 'sale_lines' and ce.ref_id = sl.id)
   and not exists (select 1
                     from public.customer_empties ce
                     join public.deposit_ledger dl on dl.id = ce.ref_id
                    where ce.ref_table = 'deposit_ledger'
                      and dl.ref_table = 'sales'
                      and dl.ref_id = s.id);

-- ─── Checks ─────────────────────────────────────────────────────────────────────────

do $check$
declare n int; v_bad int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('save_draft_order', 'sync_sale_units', 'line_shape', 'product_sale_units_for')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a shape function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;

  select count(*) into v_bad
    from public.product_sale_units su
   where not exists (select 1 from public.product_units pu where pu.id = su.id);
  if v_bad > 0 then
    raise exception '% mirror shapes still have an id no real shape has', v_bad;
  end if;
end;
$check$;
