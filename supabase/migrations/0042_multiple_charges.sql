-- =====================================================================================
-- 0042 — Several named charges on one order
--
-- A distributor's bill routinely carries more than one addition: transport, loading, an
-- outstanding amount carried over. The schema has had `draft_order_charges` and `sale_charges`
-- since 0023 and nothing ever wrote to either — the app offered a single "extra charge" box whose
-- value went into `fee_amount`, so two charges had to be added together and given one name.
--
-- `save_draft_order` now persists a list, and `settle_draft_order` carries it onto the sale, where
-- `customer_account` and the receipt already know how to read it.
--
-- Both bodies are the live definitions with those changes applied, so nothing else moved.
-- =====================================================================================

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
    insert into public.draft_order_charges (draft_order_id, label, amount, sort_order)
    select v_id,
           coalesce(nullif(trim(c ->> 'label'), ''), 'Charge'),
           (c ->> 'amount')::money_amt,
           (row_number() over ())::int
      from jsonb_array_elements(p_charges) c
     where coalesce((c ->> 'amount')::money_amt, 0) > 0;
  end if;

  return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.settle_draft_order(p_draft_id uuid, p_payments jsonb DEFAULT '[]'::jsonb, p_occurred_at timestamp with time zone DEFAULT now(), p_client_uuid uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_draft record;
  v_lines jsonb;
  v_sale  uuid;
begin
  select * into v_draft from public.draft_orders where id = p_draft_id;
  if not found then
    raise exception 'that order no longer exists' using errcode = 'P0002';
  end if;

  if v_draft.status = 'settled' then
    return v_draft.settled_sale_id;      -- already done; a retry must not sell twice
  end if;
  if v_draft.status <> 'open' then
    raise exception 'that order was cancelled' using errcode = '22023';
  end if;

  if not public.has_permission(v_draft.store_id, 'sales.record') then
    raise exception 'you do not have permission to settle an order' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id',     l.product_id,
           'qty',            l.entered_qty,
           'pack_id',        l.entered_pack_id,
           'unit_price',     l.unit_price,
           'line_total',     l.line_total,
           'containers_out', l.containers_out
         ) order by l.position), '[]'::jsonb)
    into v_lines
    from public.draft_order_lines l
   where l.draft_order_id = p_draft_id;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'this order has nothing in it' using errcode = '22023';
  end if;

  v_sale := public.settle_sale(
    v_draft.store_id, v_lines, p_payments, v_draft.store_customer_id,
    v_draft.fee_amount, v_draft.fee_label, v_draft.note, p_occurred_at,
    coalesce(p_client_uuid, v_draft.client_uuid)
  );

  -- Carry the draft's named charges onto the settled sale.
  --
  -- Each keeps its own label, because "what was this ₦2,000 for?" is the question asked weeks
  -- later, and one lumped "extra charge" cannot answer it. The total moves with them, so the
  -- receipt, the customer's account and the sale itself all agree.
  insert into public.sale_charges (sale_id, label, amount, sort_order)
  select v_sale, c.label, c.amount, c.sort_order
    from public.draft_order_charges c
   where c.draft_order_id = p_draft_id;

  update public.sales s
     set total = s.total + coalesce((select sum(c.amount) from public.draft_order_charges c
                                      where c.draft_order_id = p_draft_id), 0)
   where s.id = v_sale;

  update public.draft_orders
     set status = 'settled',
         settled_by = auth.uid(),
         settled_at = now(),
         settled_sale_id = v_sale
   where id = p_draft_id;

  return v_sale;
end;
$function$
;

grant execute on function public.save_draft_order(uuid, jsonb, uuid, uuid, text, money_amt, text, text, uuid, jsonb) to authenticated;

-- The nine-argument original must go.
--
-- Adding `p_charges` with a default created a SECOND overload rather than replacing the first, and
-- PostgREST refuses every call to an ambiguous name with "function is not unique" — the same way
-- record_sale and create_or_get_academix_profile broke before. Dropping the old signature is part
-- of the change, not cleanup to do later.
drop function if exists public.save_draft_order(uuid, jsonb, uuid, uuid, text, money_amt, text, text, uuid);
