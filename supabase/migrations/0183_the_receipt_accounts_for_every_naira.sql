-- 0183 — The shop's own receipt says what the customer's copy says
--
-- `sale_detail` feeds the till's receipt: the screen, the printer, the shared picture and the PDF.
-- It has never returned the named charges, and it has never returned the deposit.
--
-- `read_shared_receipt` — the customer's public copy of the very same sale — returns both. So the
-- two documents for one sale disagreed, and the shop's copy was the wrong one. Reported from a
-- printed roll: items N4,500, total N5,000, and no line anywhere accounting for the N500.
--
-- The client already destructures `charges` off this. It has been reading `undefined` and quietly
-- falling back to the single lumped `fee_amount`, which shops that itemise no longer write — which
-- is why this looked like "charges do not print" rather than an error.
--
-- Everything below is the live definition, byte for byte, plus the per-line deposit, `charges` and
-- `deposit_total`. Same argument list, so `create or replace` genuinely replaces: no overload.

create or replace function public.sale_detail(p_sale_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$

  select jsonb_build_object(
    'sale', to_jsonb(s) - 'store_id',
    'customer', case when sc.id is null then null else jsonb_build_object(
        'id', sc.id, 'name', sc.display_name, 'business', sc.business_name, 'phone', i.phone,
        'balance', public.customer_balance_total(sc.id)
      ) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sl.id,
        'product_id', sl.product_id,
        'product_name', p.name,
        'base_unit', p.base_unit,
        'entered_qty', sl.entered_qty,
        'pack_name', pk.name,
        'base_qty', sl.base_qty,
        'unit_price', sl.unit_price,
        'line_total', sl.line_total,
        'unit_cost_at_sale', sl.unit_cost_at_sale,
        'containers_out', sl.containers_out,
        'deposit', sl.deposit_charged
      ) order by sl.created_at)
      from public.sale_lines sl
      join public.products p on p.id = sl.product_id
      left join public.product_packs pk on pk.id = sl.entered_pack_id
      where sl.sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pay.id, 'amount', pa.amount, 'method', pay.method,
        'reference', pay.reference, 'occurred_at', pay.occurred_at
      ) order by pay.occurred_at)
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.sale_id = s.id
    ), '[]'::jsonb),
    /*
     * WHAT IT USED TO SAY, so the printed copy can own up to it.
     *
     * A customer may be holding the previous version. Revision 1 carries nothing extra, so the
     * common case is unchanged; from revision 2 the receipt says what it replaces and when, and a
     * shop that corrected a bill in the customer's favour wants that visible.
     */
    /*
     * STILL WITH YOU — what THIS receipt sent out, in the shape it went out in.
     *
     * «the reader "still with you" uses what was bought by the customer — if it is 0.5 goldberg,
     *  3 gulder, 10 big turbo, it uses that data»
     *
     * Read from the container rows the sale itself wrote (`ref_table = 'sale_lines'`), netted
     * against anything written back against the same lines — which is exactly what a correction
     * does — so an amended receipt prints what it says NOW. One row per product shape, with its
     * maker, so the screen can apply the counter's rule: whole ones add across a maker, parts stay
     * with their beer. That rule lives in `rollUpOwed`, once, rather than in SQL twice.
     *
     * This used to read `deposit_ledger` pools on the shared link and nothing at all on the till's
     * copy, so a new sale printed no containers on either.
     */
    /*
     * STILL WITH THEM, AS AT THIS SALE (0149) — everything they held before it, plus what it sent
     * out. The block below, renamed `empties_this_sale`, is what this sale alone sent out.
     */
    'empties', case when sc.id is null then '[]'::jsonb
                    else public.customer_containers_as_at(sc.id, s.occurred_at) end,
    -- What they owed once this sale was recorded, as at the sale, so a reprint next month still says
    -- what this receipt said the day it was handed over.
    'account', case when sc.id is null then null
                    else jsonb_build_object(
                           'owed_after', public.customer_owed_as_at(sc.id, s.occurred_at)) end,
    'empties_this_sale', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', t.product_id,
               'product_name', t.product_name,
               'product_unit_id', t.product_unit_id,
               'unit_name', t.unit_name,
               'unit_plural', t.unit_plural,
               'base_qty', t.base_qty,
               'group_id', t.group_id,
               'group_name', t.group_name,
               'owed', t.owed
             ) order by t.group_name nulls last, t.product_name)
        from (
          select ce.product_id,
                 pr.name  as product_name,
                 ce.product_unit_id,
                 su.name  as unit_name,
                 su.plural as unit_plural,
                 pu.base_qty,
                 g.group_id,
                 g.group_name,
                 sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as owed
            /*
             * THIS SALE'S CONTAINER ROWS, from either place they can be.
             *
             * Written by the sale itself (`sale_lines`, since 0117), or carried over from the old deposit
             * ledger (0110), where the deposit row points at the sale. 62 older receipts have theirs only
             * in the second place and printed nothing although the ledger was right.
             */
            from (
              select c.* from public.customer_empties c
                join public.sale_lines sl on c.ref_table = 'sale_lines' and sl.id = c.ref_id
               where sl.sale_id = s.id
              union all
              select c.* from public.customer_empties c
                join public.deposit_ledger dl on c.ref_table = 'deposit_ledger' and dl.id = c.ref_id
               where dl.ref_table = 'sales' and dl.ref_id = s.id
            ) ce
            join public.products pr on pr.id = ce.product_id
            join public.product_units pu on pu.id = ce.product_unit_id
            join public.store_units su on su.id = pu.store_unit_id
            left join lateral (
              select c.id as group_id, c.name as group_name
                from public.product_category_links l
                join public.product_categories c on c.id = l.category_id
               where l.product_id = pr.id and coalesce(c.status, 'active') = 'active'
               order by c.name
               limit 1
            ) g on true
           where true
             and coalesce(ce.side, 'they_hold') = 'they_hold'
             /*
              * AND NOT TAKEN BACK BY A VOID. `unowe_voided_sale` (0117) writes its reversal under
              * `ref_table = 'sale_void'` pointing at the OUT row, not at the line — so without this a
              * cancelled receipt would still list the crates as with the customer.
              */
             and not exists (
               select 1 from public.customer_empties v
                where v.ref_table = 'sale_void' and v.ref_id = ce.id
             )
           group by ce.product_id, pr.name, ce.product_unit_id, su.name, su.plural,
                    pu.base_qty, g.group_id, g.group_name
          having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
        ) t
    ), '[]'::jsonb),
    /*
     * THE NAMED CHARGES. Itemised, exactly as `read_shared_receipt` already sends them.
     *
     * This has never returned them, and the till's receipt reads `detail.charges` — so it was
     * reading `undefined`, printing nothing, and falling back to the single lumped `fee_amount`
     * which itemised shops no longer write. The customer's own web copy showed the transport and
     * the shop's printed one did not: two documents for one sale, disagreeing.
     */
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                       order by c.sort_order)
        from public.sale_charges c where c.sale_id = s.id
    ), '[]'::jsonb),
    /*
     * AND WHAT WAS TAKEN ON DEPOSIT, which never appeared on the paper at all.
     *
     * A sale of N4,500 of goods with N500 held against the crates printed a total of N5,000 with
     * nothing to explain the difference — so the receipt disagreed with its own arithmetic, and
     * the one figure a customer comes back to argue about (what they get back when the crates
     * return) was the figure that was missing.
     */
    'deposit_total', coalesce((
      select sum(sl.deposit_charged) from public.sale_lines sl where sl.sale_id = s.id
    ), 0),
    'corrected', (
      select jsonb_build_object(
               'replaced_at', r.amended_at,
               'reason',      r.reason,
               'was_total',   r.document -> 'total'
             )
        from public.sale_revisions r
       where r.sale_id = s.id
       order by r.revision desc
       limit 1
    ),
    'draft', case when d.id is null then null else jsonb_build_object(
        'code', d.code, 'created_by', d.created_by, 'settled_by', d.settled_by,
        'settled_at', d.settled_at
      ) end
  )
  from public.sales s
  left join public.store_customers sc on sc.id = s.store_customer_id
  left join public.identities i on i.id = sc.identity_id
  left join public.draft_orders d on d.settled_sale_id = s.id
  where s.id = p_sale_id
    and public.is_store_member(s.store_id);
$function$;

grant execute on function public.sale_detail(uuid) to authenticated;
