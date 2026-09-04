-- 0095 — A cancelled receipt says so, on the customer's own copy
--
-- Found by the benchmark, in the scenario written for exactly this: void a sale and then open the
-- link the customer is holding. It opens — which is right, because they were sent a receipt for
-- ₦159,750 and somebody will ask about it, and a link that simply stops working answers nothing and
-- looks like the shop hiding.
--
-- But it reads as a live bill. Items, total, what is owed, the shop's bank account — everything a
-- customer needs to go and pay a sale that no longer exists. The shop knows it is cancelled and the
-- person holding the receipt does not.
--
-- One field, and the page can say so. Not a refusal to open, and not a blanked-out page: the record
-- of what was nearly done is the thing that answers the question.

drop function if exists public.read_shared_receipt(text);

create function public.read_shared_receipt(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
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
      'cancelled_reason', case when s.status = 'voided' then s.amend_reason end
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

    'empties', coalesce((
      select jsonb_agg(y)
        from (
          select jsonb_build_object(
                   'category', ec.name,
                   'qty', sum(case when dl.direction = 'collected' then dl.qty_units
                                   else -dl.qty_units end),
                   'deposit', sum(case when dl.direction = 'collected'
                                       then dl.qty_units * dl.deposit_per_unit
                                       else -(dl.qty_units * dl.deposit_per_unit) end)
                 ) as y
            from public.deposit_ledger dl
            join public.empties_categories ec on ec.id = dl.empties_category_id
           where dl.ref_table = 'sales' and dl.ref_id = s.id
           group by ec.name
          having sum(case when dl.direction = 'collected' then dl.qty_units
                          else -dl.qty_units end) <> 0
           order by ec.name
        ) grouped
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
$fn$;

revoke all on function public.read_shared_receipt(text) from public;
grant execute on function public.read_shared_receipt(text) to anon, authenticated;

do $check$
declare n int;
begin
  select count(*) into n from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
   where ns.nspname = 'public' and pr.proname = 'read_shared_receipt';
  if n <> 1 then
    raise exception 'read_shared_receipt has % overloads', n;
  end if;
end;
$check$;
