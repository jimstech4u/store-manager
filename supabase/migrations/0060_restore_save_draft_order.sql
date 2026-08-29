-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Restore the real `save_draft_order`, with the charge note added to it
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- 0059 rewrote this function from memory of what it did, and got one thing wrong that matters:
-- the ORIGINAL looks the draft up by `client_uuid` before inserting, and the rewrite did not. That
-- lookup is the idempotency — the till pushes the same order repeatedly as it is edited, and
-- without it the second push tried to insert a row that already existed and the shop answered 409.
--
-- Saves stopped working again, differently. `probe-till-writes` caught it this time, which is
-- what it was written for.
--
-- This is the definition from 0042, unchanged except for the single line that carries the note.
-- Reconstructing a function by hand is how both of these went wrong; copying it is not clever and
-- would have avoided them.

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
                                          containers_out, position)
    values (v_id,
            (v_line ->> 'product_id')::uuid,
            (v_line ->> 'qty')::qty,
            nullif(v_line ->> 'pack_id', '')::uuid,
            (v_line ->> 'unit_price')::money_amt,
            (v_line ->> 'line_total')::money_amt,
            coalesce((v_line ->> 'containers_out')::qty, 0),
            v_pos);
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
$function$
;

grant execute on function public.save_draft_order(uuid, jsonb, uuid, uuid, text, money_amt, text, text, uuid, jsonb) to authenticated;
