-- 0193 — The deposit that never reached its sale is put back, as a correction
--
-- Sale #C96C19FB on 28 Sep 2026: N7,200 of Eva Water, a N400 charge the shop called "Something",
-- and a N400 deposit that was typed at the till, written to the draft, and then dropped. The
-- customer handed over N8,000 — exactly goods plus charge plus deposit — so nothing was ever
-- overpaid. The sale was short by the deposit it lost, and the N400 has been sitting against
-- nobody since.
--
-- 0189 closed the hole. This puts the money back in the one that fell through it.
--
-- RECORDED AS A CORRECTION, not edited quietly. The receipt as it stood is captured into
-- `sale_revisions` first, so the history screen shows what it said before and why it changed —
-- which is the whole reason a shop can trust a figure that moved after the fact.
--
-- THE CUSTOMER IS GABRIEL, named by the shop. Attached before anything else, because a deposit is
-- a ledger entry on a person and every rule here depends on there being one — the same rule the
-- returnables have always had. Without it this migration would be writing the very record 0189
-- exists to refuse.
--
-- INTO `customer_deposits`, not `deposit_ledger`. The latter is for money held against CONTAINERS
-- and is keyed by pool and rate; this line sent none out. An order-level deposit belongs where
-- `settle_draft_with_deposit` puts one, which is the customer's own deposit ledger.

do $backfill$
declare
  v_sale     uuid := 'c96c19fb-6719-4797-b706-3dd29381e80c';
  v_customer uuid := '0801df4b-c2b1-4139-8574-467398f76f49';  -- Gabriel
  v_store    uuid;
  v_rev      int;
  v_deposit  numeric := 400;
begin
  select store_id, coalesce(revision, 1) into v_store, v_rev
    from public.sales where id = v_sale;

  if v_store is null then
    raise notice 'sale % is not here; nothing to put back', v_sale;
    return;
  end if;

  -- Idempotent: if the deposit is already on the line, this has run.
  if (select coalesce(sum(deposit_charged), 0) from public.sale_lines where sale_id = v_sale) > 0
  then
    raise notice 'the deposit is already on the sale; nothing to do';
    return;
  end if;

  -- ── What the receipt said, before it is changed ─────────────────────────────────
  /*
   * THE DOCUMENT IS BUILT HERE rather than by calling `sale_document`.
   *
   * That function ends with `is_store_member`, so run as the database owner — which is what a
   * migration is — it answers NULL for every sale, and the insert failed on a not-null column.
   * The guard is right and stays; this is the same shape, built where there is no session to ask
   * about. The same trap as `customer_balance` and `sale_detail`.
   */
  insert into public.sale_revisions (sale_id, store_id, revision, document, reason)
  select v_sale, v_store, v_rev,
         jsonb_build_object(
           'sale_id',    s.id,
           'revision',   coalesce(s.revision, 1),
           'status',     s.status,
           'total',      s.total,
           'fee_amount', s.fee_amount,
           'fee_label',  s.fee_label,
           'note',       s.note,
           'occurred_at', s.occurred_at,
           'customer',   case when c.id is null then null
                              else jsonb_build_object('id', c.id, 'name', c.display_name) end,
           'lines', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'product_id',     l.product_id,
                      'product_name',   p.name,
                      'sale_unit_id',   l.sale_unit_id,
                      'unit_name',      su.name,
                      'entered_qty',    l.entered_qty,
                      'base_qty',       l.base_qty,
                      'unit_price',     l.unit_price,
                      'line_total',     l.line_total,
                      'containers_out', l.containers_out
                    ) order by p.name)
               from public.sale_lines l
               join public.products p on p.id = l.product_id
               left join public.product_units pu on pu.id = l.sale_unit_id
               left join public.store_units su on su.id = pu.store_unit_id
              where l.sale_id = s.id
           ), '[]'::jsonb)
         ),
         'A N400 deposit taken at the till was dropped on settling and never reached this '
         'receipt. Put back, with Gabriel named as the customer holding it.'
    from public.sales s
    left join public.store_customers c on c.id = s.store_customer_id
   where s.id = v_sale;

  -- ── The customer, first, because everything below needs one ─────────────────────
  update public.sales set store_customer_id = v_customer where id = v_sale;

  -- ── The deposit, onto the line it was taken against ─────────────────────────────
  update public.sale_lines
     set deposit_charged = v_deposit
   where id = (select id from public.sale_lines where sale_id = v_sale
                order by created_at limit 1);

  -- ── And the total it should always have come to ─────────────────────────────────
  --
  -- `record_sale` adds the deposit into the total — `v_total + v_line_total + v_deposit` — so
  -- N7,200 + N400 + N400 is what this sale was always worth. The tendered N8,000 covers it
  -- exactly, which is the arithmetic that gave the whole thing away.
  update public.sales
     set total = 8000, revision = v_rev + 1
   where id = v_sale;

  -- ── The payment covers all of it now ────────────────────────────────────────────
  --
  -- 0188 trimmed this allocation to the sale's understated total and left N400 unattached. With
  -- the total right, the whole payment belongs to the sale.
  update public.payment_allocations
     set amount = 8000
   where sale_id = v_sale;

  -- ── And the money is held for somebody ──────────────────────────────────────────
  insert into public.customer_deposits
    (store_id, store_customer_id, direction, amount, reason, occurred_at)
  -- 'taken', which is the word this ledger uses: taken, given back, or retained by the shop.
  values (v_store, v_customer, 'taken', v_deposit,
          'Taken on receipt #C96C19FB and recorded late', now());

  raise notice 'put back: N% held for Gabriel, sale total now 8000, revision %',
    v_deposit, v_rev + 1;
end
$backfill$;
