-- 0149 — A receipt says what is still with the customer, old and new together
--
-- «since this is a new customer, we check the outstanding money and empties … 'Still with them'
--  NBL 5, Goldberg ½, Gulder ½ … Now he buys 1.5 Goldberg and 1 Gulder … outstanding money 16,500
--  (old) + 1,000 (new) = 17,500; still with them 2 Goldberg + 3 Gulder = 5 NBL»
--
-- 0140 made "Still with you" the containers THIS sale sent out. That answers "what did I take
-- today?", which is not the question a receipt settles. The customer standing at the counter with a
-- receipt in hand wants to know where they stand: everything of the shop's they are holding, and
-- everything they owe, once this sale is on the books.
--
-- AS AT THE SALE, not as of today. A receipt reprinted next month must say what it said the day it
-- was handed over — a live balance on an old receipt makes paper disagree with itself. So both are
-- read up to the sale's own moment:
--
--   · containers — every container row for the customer on or before the sale: what earlier sales sent
--     out, less what came back or was written off, plus this sale's own. A void before the sale nets
--     its crates out; a return after it does not reach back into this receipt.
--   · money — posted sales, payments, charges and opening balances on or before the sale. The till
--     already knows what THIS sale leaves owing, so the receipt shows before, this sale, and after.
--
-- The block that listed only this sale's containers stays, renamed `empties_this_sale`, for anything
-- that wants to say "of which, today".
--
-- The live link does the same while the order is still being built: it hands over what the customer
-- already holds and owes, and the page adds this order to it.

-- ─── Containers with a customer, as at a moment ─────────────────────────────────────

create or replace function public.customer_containers_as_at(p_customer uuid, p_at timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', t.product_id,
           'product_name', t.product_name,
           'product_unit_id', t.product_unit_id,
           'unit_name', t.unit_name,
           'unit_plural', t.unit_plural,
           'base_qty', t.base_qty,
           'group_id', t.group_id,
           'group_name', t.group_name,
           'owed', t.owed
         ) order by t.group_name nulls last, t.product_name), '[]'::jsonb)
    from (
      select ce.product_id,
             pr.name   as product_name,
             ce.product_unit_id,
             su.name   as unit_name,
             su.plural as unit_plural,
             pu.base_qty,
             g.group_id,
             g.group_name,
             sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as owed
        from public.customer_empties ce
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
       where ce.store_customer_id = p_customer
         and coalesce(ce.side, 'they_hold') = 'they_hold'
         and ce.occurred_at <= p_at
       group by ce.product_id, pr.name, ce.product_unit_id, su.name, su.plural,
                pu.base_qty, g.group_id, g.group_name
      having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
    ) t;
$fn$;

revoke all on function public.customer_containers_as_at(uuid, timestamptz) from public;
-- Not granted: it answers for any customer. Reached only through the readers below, which each
-- decide who may see what.

-- ─── Money a customer owes, as at a moment ──────────────────────────────────────────
--
-- `customer_balance_total`, with every term bounded by the moment.

create or replace function public.customer_owed_as_at(p_customer uuid, p_at timestamptz)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select (
    coalesce((select sum(s.total) from public.sales s
               where s.store_customer_id = p_customer and s.status = 'posted'
                 and s.occurred_at <= p_at), 0)
    - coalesce((select sum(case when p.direction = 'in' then p.amount else -p.amount end)
                  from public.payments p
                 where p.store_customer_id = p_customer and p.occurred_at <= p_at), 0)
    + coalesce((select sum(case when c.direction = 'charge' then c.amount else -c.amount end)
                  from public.customer_charges c
                 where c.store_customer_id = p_customer and c.occurred_at <= p_at), 0)
    + coalesce((select sum(ob.amount) from public.opening_balances ob
                 where ob.store_customer_id = p_customer and ob.kind = 'debtor'
                   and ob.as_of_date <= p_at::date), 0)
  )::numeric;
$fn$;

revoke all on function public.customer_owed_as_at(uuid, timestamptz) from public;

-- ─── The till's receipt ─────────────────────────────────────────────────────────────

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
        'base_qty', sl.base_qty,
        'unit_price', sl.unit_price,
        'line_total', sl.line_total,
        'unit_cost_at_sale', sl.unit_cost_at_sale,
        'containers_out', sl.containers_out
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

-- ─── The receipt link sent to the customer ──────────────────────────────────────────

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
                    else public.customer_containers_as_at(sc.id, s.occurred_at) end,
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

    'payments', coalesce((
      select jsonb_agg(x)
        from (
          select jsonb_build_object('method', pay.method, 'amount', sum(pa.amount)) as x
            from public.payment_allocations pa
            join public.payments pay on pay.id = pa.payment_id
           where pa.sale_id = s.id
           group by pay.method
           order by pay.method
        ) grouped
    ), '[]'::jsonb),

    'paid_total', coalesce((
      select sum(pa.amount) from public.payment_allocations pa where pa.sale_id = s.id
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

-- ─── The live link, built and settled ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.public_track_token(p_token text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with found as (
    select d.*, st.name as shop_name
      from public.draft_orders d
      join public.stores st on st.id = d.store_id
     where d.share_token = trim(p_token)
  )
  select case
    when f.status = 'cancelled' then
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', 'cancelled',
        'shop', f.shop_name, 'updated_at', f.updated_at
      )

    when f.status = 'settled' then
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', 'settled',
        'shop', f.shop_name, 'updated_at', f.updated_at,
        'sale_id', f.settled_sale_id,

        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', p.name, 'qty', sl.entered_qty,
                   /*
                    * THE SHAPE IT WAS SOLD IN, said the way the seller said it.
                    *
                    * `product_packs` first, then the base unit — a customer who bought three
                    * crates was told they had bought three pieces the moment their shop defined
                    * its shapes on this software rather than inheriting packs from before 0061.
                    * Pluralised, because "3 Crate" is the sort of thing that makes a receipt look
                    * machine-made and a shop look careless.
                    */
                   'unit', coalesce(
                     case when sl.entered_qty = 1 then su.name else su.plural end,
                     pk.name, p.base_unit),
                   'unit_price', sl.unit_price, 'line_total', sl.line_total,
                   -- What has to come back, and what was taken against it.
                   'containers_out', sl.containers_out,
                   'deposit', sl.deposit_charged
                 ) order by sl.created_at)
            from public.sale_lines sl
            join public.products p on p.id = sl.product_id
            left join public.product_packs pk on pk.id = sl.entered_pack_id
            left join public.product_units pu on pu.id = sl.sale_unit_id
            left join public.store_units su on su.id = pu.store_unit_id
           where sl.sale_id = f.settled_sale_id
        ), '[]'::jsonb),

        -- What else was billed, by name. A delivery fee the customer cannot see is a delivery fee
        -- they will ring about.
        'charges', coalesce((
          select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                           order by c.sort_order)
            from public.sale_charges c where c.sale_id = f.settled_sale_id
        ), '[]'::jsonb),

        /*
         * How it was paid, by method.
         *
         * Grouped rather than listed one by one: "Cash ₦20,000, Transfer ₦9,950" is what somebody
         * checks against their own record. Bank references are deliberately NOT here — this page
         * is public to anyone holding the link.
         */
        'payments', coalesce((
          select jsonb_agg(x)
            from (
              select jsonb_build_object('method', pay.method, 'amount', sum(pa.amount)) as x
                from public.payment_allocations pa
                join public.payments pay on pay.id = pa.payment_id
               where pa.sale_id = f.settled_sale_id
               group by pay.method
               order by pay.method
            ) grouped
        ), '[]'::jsonb),

        /*
         * Empties, by CATEGORY.
         *
         * Two Gulder and two Star crates are four NBL crates — that is how the shop counts them,
         * how the depot pays for them, and therefore what the customer is holding. Listing them
         * per product would be a receipt nobody can reconcile against a stack in a yard.
         */
        /*
         * MONEY TAKEN AGAINST CONTAINERS, which appeared on no public page at all.
         *
         * A shop charging N125 a crate on ten crates has taken N1,250 that is not payment for
         * anything — it comes back when the crates do. It was in the total the customer was asked
         * for and named nowhere, so the receipt read as if the drinks cost N1,250 more than they
         * did, and the customer had no written record that the shop owes it back. That is the
         * whole point of a deposit.
         */
        'deposit_total', coalesce((
          select sum(sl.deposit_charged) from public.sale_lines sl
           where sl.sale_id = f.settled_sale_id
        ), 0),

        /*
         * STILL WITH YOU — what this sale sent out, per product shape, with its maker.
         *
         * Read from the container rows the sale wrote (`ref_table = 'sale_lines'`), net of anything
         * written back against the same lines by a correction. The counter's rule — whole ones add
         * across a maker, parts stay with their product — is applied on the page by `rollUpOwed`.
         * This used to read `deposit_ledger` pools, which no sale has written since containers moved
         * onto product shapes, so a paid order's link showed no containers at all.
         */
        -- As at the sale it became: what they held before plus what it sent out (0149).
        'empties', coalesce((
          select public.customer_containers_as_at(s.store_customer_id, s.occurred_at)
            from public.sales s
           where s.id = f.settled_sale_id and s.store_customer_id is not null
        ), '[]'::jsonb),
        'account', (
          select jsonb_build_object(
                   'owed_after', public.customer_owed_as_at(s.store_customer_id, s.occurred_at))
            from public.sales s
           where s.id = f.settled_sale_id and s.store_customer_id is not null
        ),
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
              select ce.product_id, pr.name as product_name, ce.product_unit_id,
                     su.name as unit_name, su.plural as unit_plural, pu.base_qty,
                     g.group_id, g.group_name,
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
                   where sl.sale_id = f.settled_sale_id
                  union all
                  select c.* from public.customer_empties c
                    join public.deposit_ledger dl on c.ref_table = 'deposit_ledger' and dl.id = c.ref_id
                   where dl.ref_table = 'sales' and dl.ref_id = f.settled_sale_id
                ) ce
                join public.products pr on pr.id = ce.product_id
                join public.product_units pu on pu.id = ce.product_unit_id
                join public.store_units su on su.id = pu.store_unit_id
                left join lateral (
                  select c.id as group_id, c.name as group_name
                    from public.product_category_links gl
                    join public.product_categories c on c.id = gl.category_id
                   where gl.product_id = pr.id and coalesce(c.status, 'active') = 'active'
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

        'total', coalesce((select s.total from public.sales s where s.id = f.settled_sale_id), 0),
        'paid', coalesce((
          select sum(pa.amount) from public.payment_allocations pa
           where pa.sale_id = f.settled_sale_id
        ), 0)
      )

    else
      jsonb_build_object(
        'code', f.code, 'token', f.share_token, 'status', f.status,
        'shop', f.shop_name, 'updated_at', f.updated_at,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name', p.name, 'qty', l.entered_qty,
                   -- Same shape, same words. An order watched while it is being built and the
                   -- receipt for it afterwards must not describe the same thing two ways.
                   'unit', coalesce(
                     case when l.entered_qty = 1 then su.name else su.plural end,
                     pk.name, p.base_unit),
                   'unit_price', l.unit_price, 'line_total', l.line_total,
                   'containers_out', l.containers_out
                 ) order by l.position)
            from public.draft_order_lines l
            join public.products p on p.id = l.product_id
            left join public.product_packs pk on pk.id = l.entered_pack_id
            left join public.product_units pu on pu.id = l.sale_unit_id
            left join public.store_units su on su.id = pu.store_unit_id
           where l.draft_order_id = f.id
        ), '[]'::jsonb),
        /*
         * WHAT WILL COME BACK, while the order is still being built.
         *
         * The lines sold in a shape that comes back, in that shape — so a customer watching their
         * order sees the crates they are about to take home alongside the money, before they leave.
         */
        /*
         * WHAT THEY ALREADY HOLD, AND OWE, before this order (0149). The page adds this order's
         * containers to it, so "still with you" while the order is built already says old + new.
         */
        'held_before', case when f.store_customer_id is null then '[]'::jsonb
                            else public.customer_containers_as_at(f.store_customer_id, now()) end,
        'owed_before', case when f.store_customer_id is null then null
                            else public.customer_owed_as_at(f.store_customer_id, now()) end,
        'empties', coalesce((
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
              select l.product_id, pr.name as product_name, pu.id as product_unit_id,
                     su.name as unit_name, su.plural as unit_plural, pu.base_qty,
                     g.group_id, g.group_name,
                     sum(l.entered_qty) as owed
                from public.draft_order_lines l
                join public.products pr on pr.id = l.product_id
                join public.product_units pu on pu.id = l.sale_unit_id and pu.is_returnable
                join public.store_units su on su.id = pu.store_unit_id
                left join lateral (
                  select c.id as group_id, c.name as group_name
                    from public.product_category_links gl
                    join public.product_categories c on c.id = gl.category_id
                   where gl.product_id = pr.id and coalesce(c.status, 'active') = 'active'
                   order by c.name
                   limit 1
                ) g on true
               where l.draft_order_id = f.id
               group by l.product_id, pr.name, pu.id, su.name, su.plural, pu.base_qty,
                        g.group_id, g.group_name
              having sum(l.entered_qty) > 0
            ) t
        ), '[]'::jsonb),
        'charges', coalesce((
          select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                           order by c.sort_order)
            from public.draft_order_charges c where c.draft_order_id = f.id
        ), '[]'::jsonb),
        'total', (
          coalesce((select sum(l.line_total) from public.draft_order_lines l
                     where l.draft_order_id = f.id), 0)
          + coalesce(f.fee_amount, 0)
          + coalesce((select sum(c.amount) from public.draft_order_charges c
                       where c.draft_order_id = f.id), 0)
        )
      )
  end
  from found f;
$function$;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('sale_detail', 'read_shared_receipt', 'public_track_token',
                          'customer_containers_as_at', 'customer_owed_as_at')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a receipt reader has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
