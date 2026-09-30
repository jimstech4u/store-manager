-- 0244 - A sale takes its own money, and a deposit paid at the till is counted once
--
-- Mr Friday, 30 Sep: goods N61,150 + POS charge N100 + a N9,950 crate deposit = N71,200, and he
-- handed over exactly N71,200. The receipt said "Left on this sale N100" with no deposit on it, and
-- his account said the shop owed HIM N9,950 — while also holding his N9,950 deposit.
--
-- 1. THE CHARGES CAME AFTER THE MONEY. `settle_draft_order` let `settle_sale` match the payments to
--    the goods, and only then added the order's charges (the POS N100) to the total. The payment
--    that would have covered it had already been matched as far as it could go, so the sale stayed
--    N100 short with the money sitting unmatched beside it. Now, once the charges are on,
--    `settle_sale_from_its_money` hands the sale any of the money given AT THAT SALE that is still
--    unmatched, up to its total.
--
-- 2. THE DEPOSIT WAS COUNTED TWICE. A deposit taken at the till arrives inside the payments — the
--    till's total includes it — and is ALSO written to the deposit ledger. The account counts every
--    payment, so the same N9,950 was his credit AND his deposit. A deposit taken with a sale now
--    writes one line more on the account, "Put down as a deposit", for the same amount at the same
--    moment: the money moves from the account into the deposit, and is counted once, as the deposit.
--    Giving it back later stays a deposit-ledger matter, exactly as it is now.
--
-- 3. THE RECEIPT NEVER SAID IT. The receipt read only the old per-line deposit. `sale_detail` and
--    `read_shared_receipt` now say what was put down as a deposit at the sale (`deposit_taken`).
--
-- 4. REPAIRED: every posted sale takes its own unmatched money (the same rule, run once); every
--    deposit taken at a sale's moment gets its "put down as a deposit" line if it has none.

-- ─── 1. A sale takes the money given at it, up to its total ─────────────────────────────────
create or replace function public.settle_sale_from_its_money(p_sale_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_sale   record;
  v_short  numeric;
  v_pay    record;
  v_take   numeric;
  v_taken  numeric := 0;
begin
  select * into v_sale from public.sales where id = p_sale_id and status = 'posted';
  if not found then
    return 0;
  end if;

  v_short := v_sale.total - coalesce((select sum(a.amount) from public.payment_allocations a
                                       where a.sale_id = p_sale_id), 0);
  if v_short <= 0 then
    return 0;
  end if;

  -- Money handed over AT this sale: same shop, same moment, same customer (or none, for a walk-in),
  -- with some of it not yet matched to anything.
  for v_pay in
    select p.id,
           p.amount - coalesce((select sum(a.amount) from public.payment_allocations a
                                 where a.payment_id = p.id), 0) as free
      from public.payments p
     where p.store_id = v_sale.store_id
       and p.occurred_at = v_sale.occurred_at
       and p.direction = 'in'
       and p.reverses_payment_id is null
       and p.store_customer_id is not distinct from v_sale.store_customer_id
       and not exists (select 1 from public.payments r where r.reverses_payment_id = p.id)
     order by p.created_at, p.id
  loop
    exit when v_short <= 0;
    continue when v_pay.free <= 0;
    v_take := least(v_pay.free, v_short);
    -- A payment already part-matched to this sale has its row topped up: one row per payment and
    -- sale (a second insert broke the unique pair and failed the whole settle).
    insert into public.payment_allocations (payment_id, sale_id, amount)
    values (v_pay.id, p_sale_id, v_take)
    on conflict (payment_id, sale_id)
    do update set amount = public.payment_allocations.amount + excluded.amount;
    v_short := v_short - v_take;
    v_taken := v_taken + v_take;
  end loop;

  return v_taken;
end;
$function$;

revoke all on function public.settle_sale_from_its_money(uuid) from public, anon, authenticated;

-- ─── settle_draft_order: charges first, then the sale takes its own money ─────────────
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

  -- The charges are on the total now; the money given at this sale covers them too (0244).
  perform public.settle_sale_from_its_money(v_sale);

  update public.draft_orders
     set status = 'settled',
         settled_by = auth.uid(),
         settled_at = now(),
         settled_sale_id = v_sale
   where id = p_draft_id;

  return v_sale;
end;
$function$;

-- ─── settle_draft_with_deposit: a deposit paid at the till is counted once ─────────────
CREATE OR REPLACE FUNCTION public.settle_draft_with_deposit(p_draft_id uuid, p_payments jsonb, p_occurred_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_client_uuid uuid DEFAULT NULL::uuid, p_deposit money_amt DEFAULT NULL::numeric, p_deposit_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_already  boolean;
  v_store    uuid;
  v_customer uuid;
  v_sale     uuid;
begin
  -- Locked, so two tills pressing the button at once queue here rather than both deciding they are
  -- the one that settles.
  select d.status = 'settled', d.store_id, d.store_customer_id
    into v_already, v_store, v_customer
    from public.draft_orders d
   where d.id = p_draft_id
     for update;

  -- The time is the server's unless one was given: `settle_draft_order` passes its argument straight
  -- through, so an explicit NULL here would reach the sale rather than fall back to its default.
  v_sale := public.settle_draft_order(
    p_draft_id, p_payments, coalesce(p_occurred_at, now()), p_client_uuid);

  if not coalesce(v_already, false) and coalesce(p_deposit, 0) > 0 then
    if v_customer is null then
      raise exception 'A deposit needs a customer to hold it for.' using errcode = '22023';
    end if;
    perform public.take_customer_deposit(v_store, v_customer, p_deposit, nullif(trim(p_deposit_reason), ''), null);
    /*
     * COUNTED ONCE (0244). The deposit came in with the payments, and the account counts every
     * payment — so the same money was their credit and their deposit. It moves from the account into
     * the deposit, at the same moment: one line saying so.
     */
    insert into public.customer_charges (store_id, store_customer_id, direction, amount, reason, occurred_at)
    values (v_store, v_customer, 'charge', p_deposit,
            'Put down as a deposit' || coalesce(' (' || nullif(trim(p_deposit_reason), '') || ')', ''),
            (select s.occurred_at from public.sales s where s.id = v_sale));
  end if;

  return v_sale;
end;
$function$;

-- ─── sale_detail: says the deposit put down at the sale ─────────────────────────────────
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

-- ─── read_shared_receipt: says the deposit put down at the sale ─────────────────────────────────
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

-- ─── 4. Repair ───────────────────────────────────────────────────────────────────────────────
-- Every posted sale takes its own unmatched money, once.
select public.settle_sale_from_its_money(s.id)
  from public.sales s
 where s.status = 'posted'
   and s.total > coalesce((select sum(a.amount) from public.payment_allocations a where a.sale_id = s.id), 0);

-- Every deposit put down at a sale's moment is moved off the account, once.
insert into public.customer_charges (store_id, store_customer_id, direction, amount, reason, occurred_at)
select cd.store_id, cd.store_customer_id, 'charge', cd.amount,
       'Put down as a deposit' || coalesce(' (' || nullif(trim(cd.reason), '') || ')', ''),
       cd.occurred_at
  from public.customer_deposits cd
 where cd.direction = 'taken'
   and exists (select 1 from public.sales s
                where s.store_customer_id = cd.store_customer_id
                  and s.occurred_at = cd.occurred_at
                  and s.status = 'posted')
   and not exists (select 1 from public.customer_charges c
                    where c.store_customer_id = cd.store_customer_id
                      and c.occurred_at = cd.occurred_at
                      and c.reason like 'Put down as a deposit%');

notify pgrst, 'reload schema';
