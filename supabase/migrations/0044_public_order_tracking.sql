-- =====================================================================================
-- 0044 — A buyer can watch their order being built, by code
--
-- The seller already reads an order code aloud so a colleague can take the order over. The same
-- code, given to the customer, lets them follow what is being added on their own phone with no
-- account and no app — which is the difference between "trust me, it comes to ₦86,600" and a
-- customer who has watched every line go on.
--
-- Two deliberate limits:
--
--  1. IT STOPS AT SETTLEMENT. Once the sale is posted the code returns nothing. A live order is a
--     conversation happening at a counter; a settled one is a financial record, and the way to
--     share that is the receipt link, which is separately token-gated and revocable. A code short
--     enough to read across a counter is short enough to guess, so it must not remain a key to a
--     completed transaction.
--
--  2. IT SHOWS THE ORDER, NOT THE CUSTOMER. No name, no phone, no balance, no other order. Codes
--     are five characters; anyone can try them. Nothing behind this should be worth guessing for.
-- =====================================================================================

create or replace function public.public_track_order(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'code', d.code,
    'status', d.status,
    'shop', st.name,
    'updated_at', d.updated_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', p.name,
               'qty', l.entered_qty,
               'unit', coalesce(pk.name, p.base_unit),
               'unit_price', l.unit_price,
               'line_total', l.line_total
             ) order by l.position)
        from public.draft_order_lines l
        join public.products p on p.id = l.product_id
        left join public.product_packs pk on pk.id = l.entered_pack_id
       where l.draft_order_id = d.id
    ), '[]'::jsonb),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount)
                       order by c.sort_order)
        from public.draft_order_charges c where c.draft_order_id = d.id
    ), '[]'::jsonb),
    'total', (
      coalesce((select sum(l.line_total) from public.draft_order_lines l
                 where l.draft_order_id = d.id), 0)
      + coalesce(d.fee_amount, 0)
      + coalesce((select sum(c.amount) from public.draft_order_charges c
                   where c.draft_order_id = d.id), 0)
    )
  )
  from public.draft_orders d
  join public.stores st on st.id = d.store_id
  -- Open only. A settled or cancelled order is not trackable, and the code stops working the
  -- moment money changes hands.
  where upper(d.code) = upper(trim(p_code))
    and d.status = 'open';
$fn$;

revoke all on function public.public_track_order(text) from public;
-- anon deliberately: the whole point is a customer with no account.
grant execute on function public.public_track_order(text) to anon, authenticated;
