-- 0086 — Settling an order carries the shape through to the sale
--
-- 0085 gave the draft line a shape and the sale line somewhere to keep it. This is the join between
-- them, and without it 0085 is half a fix: `settle_draft_order` composes the payload that becomes
-- the sale, and it listed six fields, none of them the shape.
--
-- It also sends no `base_qty`, which is the part that costs money rather than clarity. `record_sale`
-- falls back to `to_base_qty(product, qty, pack_id)` — and `pack_id` is the retired
-- one-pack-per-product id. A shop whose shapes were migrated from packs in 0061 still has one, so
-- the arithmetic happens to come out right. A shop that DEFINED its shapes on this software has no
-- pack at all, `to_base_qty` has nothing to multiply by, and three crates leave the shelf as three
-- bottles: the customer is billed correctly and the stock is wrong by twelve, every sale, silently.
--
-- With the shape in the payload `record_sale` derives the base quantity from it (0085), so the two
-- kinds of shop settle the same way.

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
$function$;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'settle_draft_order';
  if n <> 1 then
    raise exception 'settle_draft_order has % overloads; the till would stop settling', n;
  end if;
end;
$check$;
