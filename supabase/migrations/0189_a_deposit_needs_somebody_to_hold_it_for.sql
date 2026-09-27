-- 0189 — A deposit cannot be settled into nowhere
--
-- A walk-in sale went through carrying a N400 deposit on its draft. The sale never heard of it:
-- `sale_lines.deposit_charged` is zero, no ledger row was written, and the draft still holds the
-- row. The money was simply gone from the record, and nothing on the screen said so.
--
-- `settle_draft_with_deposit` has refused this from the start — "A deposit needs a customer to
-- hold it for" — and the till made sure it never got the chance, sending
-- `takenNow > 0 && order.customerId ? takenNow : 0`. With no customer the deposit became a zero
-- before it left the browser, so the guard had nothing to refuse.
--
-- The client now refuses first and says what to do about it. This is the backstop, and it goes on
-- `settle_draft_order` rather than only on the deposit variant, because that is the function the
-- till calls when it believes there is no deposit to take — the exact case that lost one.
--
-- It is the same rule the returnables already have: "The crates on this sale come back empty, so
-- it needs a customer." Money held and containers lent both come back to a person, so both need
-- one named.

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

  /*
   * A DEPOSIT NEEDS SOMEBODY TO BE HOLDING IT FOR (0189).
   *
   * `settle_draft_with_deposit` has always refused one without a customer, and the till made sure
   * it never got the chance: it replaced the figure with zero whenever no customer was attached.
   * The sale went through, the money was recorded against nobody, and nothing said so — a N400
   * deposit disappeared exactly that way, leaving a draft that still holds it and a sale that
   * never heard of it.
   *
   * The client now refuses first, with a better message. This is the backstop, and it belongs
   * HERE rather than only in the deposit variant: this is the function the till calls when it
   * thinks there is no deposit to take, which is precisely the case that lost one. A draft
   * holding a deposit cannot be settled through the door marked "no deposit".
   *
   * Worded like the rule for returnables, because it is the same rule: money and containers both
   * come back to a person, so both need one named.
   */
  if exists (select 1 from public.draft_order_deposits dp
              where dp.draft_order_id = p_draft_id and dp.amount > 0)
     and (select d2.store_customer_id from public.draft_orders d2 where d2.id = p_draft_id) is null
  then
    raise exception
      'This order holds a deposit, so it needs a customer. Add who paid it.'
      using errcode = '22023';
  end if;
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
