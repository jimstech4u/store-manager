-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Taking over an order, resolved line by line
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Handing an order over used to be all-or-nothing: a code, and the whole thing moved. Two sellers
-- who have each been adding to a tab for the same customer need to see both lists and decide what
-- survives, so the app now shows them side by side. These are the two things it needs from the
-- database that it could not already ask for.

/**
 * One open order, with its lines, found by the code a colleague read out.
 *
 * `search_draft_orders` answers a different question — it lists orders with totals, for browsing —
 * and deliberately does not carry lines, because a list of fifty orders does not want them. This
 * fetches exactly one and does.
 *
 * Requires `sales.record` rather than mere membership: seeing what somebody else has put on a
 * receipt is the same class of thing as being able to sell, and the stockroom staff who cannot
 * sell have no reason to read a till's working order.
 */
create or replace function public.draft_order_by_code(p_store_id uuid, p_code text)
returns table (
  id            uuid,
  code          text,
  label         text,
  customer_id   uuid,
  customer_name text,
  held_by       uuid,
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

/**
 * Abandon a draft, releasing its code.
 *
 * Used when two orders are resolved into one: the side that did not survive is cancelled, and
 * because the code index is partial (`where status = 'open'`) the code goes straight back into the
 * shop's pool for the next order to take.
 *
 * A draft only ever holds intent — it moves no stock, creates no obligation and appears in no
 * ledger — so cancelling one is not the same act as voiding a sale, and does not need a reason.
 * A SETTLED order is a different matter and is refused here: once money and stock have moved, the
 * record is corrected by voiding the sale, never by deleting the thing that caused it.
 */
create or replace function public.cancel_draft_order(p_draft_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store  uuid;
  v_status text;
begin
  select store_id, status into v_store, v_status
    from public.draft_orders where id = p_draft_id;

  if v_store is null then
    raise exception 'no such order' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'sales.record') then
    raise exception 'you do not have permission to cancel an order' using errcode = '42501';
  end if;

  if v_status = 'settled' then
    raise exception 'that order has already been paid for — void the sale instead'
      using errcode = '23514';
  end if;

  -- Already cancelled is not an error. Two people resolving the same handover at once should both
  -- succeed, and both should end with the order cancelled, which is the state they each wanted.
  update public.draft_orders
     set status = 'cancelled', updated_at = now()
   where id = p_draft_id and status = 'open';
end;
$$;

grant execute on function public.cancel_draft_order(uuid) to authenticated;
