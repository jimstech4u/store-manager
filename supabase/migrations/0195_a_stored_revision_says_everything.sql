-- 0195 — A stored revision carries everything the receipt said
--
-- `sale_document` is the snapshot kept in `sale_revisions` every time a receipt is corrected, and
-- it held the sale, its lines and its total. Nothing else. So "What this receipt has said" drew a
-- version going from N7,200 of goods straight to a total of N8,000, with no charge, no deposit
-- and no payment between them — reported as a receipt that "looks unbalanced", which is precisely
-- what it was.
--
-- The same gap 0183 closed on the live receipt, still open on the stored copy: two documents for
-- one sale, and this time the older one was the thin one.
--
-- Charges, the deposit, the payments and the bank details the original printed. An old revision
-- is reprintable, so what it SAID has to include the account number somebody may have paid into.
--
-- Only new revisions get the full shape; ones already stored keep what they captured. The single
-- revision this shop has is rebuilt below, because it was written minutes ago by 0193 and a
-- history whose only entry is misleading is worse than no history.

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

-- ─── AND THE ONE ALREADY STORED IS LEFT ALONE ──────────────────────────────────────
--
-- The first draft of this rewrote revision 1 to the new shape, so the shop's only history entry
-- would not be the thin one. `sale_revisions` refused it: the table is append-only, and an audit
-- record that can be rewritten later is not an audit record.
--
-- That guard is right and the draft was wrong. A stored revision says what was captured at the
-- time, thin or not; the screen reading it copes with an older shape rather than the database
-- being edited to flatter it. Only corrections made from here carry the full document.
