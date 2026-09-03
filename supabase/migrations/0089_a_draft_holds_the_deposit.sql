-- 0089 — A draft holds the deposit being taken, and settling passes it on
--
-- `sale_lines.deposit_charged` has existed since the empties work and `record_sale` reads it. It has
-- been zero on all 399 lines in this shop, because nothing has ever written it: the till has no way
-- to say a deposit was taken, the draft has no column to keep it in, and `settle_draft_order` does
-- not mention it.
--
-- So the money a shop collects against crates — the N125 each that is the whole reason a container
-- comes back — has been landing nowhere. The containers were recorded as owed, correctly; the cash
-- taken against them was not recorded at all, which makes the shop's own books say it is holding
-- goods it has paid nothing for and owes nothing on.
--
-- One column, sent by the till, forwarded at settling. `record_sale` (0088) turns it into the rate
-- the ledger keeps, so what the shop hands back is what the shop took.

alter table public.draft_order_lines
  add column if not exists deposit_charged money_amt not null default 0;

comment on column public.draft_order_lines.deposit_charged is
  'Money taken against this line''s returnables. NOT a rate: deposits are agreed at the counter, so '
  'this is what was actually collected, and record_sale derives the per-container figure from it. '
  'Zero is a real answer — containers can go out on trust — and is different from nobody asking.';

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
           -- THE ONE ADDITION. `record_sale` reads this to name the shape on the sale line, and
           -- to work out the base quantity when there is no pack to work it out from.
           'sale_unit_id',   l.sale_unit_id,
           'unit_price',     l.unit_price,
           'line_total',     l.line_total,
           'containers_out', l.containers_out,
           -- Forwarded to record_sale, which splits it across the line's pools and keeps the rate
           -- the money actually moved at rather than the pool's suggested one.
           'deposit_charged', l.deposit_charged
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
$function$;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public' and pr.proname in ('save_draft_order', 'settle_draft_order')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a till writer has % overloads', n;
    end if;
  end loop;
end;
$check$;
