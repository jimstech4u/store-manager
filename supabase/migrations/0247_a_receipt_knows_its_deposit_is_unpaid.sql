-- 0247 - A receipt knows whether the deposit put down with it has been paid
--
-- Mrs Adeola ("Woman Amstel"), 30 Sep: goods N32,150 and a N6,000 deposit, saved with no payment.
-- Corrected to take the money, the correction screen asked for N32,150 — "why didn't the deposit load
-- back?" A correction read the receipt's OLD per-line deposit (`sale_lines.deposit_charged`), which is
-- nought since deposits moved onto the order (0182); the deposit put down with the sale lives in the
-- deposit ledger, and nothing a correction reads looked there. She had handed over N38,150; N6,000 of
-- it could not be recorded, and her account showed her owing it.
--
-- `sale_deposit_unpaid(sale)`: the deposit put down with the sale, less what the money handed over
-- FOR THIS RECEIPT (at the sale, and at each of its corrections) paid beyond its goods. The
-- correction asks for it on top of what the goods still need; money paid over the goods covers it
-- (0244's "put down as a deposit" line is what it nets against), and the receipt says "Deposit still
-- to pay" until it has been. `sale_document` (the correction's reader), `sale_detail` and
-- `read_shared_receipt` say `deposit_taken` and `deposit_unpaid`.

create or replace function public.sale_deposit_unpaid(p_sale_id uuid)
returns numeric
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  with s as (select * from public.sales where id = p_sale_id),
  dep as (
    select coalesce(sum(cd.amount), 0) as d
      from public.customer_deposits cd, s
     where cd.store_customer_id = s.store_customer_id
       and cd.direction = 'taken'
       and cd.occurred_at = s.occurred_at
  ),
  money as (
    -- Handed over for THIS receipt: at the sale, or at one of its corrections.
    select p.id, p.amount
      from public.payments p, s
     where p.store_id = s.store_id
       and p.store_customer_id is not distinct from s.store_customer_id
       and p.direction = 'in'
       and p.reverses_payment_id is null
       and not exists (select 1 from public.payments r where r.reverses_payment_id = p.id)
       and (p.occurred_at = s.occurred_at
            or p.occurred_at in (select r.amended_at from public.sale_revisions r where r.sale_id = s.id))
  ),
  net as (
    select coalesce((select sum(amount) from money), 0)
         -- less what of it went to OTHER receipts (an old balance)
         - coalesce((select sum(a.amount) from public.payment_allocations a
                      where a.payment_id in (select id from money) and a.sale_id <> p_sale_id), 0)
         -- less change handed back for this sale
         - coalesce((select sum(c.amount) from public.sale_change c
                      where c.sale_id = p_sale_id and c.kind = 'given'), 0) as m,
           coalesce((select sum(a.amount) from public.payment_allocations a where a.sale_id = p_sale_id), 0) as goods_paid
  )
  select greatest(dep.d - greatest(least(dep.d, net.m - net.goods_paid), 0), 0)
    from dep, net;
$function$;
revoke all on function public.sale_deposit_unpaid(uuid) from public, anon;
grant execute on function public.sale_deposit_unpaid(uuid) to authenticated;

-- ─── Cancelling a deposit put down with a sale, from its correction ───────────────────────────
-- "The correction screen should load back the whole breakdown — deposit, charge and payment — so we
-- can press Cancel to remove one and add the corrected one." A deposit keyed by mistake is given back
-- on the deposit ledger, marked as a cancellation with the reason, and the "put down as a deposit"
-- line (0244) is reversed on the account: unpaid, they no longer owe it; paid, it is their credit.
create or replace function public.cancel_sale_deposit(p_sale_id uuid, p_reason text)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_sale public.sales;
  v_taken numeric;
  v_cancelled numeric;
  v_left numeric;
  v_held numeric;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found or v_sale.store_customer_id is null then
    raise exception 'that sale has no deposit to cancel' using errcode = '22023';
  end if;
  if not public.has_permission(v_sale.store_id, 'sales.amend') then
    raise exception 'you do not have permission to correct a sale' using errcode = '42501';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'say why' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into v_taken from public.customer_deposits
   where store_customer_id = v_sale.store_customer_id and direction = 'taken'
     and occurred_at = v_sale.occurred_at;
  select coalesce(sum(amount), 0) into v_cancelled from public.customer_deposits
   where store_customer_id = v_sale.store_customer_id and direction = 'given'
     and reason like 'Cancelled in a correction%' and occurred_at = v_sale.occurred_at;
  v_left := v_taken - v_cancelled;
  if v_left <= 0 then
    raise exception 'there is no deposit left on this sale to cancel' using errcode = '22023';
  end if;
  select coalesce(sum(case when direction = 'taken' then amount else -amount end), 0) into v_held
    from public.customer_deposits where store_customer_id = v_sale.store_customer_id;
  if v_left > v_held then
    raise exception 'only % of their deposit is still held; give the rest back from their Deposit page', v_held
      using errcode = '23514';
  end if;

  -- Dated at the sale's moment, beside what it cancels, so the receipt and the ledger agree.
  insert into public.customer_deposits (store_id, store_customer_id, direction, amount, reason, occurred_at)
  values (v_sale.store_id, v_sale.store_customer_id, 'given', v_left,
          'Cancelled in a correction: ' || btrim(p_reason), v_sale.occurred_at);
  insert into public.customer_charges (store_id, store_customer_id, direction, amount, reason, occurred_at)
  values (v_sale.store_id, v_sale.store_customer_id, 'excess', v_left,
          'Deposit cancelled in a correction: ' || btrim(p_reason), v_sale.occurred_at);
  return v_left;
end;
$function$;
revoke all on function public.cancel_sale_deposit(uuid, text) from public, anon;
grant execute on function public.cancel_sale_deposit(uuid, text) to authenticated;


-- ─── sale_detail: says the deposit still to pay ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sale_detail(p_sale_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$

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
        /*
         * THE SHAPE IT WAS SOLD IN — the word the seller chose at the counter.
         *
         * `pack_name` is the retired one-pack-per-product model and is null for everything the
         * shop sells today, so the receipt fell through to `base_unit` and printed "1 pieces"
         * over a line that was one CRATE. The customer's copy said pieces, the paper said pieces,
         * and the shape was in the row all along under `sale_unit_id`.
         */
        'unit_name', su.name,
        'unit_plural', su.plural,
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
      left join public.product_units pu on pu.id = sl.sale_unit_id
      left join public.store_units su on su.id = pu.store_unit_id
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
        -- Paid as at this version (0240): money that came later is on the account, not this paper.
        and pay.occurred_at <= public.receipt_moment(s.id)
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
                    else public.customer_containers_as_at(sc.id, public.receipt_moment(s.id)) end,
    -- What they owed once this sale was recorded, as at the sale, so a reprint next month still says
    -- what this receipt said the day it was handed over.
    'account', case when sc.id is null then null
                    else jsonb_build_object(
                           'owed_after', public.customer_owed_as_at(sc.id, public.receipt_moment(s.id))) end,
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
    -- THE CHANGE (0246): what was owed at this sale, what has been given, and how.
    'change', jsonb_build_object(
      'owed',  coalesce((select sum(c.amount) from public.sale_change c where c.sale_id = s.id and c.kind = 'owed'), 0),
      'given', coalesce((select jsonb_agg(jsonb_build_object('amount', c.amount, 'method', c.method,
                                                             'occurred_at', c.occurred_at) order by c.occurred_at)
                           from public.sale_change c where c.sale_id = s.id and c.kind = 'given'), '[]'::jsonb)
    ),
    -- And how much of it is still to be paid (0247).
    'deposit_unpaid', public.sale_deposit_unpaid(s.id),
    -- Put down as a deposit AT this sale (0244): the customer's money, held for them.
    'deposit_taken', coalesce((
      select sum(cd.amount) from public.customer_deposits cd
       where cd.store_customer_id = s.store_customer_id
         and cd.direction = 'taken'
         and cd.occurred_at = s.occurred_at
    ), 0),
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

-- ─── read_shared_receipt: says the deposit still to pay ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.read_shared_receipt(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_link record;
  v_out  jsonb;
begin
  select * into v_link
    from public.share_links
   where token = p_token
     and kind = 'receipt'
     and revoked_at is null
     and (expires_at is null or expires_at > now());

  -- Unknown, revoked and expired all answer the same, so the page cannot be used to find out
  -- whether a token ever existed.
  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'shop', jsonb_build_object(
      'name', st.name,
      'header', ss.receipt_header,
      'footer', ss.receipt_footer,
      'printer_width_mm', coalesce(ss.printer_width_mm, 80)
    ),
    'sale', jsonb_build_object(
      'id', s.id,
      'occurred_at', s.occurred_at,
      'total', s.total,
      'fee_amount', s.fee_amount,
      'fee_label', s.fee_label,
      'note', s.note,
      'transfer_details', s.transfer_details,
      /*
       * WHETHER THIS IS STILL A BILL.
       *
       * 'posted' is a live receipt. 'voided' is one the shop has cancelled — and the customer is
       * still holding it, so their copy has to say so rather than quietly going on asking for money
       * against a sale that no longer exists.
       */
      'status', s.status,
      'cancelled_reason', case when s.status = 'voided' then s.amend_reason end,
      /*
       * AND WHETHER THIS REPLACES A COPY THEY MAY STILL BE HOLDING.
       *
       * The customer is the ONE person guaranteed to have the old version — the shop sent it to
       * them. A corrected bill that looks identical to the one in their hand is how a shop ends up
       * arguing about a figure neither of them can source.
       */
      'revision', coalesce(s.revision, 1),
      'corrected', (
        select jsonb_build_object('replaced_at', r.amended_at, 'was_total', r.document -> 'total')
          from public.sale_revisions r
         where r.sale_id = s.id
         order by r.revision desc
         limit 1
      )
    ),
    'customer', case when sc.id is null then null
                     else jsonb_build_object('name', sc.display_name) end,

    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sl.id,
        'product_name', p.name,
        'base_unit', p.base_unit,
        'entered_qty', sl.entered_qty,
        'unit_name', coalesce(
          case when sl.entered_qty = 1 then su.name else su.plural end,
          pk.name),
        'unit_price', sl.unit_price,
        'line_total', sl.line_total,
        'containers_out', sl.containers_out,
        'deposit', sl.deposit_charged
      ) order by sl.created_at)
      from public.sale_lines sl
      join public.products p on p.id = sl.product_id
      left join public.product_packs pk on pk.id = sl.entered_pack_id
      left join public.product_units pu on pu.id = sl.sale_unit_id
      left join public.store_units su on su.id = pu.store_unit_id
      where sl.sale_id = s.id
    ), '[]'::jsonb),

    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                       order by c.sort_order)
        from public.sale_charges c where c.sale_id = s.id
    ), '[]'::jsonb),

    -- THE CHANGE (0246): what was owed at this sale, what has been given, and how.
    'change', jsonb_build_object(
      'owed',  coalesce((select sum(c.amount) from public.sale_change c where c.sale_id = s.id and c.kind = 'owed'), 0),
      'given', coalesce((select jsonb_agg(jsonb_build_object('amount', c.amount, 'method', c.method,
                                                             'occurred_at', c.occurred_at) order by c.occurred_at)
                           from public.sale_change c where c.sale_id = s.id and c.kind = 'given'), '[]'::jsonb)
    ),
    -- And how much of it is still to be paid (0247).
    'deposit_unpaid', public.sale_deposit_unpaid(s.id),
    -- Put down as a deposit AT this sale (0244): the customer's money, held for them.
    'deposit_taken', coalesce((
      select sum(cd.amount) from public.customer_deposits cd
       where cd.store_customer_id = s.store_customer_id
         and cd.direction = 'taken'
         and cd.occurred_at = s.occurred_at
    ), 0),
    'deposit_total', coalesce((
      select sum(sl.deposit_charged) from public.sale_lines sl where sl.sale_id = s.id
    ), 0),

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
    -- As at this sale: what they held before plus what it sent out (0149).
    'empties', case when sc.id is null then '[]'::jsonb
                    else public.customer_containers_as_at(sc.id, public.receipt_moment(s.id)) end,
    'account', case when sc.id is null then null
                    else jsonb_build_object(
                           'owed_after', public.customer_owed_as_at(sc.id, public.receipt_moment(s.id))) end,
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

    'payments', coalesce((
      select jsonb_agg(x)
        from (
          select jsonb_build_object('method', pay.method, 'amount', sum(pa.amount)) as x
            from public.payment_allocations pa
            join public.payments pay on pay.id = pa.payment_id
           where pa.sale_id = s.id
             -- Paid as at this version (0240), as the account below is.
             and pay.occurred_at <= public.receipt_moment(s.id)
           group by pay.method
           order by pay.method
        ) grouped
    ), '[]'::jsonb),

    'paid_total', coalesce((
      select sum(pa.amount) from public.payment_allocations pa
        join public.payments pay on pay.id = pa.payment_id
       where pa.sale_id = s.id and pay.occurred_at <= public.receipt_moment(s.id)
    ), 0)
  )
  into v_out
  from public.sales s
  join public.stores st on st.id = s.store_id
  left join public.store_settings ss on ss.store_id = s.store_id
  left join public.store_customers sc on sc.id = s.store_customer_id
  where s.id = v_link.ref_id;

  update public.share_links
     set view_count = view_count + 1, last_seen_at = now()
   where id = v_link.id;

  return v_out;
end;
$function$;

-- ─── sale_document: what a correction reads ───────────────────────────────────────────
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
    -- The deposit put down with the sale (the deposit ledger, 0182+) and what is still unpaid of it —
    -- what a correction must ask for beside the goods (0247).
    'deposit_taken', coalesce((
      select sum(cd.amount) from public.customer_deposits cd
       where cd.store_customer_id = s.store_customer_id
         and cd.direction = 'taken'
         and cd.occurred_at = s.occurred_at
    ), 0),
    'deposit_unpaid', public.sale_deposit_unpaid(p_sale_id),
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

notify pgrst, 'reload schema';
