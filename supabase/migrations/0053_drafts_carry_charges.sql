-- ════════════════════════════════════════════════════════════════════════════════════════════
-- An order hands over IN FULL, charges included
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- `save_draft_order` has written `draft_order_charges` since 0023, and nothing ever read them
-- back. So a delivery fee survived on the device that typed it and vanished everywhere else: pick
-- the order up on another phone, or hand it to a colleague by code, and the charge was gone while
-- the items looked complete — the worst shape for a mistake about money, because nothing about the
-- screen says anything is missing.
--
-- Both readers now carry them, so an order is the same order wherever it is opened.

-- Dropped first: the shape of what these return is changing, and Postgres will not let
-- `create or replace` alter a function's OUT parameters.
drop function if exists public.my_open_drafts(uuid);

create function public.my_open_drafts(p_store_id uuid)
returns table (
  id            uuid,
  code          text,
  label         text,
  customer_id   uuid,
  customer_name text,
  note          text,
  fee_amount    money_amt,
  fee_label     text,
  charges       jsonb,
  created_at    timestamptz,
  lines         jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.id,
    d.code,
    d.label,
    d.store_customer_id,
    c.display_name,
    d.note,
    d.fee_amount,
    d.fee_label,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object('label', ch.label, 'amount', ch.amount)
                         order by ch.sort_order)
        from public.draft_order_charges ch
        where ch.draft_order_id = d.id
      ),
      '[]'::jsonb
    ),
    d.created_at,
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'product_id',   l.product_id,
                   'product_name', p.name,
                   'qty',          l.entered_qty,
                   'pack_id',      l.entered_pack_id,
                   'unit_price',   l.unit_price,
                   'line_total',   l.line_total
                 )
                 order by l.position, l.created_at
               )
        from public.draft_order_lines l
        join public.products p on p.id = l.product_id
        where l.draft_order_id = d.id
      ),
      '[]'::jsonb
    )
  from public.draft_orders d
  left join public.store_customers c on c.id = d.store_customer_id
  where d.store_id = p_store_id
    and d.status   = 'open'
    and (d.held_by = auth.uid() or d.held_by is null)
    and public.has_permission(p_store_id, 'sales.record')
  order by d.created_at;
$$;

grant execute on function public.my_open_drafts(uuid) to authenticated;

-- The same, for an order being taken over by its code.
drop function if exists public.draft_order_by_code(uuid, text);

create function public.draft_order_by_code(p_store_id uuid, p_code text)
returns table (
  id            uuid,
  code          text,
  label         text,
  customer_id   uuid,
  customer_name text,
  held_by       uuid,
  note          text,
  charges       jsonb,
  lines         jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.id,
    d.code,
    d.label,
    d.store_customer_id,
    c.display_name,
    d.held_by,
    d.note,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object('label', ch.label, 'amount', ch.amount)
                         order by ch.sort_order)
        from public.draft_order_charges ch
        where ch.draft_order_id = d.id
      ),
      '[]'::jsonb
    ),
    coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'product_id',   l.product_id,
                   'product_name', p.name,
                   'qty',          l.entered_qty,
                   'pack_id',      l.entered_pack_id,
                   'unit_price',   l.unit_price,
                   'line_total',   l.line_total
                 )
                 order by l.position, l.created_at
               )
        from public.draft_order_lines l
        join public.products p on p.id = l.product_id
        where l.draft_order_id = d.id
      ),
      '[]'::jsonb
    )
  from public.draft_orders d
  left join public.store_customers c on c.id = d.store_customer_id
  where d.store_id = p_store_id
    and d.code     = upper(trim(p_code))
    and d.status   = 'open'
    and public.has_permission(p_store_id, 'sales.record');
$$;

grant execute on function public.draft_order_by_code(uuid, text) to authenticated;
