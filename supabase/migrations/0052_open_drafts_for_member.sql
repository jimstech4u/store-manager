-- ════════════════════════════════════════════════════════════════════════════════════════════
-- The orders this member has open, wherever they left them
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Store Manager is online-first: an order exists in the shop from the moment the "+" is pressed,
-- not once it has something on it. That is what makes a till survive a flat battery — the seller
-- picks up another phone, signs in, and the three customers they were serving are still there.
--
-- Held by the caller, or held by nobody. An order a colleague is actively holding is theirs to
-- finish; one that was never claimed is loose in the shop and belongs to whoever picks it up.

create or replace function public.my_open_drafts(p_store_id uuid)
returns table (
  id            uuid,
  code          text,
  label         text,
  customer_id   uuid,
  customer_name text,
  note          text,
  fee_amount    money_amt,
  fee_label     text,
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
