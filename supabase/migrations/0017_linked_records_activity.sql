-- =====================================================================================
-- 0017 — Linked records, the activity log, and a printer width that is not a fixed list
--
-- Three requirements from the same conversation:
--
--  · Records must pull each other up. Opening a customer with an outstanding balance should show
--    the receipts that BUILT that balance, each openable — and from a receipt you should be able
--    to get back to the customer. A number with no way to see what produced it is exactly what
--    people distrust about accounting software, and the reason they keep a paper book beside it.
--
--  · A change log of everything, with timestamps: stock drops, amounts, sales, actions. The
--    audit trail already records document edits; this unifies it with the movement ledger and
--    the money ledger into one timeline a person can actually read.
--
--  · Printer width configurable like a PC print dialog, not a hardcoded 40/100.
-- =====================================================================================

-- ─── Printer width: free value with presets ─────────────────────────────────────────
--
-- Was an enum of four widths. Real thermal printers come in more sizes than any list will hold,
-- and a shop that buys one outside the list would simply be stuck. Stored as millimetres, with
-- the UI offering the common sizes as shortcuts — which is how a print dialog behaves.

alter table public.store_settings
  add column if not exists printer_width_mm numeric(6,1) not null default 80;

-- Carry over whatever the old enum held, so nobody's setting is silently reset.
update public.store_settings
   set printer_width_mm = case printer_width
                            when '40mm'  then 40
                            when '58mm'  then 58
                            when '80mm'  then 80
                            when '100mm' then 100
                            else 80
                          end
 where printer_width is not null;

alter table public.store_settings drop constraint if exists store_settings_printer_width_check;
alter table public.store_settings
  add constraint store_settings_printer_width_mm_check
  check (printer_width_mm >= 30 and printer_width_mm <= 250);

-- ─── A customer's balance, broken down ──────────────────────────────────────────────
--
-- Every sale that contributed, what has been paid against it, and what remains — so the
-- outstanding figure can be opened up rather than taken on trust.

create or replace function public.customer_statement(
  p_store_customer_id uuid,
  p_limit int default 100
)
returns table (
  sale_id      uuid,
  occurred_at  timestamptz,
  total        money_amt,
  paid         money_amt,
  outstanding  money_amt,
  line_count   bigint,
  note         text,
  settled_by   uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id,
         s.occurred_at,
         s.total,
         coalesce(pa.paid, 0)::money_amt,
         (s.total - coalesce(pa.paid, 0))::money_amt,
         (select count(*) from public.sale_lines sl where sl.sale_id = s.id),
         s.note,
         d.settled_by
  from public.sales s
  join public.store_customers sc on sc.id = s.store_customer_id
  left join lateral (
    select sum(amount) as paid from public.payment_allocations where sale_id = s.id
  ) pa on true
  left join public.draft_orders d on d.settled_sale_id = s.id
  where s.store_customer_id = p_store_customer_id
    and s.status = 'posted'
    and public.is_store_member(sc.store_id)
  order by s.occurred_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- ─── One receipt, in full ───────────────────────────────────────────────────────────
--
-- Everything needed to display or reprint a receipt in a single call: the sale, its lines, its
-- payments, and the customer. Assembling this from four client queries would show the header
-- before the lines on a slow connection, which reads as a broken receipt.

create or replace function public.sale_detail(p_sale_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- ─── Everything a product has ever done ─────────────────────────────────────────────

create or replace function public.product_history(
  p_product_id uuid,
  p_limit int default 100
)
returns table (
  at          timestamptz,
  kind        text,
  qty_delta   qty,
  unit_cost   unit_cost,
  ref_table   text,
  ref_id      uuid,
  note        text,
  actor       uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.occurred_at, m.kind, m.qty_delta, m.unit_cost, m.ref_table, m.ref_id,
         m.note, m.created_by
  from public.stock_movements m
  join public.products p on p.id = m.product_id
  where m.product_id = p_product_id
    and public.is_store_member(p.store_id)
  order by m.occurred_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- ─── The change log ─────────────────────────────────────────────────────────────────
--
-- One readable timeline over three sources that each hold part of the truth: the movement
-- ledger (stock in and out), the money ledger (payments), and the audit trail (edits to
-- documents). Kept as a query rather than a fourth table so it cannot fall out of step with
-- the records it describes — a log written separately is a log that can disagree.

create or replace function public.activity_feed(
  p_store_id uuid,
  p_limit    int default 100,
  p_since    timestamptz default null
)
returns table (
  at        timestamptz,
  source    text,
  kind      text,
  summary   text,
  amount    money_amt,
  qty       qty,
  ref_table text,
  ref_id    uuid,
  actor     uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select * from (
    -- Stock in and out.
    -- Columns are aliased here because a UNION takes its names from the FIRST branch, and the
    -- outer `order by at` needs one to refer to.
    select m.occurred_at  as at,
           'stock'::text  as source,
           m.kind         as kind,
           p.name         as summary,
           null::money_amt as amount,
           m.qty_delta    as qty,
           m.ref_table    as ref_table,
           m.ref_id       as ref_id,
           m.created_by   as actor
    from public.stock_movements m
    join public.products p on p.id = m.product_id
    where m.store_id = p_store_id
      and (p_since is null or m.occurred_at >= p_since)

    union all

    -- Money in and out
    select pay.occurred_at,
           'payment'::text,
           pay.method,
           coalesce(sc.display_name, 'Walk-in'),
           case when pay.direction = 'in' then pay.amount else -pay.amount end,
           null::qty,
           'payments'::text,
           pay.id,
           pay.created_by
    from public.payments pay
    left join public.store_customers sc on sc.id = pay.store_customer_id
    where pay.store_id = p_store_id
      and (p_since is null or pay.occurred_at >= p_since)

    union all

    -- Edits and corrections to documents
    select a.at,
           'change'::text,
           a.table_name || ':' || a.op,
           coalesce(a.reason, a.table_name),
           null::money_amt,
           null::qty,
           a.table_name,
           a.record_id,
           a.actor
    from public.audit_log a
    where a.store_id = p_store_id
      and (p_since is null or a.at >= p_since)
  ) feed
  where public.is_store_member(p_store_id)
  order by at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

grant execute on function public.customer_statement(uuid, int)             to authenticated;
grant execute on function public.sale_detail(uuid)                         to authenticated;
grant execute on function public.product_history(uuid, int)                to authenticated;
grant execute on function public.activity_feed(uuid, int, timestamptz)     to authenticated;
