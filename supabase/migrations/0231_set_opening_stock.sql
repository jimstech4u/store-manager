-- 0231 - Before stock history, the item's shelf figure IS its opening, and can be set again
--
-- "In edit product form, it loads the current count which, when no history on the product, is still
-- the initial amount which we can edit ... if we only allow initial before history, then it is
-- still the first line in the ledger and does not break ... there is no need to be reason because it
-- is not correction ... and the when does it go off, also the latest edit, only before stock history."
--
-- STOCK HISTORY is anything that physically moved the amount after the opening: a sale, a delivery,
-- damage, an adjustment. Until there is some, the figure on the edit form is the opening, and
-- setting it is not a correction: no reason, no count difference, nothing waiting for approval,
-- nothing in the loss or adjustment reports.
--
-- The ledger is append-only, so the opening is not overwritten: the difference is added as a
-- second OPENING line, dated at the original opening. The item's opening is then their sum, and
-- nothing but openings is on its ledger.
--
-- COUNTS stay as history, and "counted, it matched" stays true: every count period moves with the
-- opening, and a count that agreed with the records moves too (it still agrees). A count that
-- disagreed keeps the figure somebody counted — which is how a stuck count of 72 against an opening
-- of 3 becomes a count that matches once the opening is set to 72.
--
-- THE DATED LOTS are the latest ones given: the shelf's lots are rebuilt from `p_batches`, and
-- anything not dated is one undated lot.

create or replace function public.set_opening_stock(
  p_product_id uuid,
  p_qty qty,
  p_batches jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store    uuid;
  v_name     text;
  v_opened   timestamptz;
  v_current  numeric;
  v_delta    numeric;
  v_batch    jsonb;
  v_qty      numeric;
  v_dated    numeric := 0;
  v_expires  date;
  v_at       timestamptz;
begin
  -- The item row is locked: two people setting the same opening queue rather than both writing.
  select store_id, name into v_store, v_name from public.products where id = p_product_id for update;
  if v_store is null then
    raise exception 'That item is not in this shop.' using errcode = '23503';
  end if;
  if not (public.has_permission(v_store, 'products.manage')
          or public.has_permission(v_store, 'stock.count')) then
    raise exception 'You do not have permission to set opening stock.' using errcode = '42501';
  end if;
  if p_qty is null or p_qty < 0 then
    raise exception 'How many are on the shelf? Zero is an answer; nothing is not.' using errcode = '22023';
  end if;

  -- Only before stock history. After it, the shelf changes by a count.
  if exists (select 1 from public.stock_movements
              where product_id = p_product_id and kind <> 'opening') then
    raise exception
      '% has moved since it was opened, so its opening can no longer change. Count it instead.',
      coalesce(v_name, 'This item')
      using errcode = '22023';
  end if;

  for v_batch in select * from jsonb_array_elements(coalesce(p_batches, '[]'::jsonb)) loop
    v_qty := coalesce((v_batch ->> 'qty')::numeric, 0);
    if v_qty <= 0 then
      raise exception 'Every dated batch needs a quantity.' using errcode = '22023';
    end if;
    v_dated := v_dated + v_qty;
  end loop;
  if v_dated > p_qty then
    raise exception 'The dated batches come to % but the shelf has %. They describe the same shelf.',
      v_dated, p_qty using errcode = '22023';
  end if;

  select min(occurred_at), coalesce(sum(qty_delta), 0)
    into v_opened, v_current
    from public.stock_movements where product_id = p_product_id;
  v_delta := p_qty - v_current;
  v_at := coalesce(v_opened, now());

  -- ── The ledger: one more opening line, for the difference ─────────────────────────────
  if v_delta <> 0 then
    insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                        ref_table, ref_id, occurred_at, note)
    values (v_store, p_product_id, 'opening', v_delta, 0, 'products', p_product_id, v_at,
            'Opening stock set on the item');
  end if;

  -- ── The lots: the latest dates given, the rest undated ────────────────────────────────
  delete from public.stock_layers where product_id = p_product_id;
  for v_batch in
    select * from jsonb_array_elements(coalesce(p_batches, '[]'::jsonb))
     order by nullif(value ->> 'expires_on', '')::date nulls last
  loop
    v_qty := (v_batch ->> 'qty')::numeric;
    v_expires := nullif(v_batch ->> 'expires_on', '')::date;
    insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                     ref_table, ref_id, received_at, expires_on)
    values (v_store, p_product_id, v_qty, v_qty, 0, 'products', p_product_id, v_at, v_expires);
  end loop;
  if p_qty - v_dated > 0 then
    insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost,
                                     ref_table, ref_id, received_at, expires_on)
    values (v_store, p_product_id, p_qty - v_dated, p_qty - v_dated, 0, 'products', p_product_id, v_at, null);
  end if;

  -- ── The counts ────────────────────────────────────────────────────────────────────────
  if v_opened is null then
    -- Never opened: the opening count, exactly as `open_stock_by_count` records it.
    perform public.enter_stock_count(public.ensure_open_period(p_product_id), p_qty);
  elsif v_delta <> 0 then
    update public.stock_periods
       set opening_qty        = opening_qty + v_delta,
           -- A count that agreed with the records still agrees; one that disagreed keeps its figure.
           actual_closing_qty = case
                                  when actual_closing_qty is not null
                                   and actual_closing_qty = coalesce(expected_at_count, actual_closing_qty)
                                  then actual_closing_qty + v_delta
                                  else actual_closing_qty
                                end,
           expected_at_count  = case when expected_at_count is not null
                                     then expected_at_count + v_delta end
     where product_id = p_product_id;
  end if;

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  values (v_store, 'products', p_product_id, 'update',
          jsonb_build_object('opening', v_current),
          jsonb_build_object('opening', p_qty, 'dated', v_dated),
          'Opening stock set on the item');

  return jsonb_build_object('opening', p_qty, 'previous', v_current, 'dated', v_dated);
end;
$fn$;

revoke all on function public.set_opening_stock(uuid, qty, jsonb) from public;
grant execute on function public.set_opening_stock(uuid, qty, jsonb) to authenticated;

notify pgrst, 'reload schema';
