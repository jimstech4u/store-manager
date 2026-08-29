-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Undo an overload that should never have been created
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- 0058 added the per-charge note by rewriting `save_draft_order` with a tidier parameter ORDER.
-- Postgres treats a different order as a different function, so that created a second overload —
-- and PostgREST answers every call to an ambiguous name with 300 Multiple Choices. The till
-- stopped saving orders entirely: pressing "+" produced a tab on the phone and nothing in the shop.
--
-- Migration 0042 carries a comment warning about exactly this, from the last time it happened.
-- Reading it afterwards is not the same as reading it first.
--
-- The note never needed a signature change: charges arrive as JSON, and a JSON object can grow a
-- key without the function's arguments changing at all. So the tidier version goes, and the
-- original signature keeps the one line that matters.

drop function if exists public.save_draft_order(uuid, uuid, uuid, text, money_amt, text, text, uuid, jsonb, jsonb);

-- The live definition, with only the charge insert changed to carry `note`.
CREATE OR REPLACE FUNCTION public.save_draft_order(
  p_store_id uuid,
  p_lines jsonb,
  p_draft_id uuid DEFAULT NULL::uuid,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_label text DEFAULT NULL::text,
  p_fee_amount money_amt DEFAULT 0,
  p_fee_label text DEFAULT NULL::text,
  p_note text DEFAULT NULL::text,
  p_client_uuid uuid DEFAULT NULL::uuid,
  p_charges jsonb DEFAULT NULL::jsonb
)
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

  if v_id is not null then
    update public.draft_orders
       set store_customer_id = p_customer_id,
           label             = p_label,
           fee_amount        = coalesce(p_fee_amount, 0),
           fee_label         = p_fee_label,
           note              = p_note,
           held_by           = auth.uid(),
           updated_at        = now()
     where id = v_id and store_id = p_store_id and status = 'open'
    returning id into v_id;
  end if;

  if v_id is null then
    insert into public.draft_orders
      (store_id, code, store_customer_id, label, fee_amount, fee_label, note, client_uuid, held_by)
    values
      (p_store_id, public.generate_draft_code(p_store_id), p_customer_id, p_label,
       coalesce(p_fee_amount, 0), p_fee_label, p_note, p_client_uuid, auth.uid())
    returning id into v_id;
  end if;

  delete from public.draft_order_lines where draft_order_id = v_id;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    insert into public.draft_order_lines
      (draft_order_id, product_id, entered_qty, entered_pack_id, unit_price, line_total,
       containers_out, position)
    values (v_id,
            (v_line ->> 'product_id')::uuid,
            (v_line ->> 'qty')::qty,
            nullif(v_line ->> 'pack_id', '')::uuid,
            (v_line ->> 'unit_price')::money_amt,
            (v_line ->> 'line_total')::money_amt,
            coalesce((v_line ->> 'containers_out')::qty, 0),
            v_pos);
  end loop;

  -- NULL means "the caller did not mention charges", which must not wipe them; an empty array
  -- means "there are none left", which must.
  if p_charges is not null then
    delete from public.draft_order_charges where draft_order_id = v_id;
    insert into public.draft_order_charges (draft_order_id, label, amount, note, sort_order)
    select v_id,
           coalesce(nullif(trim(c ->> 'label'), ''), 'Charge'),
           (c ->> 'amount')::money_amt,
           -- The only new line. A note per charge, because a receipt with a delivery fee and a
           -- deposit has two things to explain and one note cannot hold both.
           nullif(trim(c ->> 'note'), ''),
           (row_number() over ())::int
      from jsonb_array_elements(p_charges) c
     where coalesce((c ->> 'amount')::money_amt, 0) > 0;
  end if;

  return v_id;
end;
$function$;

grant execute on function public.save_draft_order(uuid, jsonb, uuid, uuid, text, money_amt, text, text, uuid, jsonb) to authenticated;
