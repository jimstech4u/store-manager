-- 0206 - A receipt's payments say WHICH payment they are
--
-- `sale_document` listed what a receipt had been paid as amount, method and reference. That is
-- enough to print a receipt and nothing else: with no id, the "Correct payment" screen had no way
-- to refer to a payment already taken, so the only thing it could offer was adding another one.
--
-- Which is how Destiny's N1,600 receipt came to hold N3,200 — cash keyed by mistake, the transfer
-- added as the correction, and no way on the screen to say the cash never came. 0205 gives the
-- database `void_payment`; this gives the screen the id it needs to call it.
--
-- A JSONB shape, so `create or replace` is enough — no drop, and no risk of the overload trap that
-- a changed RETURNS TABLE column carries. Everything else is the live definition, byte for byte.

CREATE OR REPLACE FUNCTION public.sale_document(p_sale_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'sale_id',   s.id,
    'revision',  coalesce(s.revision, 1),
    'status',    s.status,
    'total',     s.total,
    'fee_amount', s.fee_amount,
    'fee_label',  s.fee_label,
    'note',      s.note,
    'occurred_at', s.occurred_at,
    'customer',  case when c.id is null then null
                      else jsonb_build_object('id', c.id, 'name', c.display_name) end,
    /*
     * THE MONEY, IN FULL — added by 0195.
     *
     * A stored revision held the sale, its lines and its total, and nothing else. So the history
     * screen drew a receipt that went from N7,200 of goods straight to a total of N8,000 with
     * nothing in between: no charge, no deposit, no payment. Reported as "the receipt looks
     * unbalanced", which is exactly what it was — the same gap 0183 closed on the live receipt,
     * still open on the stored copy of it.
     *
     * `transfer_details` comes along because an account number printed on the original is part of
     * what that version SAID, and somebody reprinting an old revision needs the paper to match.
     */
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', ch.label, 'amount', ch.amount)
                       order by ch.sort_order)
        from public.sale_charges ch where ch.sale_id = s.id), '[]'::jsonb),
    'deposit_total', coalesce((
      select sum(dl.deposit_charged) from public.sale_lines dl where dl.sale_id = s.id), 0),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               /*
                * WHICH PAYMENT, so a correction screen can take one back.
                *
                * The rows were amount, method and reference — enough to PRINT, and nothing to act
                * on. So "Correct payment" could only ever add another one, and a receipt paid
                * N1,600 in cash that was really a transfer became a receipt paid N3,200 (0205).
                */
               'payment_id', pay.id,
               'amount', pa.amount, 'method', pay.method, 'reference', pay.reference)
                       order by pay.occurred_at)
        from public.payment_allocations pa
        join public.payments pay on pay.id = pa.payment_id
       where pa.sale_id = s.id), '[]'::jsonb),
    'transfer_details', s.transfer_details,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id',   l.product_id,
               'product_name', p.name,
               'sale_unit_id', l.sale_unit_id,
               'unit_name',    su.name,
               'entered_qty',  l.entered_qty,
               'base_qty',     l.base_qty,
               'unit_price',   l.unit_price,
               'line_total',   l.line_total,
               'containers_out', l.containers_out,
               'deposit_charged', l.deposit_charged
             ) order by p.name)
        from public.sale_lines l
        join public.products p on p.id = l.product_id
        left join public.product_units pu on pu.id = l.sale_unit_id
        left join public.store_units su on su.id = pu.store_unit_id
       where l.sale_id = s.id
    ), '[]'::jsonb)
  )
    from public.sales s
    left join public.store_customers c on c.id = s.store_customer_id
   where s.id = p_sale_id
     and public.is_store_member(s.store_id);
$function$;

grant execute on function public.sale_document(uuid) to authenticated;

notify pgrst, 'reload schema';
