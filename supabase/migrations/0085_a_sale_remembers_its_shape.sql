-- 0085 — A sale remembers which SHAPE it was sold in
--
-- The till already asks. A seller picks the shape — a crate, a pack, a dirica — and the line shows
-- "3 crates x N12,000". That choice then went no further than the browser: `save_draft_order` is
-- sent `pack_id`, the retired one-pack-per-product id from before 0061, and the shape the seller
-- actually chose was never in the payload at all.
--
-- Three things follow from that, and the third is not cosmetic:
--
--   * A RECEIPT CANNOT NAME THE SHAPE. It falls back to the base unit, so a customer who bought
--     three crates is handed a receipt for 36 pieces.
--
--   * A SHAPE ADDED TODAY IS INVISIBLE. `product_packs` has eight rows in this shop and is not
--     written any more; a shop that defines its shapes now has no pack at all, so `pack_id` is
--     null on every line and every receipt reads in base units.
--
--   * A CLAIMED ORDER COMES BACK WRONG. Reading a draft back sets the shape to null — there is no
--     column to read it from — so an order started on the counter phone and claimed on the till
--     returns as "3 pieces" where it was "3 crates". The price per unit is unchanged, so the bill
--     silently falls by a factor of twelve, and the stock movement with it.
--
-- One column on each of the two line tables, sent by the client, checked against the product by
-- the server. `entered_pack_id` is left in place and still written: old rows are read through it,
-- and a column dropped is a column that cannot be consulted when a figure is disputed.

-- ─── The column ─────────────────────────────────────────────────────────────────────

alter table public.draft_order_lines
  add column if not exists sale_unit_id uuid
    references public.product_units (id) on delete set null;

alter table public.sale_lines
  add column if not exists sale_unit_id uuid
    references public.product_units (id) on delete set null;

comment on column public.sale_lines.sale_unit_id is
  'The shape this line was sold in. ON DELETE SET NULL, not restrict: a shop retiring a shape must '
  'not be blocked by sales that used it, and the line keeps entered_qty and base_qty either way — '
  'the quantity survives, only the word for it is lost.';

-- ─── What the old rows were sold in ─────────────────────────────────────────────────
--
-- Matched through the PACK NAME, which is exactly the path 0061 used to turn packs into shapes:
-- a pack called "Crate" became the product's shape whose store unit is called "Crate". So a row
-- carrying that pack id is pointed at the same shape it would have been given had this column
-- existed, rather than being guessed at from arithmetic.

update public.draft_order_lines dl
   set sale_unit_id = pu.id
  from public.product_packs pk
  join public.products p     on p.id = pk.product_id
  join public.store_units su on su.store_id = p.store_id and su.name = pk.name
  join public.product_units pu
    on pu.product_id = pk.product_id and pu.store_unit_id = su.id
 where dl.sale_unit_id is null
   and dl.entered_pack_id = pk.id;

update public.sale_lines sl
   set sale_unit_id = pu.id
  from public.product_packs pk
  join public.products p     on p.id = pk.product_id
  join public.store_units su on su.store_id = p.store_id and su.name = pk.name
  join public.product_units pu
    on pu.product_id = pk.product_id and pu.store_unit_id = su.id
 where sl.sale_unit_id is null
   and sl.entered_pack_id = pk.id;

/*
 * And what is left, by the size that was recorded.
 *
 * A line with no pack still knows how many base units one of whatever-it-was contained:
 * base_qty / entered_qty. Where exactly ONE of the product's shapes is that size, the answer is
 * not a guess and the row can say what it was sold in. Where two shapes share a size, or the
 * division does not land on one, the column stays null and the reader falls back — an honest
 * blank beats a plausible wrong word on a receipt somebody is arguing about.
 */
update public.sale_lines sl
   set sale_unit_id = (
     select pu.id
       from public.product_units pu
      where pu.product_id = sl.product_id
        and abs(pu.base_qty - (sl.base_qty / sl.entered_qty)) < 0.0001
   )
 where sl.sale_unit_id is null
   and sl.entered_qty <> 0
   and (select count(*)
          from public.product_units pu2
         where pu2.product_id = sl.product_id
           and abs(pu2.base_qty - (sl.base_qty / sl.entered_qty)) < 0.0001) = 1;

-- ─── The two writers, copied from what is running and given the column ──────────────

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
                                          containers_out, position,
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
            /*
             * Checked against the product, not taken on trust.
             *
             * A draft is client-authored, and a shape id belonging to another product would put a
             * word on a receipt that has nothing to do with what was sold. Rejected rather than
             * corrected: silently swapping it would hide a client bug for as long as it took
             * somebody to notice a wrong receipt.
             */
            (select pu.id from public.product_units pu
              where pu.id = nullif(v_line ->> 'sale_unit_id', '')::uuid
                and pu.product_id = (v_line ->> 'product_id')::uuid));
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

CREATE OR REPLACE FUNCTION public.record_sale(p_store_id uuid, p_lines jsonb, p_customer_id uuid DEFAULT NULL::uuid, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid, p_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sale_id    uuid;
  v_line       jsonb;
  v_charge     jsonb;
  v_product_id uuid;
  v_base_qty   qty;
  v_entered    qty;
  v_pack_id    uuid;
  v_sale_unit  uuid;   -- the shape the seller chose, added by 0085
  v_price      money_amt;
  v_line_total money_amt;
  v_total      money_amt := 0;
  v_avg_cost   unit_cost;
  v_cogs       money_amt;
  v_containers qty;
  v_deposit    money_amt;
  v_ret        record;
  v_period     uuid;
  v_bad        int;
  v_pos        int := 0;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to record sales' using errcode = '42501';
  end if;

  if p_client_uuid is not null then
    select id into v_sale_id from public.sales where client_uuid = p_client_uuid;
    if v_sale_id is not null then
      return v_sale_id;
    end if;
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'a sale needs at least one line' using errcode = '22023';
  end if;

  insert into public.sales (store_id, store_customer_id, occurred_at, client_uuid, total)
  values (p_store_id, p_customer_id, p_occurred_at, p_client_uuid, 0)
  returning id into v_sale_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_entered    := (v_line ->> 'qty')::qty;
    v_pack_id    := nullif(v_line ->> 'pack_id', '')::uuid;

    /*
     * THE SHAPE, resolved on the server.
     *
     * A shape id that does not belong to this product resolves to null rather than being written:
     * the quantity is already checked by `assert_sale_unit_allowed`, and a word that came from
     * another product is worse than no word, because a receipt showing it looks answered.
     */
    select pu.id into v_sale_unit
      from public.product_units pu
     where pu.id = nullif(v_line ->> 'sale_unit_id', '')::uuid
       and pu.product_id = v_product_id;
    v_containers := coalesce((v_line ->> 'containers_out')::qty, 0);
    v_deposit    := coalesce((v_line ->> 'deposit_charged')::money_amt, 0);

    v_base_qty := coalesce(
      nullif(v_line ->> 'base_qty', '')::qty,
      -- The shape, when the caller named one and left the arithmetic to the server. Ahead of the
      -- pack lookup because the pack is the retired model; behind the caller's own figure because
      -- a quantity already computed is not this function's to second-guess.
      (select v_entered * pu.base_qty from public.product_units pu where pu.id = v_sale_unit),
      public.to_base_qty(v_product_id, v_entered, v_pack_id)
    );

    -- Refuse a shape this product is not sold in, before anything is written.
    perform public.assert_sale_unit_allowed(v_product_id, v_base_qty);

    v_price      := nullif(v_line ->> 'unit_price', '')::money_amt;
    v_line_total := nullif(v_line ->> 'line_total', '')::money_amt;

    if v_line_total is null and v_price is null then
      raise exception 'a sale line needs either a price or a line total' using errcode = '22023';
    end if;
    if v_line_total is null then
      v_line_total := v_entered * v_price;
    end if;
    if v_price is null then
      v_price := case when v_entered <> 0 then v_line_total / v_entered else v_line_total end;
    end if;

    /*
     * WHAT THIS STOCK ACTUALLY COST, taken from the layers it came out of.
     *
     * `consume_stock_layers` draws the oldest first and returns the money, so a sale spanning a
     * ₦4,400 delivery and a ₦4,200 one is charged partly at each — which is what its margin was.
     * The average is kept as the fallback for a product with no layers yet, so a shop mid-
     * migration still records a sensible figure rather than zero.
     */
    select avg_unit_cost into v_avg_cost from public.products where id = v_product_id;

    v_cogs := public.consume_stock_layers(v_product_id, v_base_qty);
    if v_base_qty > 0 and v_cogs > 0 then
      v_avg_cost := v_cogs / v_base_qty;
    end if;

    insert into public.sale_lines (sale_id, product_id, entered_qty, entered_pack_id, base_qty,
                                   unit_price, line_total, unit_cost_at_sale, containers_out,
                                   deposit_charged, sale_unit_id)
    values (v_sale_id, v_product_id, v_entered, v_pack_id, v_base_qty,
            v_price, v_line_total, coalesce(v_avg_cost, 0), v_containers, v_deposit, v_sale_unit);

    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at)
    values (p_store_id, v_product_id, 'sale', -v_base_qty, coalesce(v_avg_cost, 0),
            'sales', v_sale_id, p_occurred_at);

    for v_ret in
      select * from public.returnables_for_sale(v_product_id, v_base_qty, v_containers)
    loop
      if p_customer_id is not null then
        insert into public.deposit_ledger (store_id, store_customer_id, empties_category_id,
                                           direction, qty_units, deposit_per_unit,
                                           ref_table, ref_id, occurred_at)
        values (p_store_id, p_customer_id, v_ret.empties_category_id, 'collected',
                v_ret.qty_units,
                -- Only a deposit that was actually CHARGED is money the shop holds. The
                -- pool's standard rate was being stamped on every row, so containers sent
                -- out on trust looked like cash taken and never given back.
                case when v_deposit > 0 then v_ret.deposit_per_unit else 0 end,
                'sales', v_sale_id, p_occurred_at);

      elsif v_deposit <= 0 and v_ret.deposit_total > 0 then
        raise exception
          'This sale includes % that must come back. Either add a customer, or charge the % deposit as cash.',
          v_ret.category_name, to_char(v_ret.deposit_total, 'FM999999990.00')
          using errcode = '22023';
      end if;
    end loop;

    v_total  := v_total + v_line_total + v_deposit;
    v_period := public.ensure_open_period(v_product_id);
    perform public.refresh_period(v_period);
  end loop;

  -- Named charges: each keeps its own label, because "what was this for?" is the question that
  -- gets asked when a customer disputes a bill weeks later.
  for v_charge in select * from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) loop
    continue when coalesce((v_charge ->> 'amount')::money_amt, 0) <= 0;
    insert into public.sale_charges (sale_id, label, amount, sort_order)
    values (v_sale_id,
            coalesce(nullif(trim(v_charge ->> 'label'), ''), 'Charge'),
            (v_charge ->> 'amount')::money_amt,
            v_pos);
    v_total := v_total + (v_charge ->> 'amount')::money_amt;
    v_pos := v_pos + 1;
  end loop;

  update public.sales set total = v_total where id = v_sale_id;

  select count(*) into v_bad
  from public.sale_lines sl
  join public.products p on p.id = sl.product_id
  join public.units u on u.code = p.base_unit
  where sl.sale_id = v_sale_id
    and not u.allows_fraction
    and sl.base_qty <> trunc(sl.base_qty);

  if v_bad > 0 then
    raise exception 'one of these products is counted in whole units only' using errcode = '22023';
  end if;

  return v_sale_id;
end;
$function$;

-- One overload each, or PostgREST answers 300 to every call — the failure that stopped the till
-- in 0058 and is worth a second of checking every time either of these is touched.
do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname in ('save_draft_order', 'record_sale')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a writer has % overloads; PostgREST cannot choose', n;
    end if;
  end loop;
end;
$check$;
