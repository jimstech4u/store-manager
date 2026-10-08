-- 0254 - Receipts put together: a VIEW, never a record
--
-- "Merging receipts does not touch the data. The records stay the same; what merge does is for
-- printing or sharing. It has its own page, not removing any rows or changing anything. Same
-- customer's sales are merged into one whole sale — if one receipt had 20 Bigi and the other 5, it
-- is 25 Bigi, the same for the other products — with the balance only once, the charges, still with
-- you, all the money and what is outstanding. A different customer is not allowed." (The owner,
-- 8 Oct 2026.)
--
-- 0253 stored the combination (`receipt_combines`) and changed what the receipts and their links
-- showed. That is undone: nothing was ever combined (the table is empty), the receipt reads its own
-- sale again, and the link reads exactly as it did before 0253 (`shared_receipt_of` is its own body,
-- word for word, kept as the one place that body lives).
--
-- `merged_receipts(ids)` reads one customer's receipts as one, writing nothing:
--   lines         the same item, in the same shape, at the same price, ADDED — 20 + 5 Bigi = 25;
--                 a different price stays its own line, because the price is part of what was sold
--   charges       every one, as each receipt has them
--   money         totals, deposits and every payment on these receipts, up to now
--   the account   what they owe and what is still with them, ONCE, as it stands now
-- `mergeable_receipts(sale)` lists the customer's standing receipts to choose from.

-- ─── 0253 out ──────────────────────────────────────────────────────────────────────────────
create or replace function public.read_shared_receipt(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
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

  v_out := public.shared_receipt_of(v_link.ref_id);

  update public.share_links
     set view_count = view_count + 1, last_seen_at = now()
   where id = v_link.id;

  return v_out;
end;
$function$;

drop function if exists public.receipt_detail(uuid);
drop function if exists public.combine_receipts(uuid[], text);
drop function if exists public.uncombine_receipt(uuid);
drop function if exists public.combinable_receipts(uuid);
drop function if exists public.combine_receipt_json(jsonb, jsonb[], uuid, timestamptz);
drop function if exists public.receipt_group_members(uuid);
drop function if exists public.receipt_group_head(uuid);
do $$
begin
  if exists (select 1 from public.receipt_combines) then
    raise exception 'receipt_combines has rows; not dropping it';
  end if;
end;
$$;
drop table if exists public.receipt_combines;

-- ─── Choosing ──────────────────────────────────────────────────────────────────────────────
create or replace function public.mergeable_receipts(p_sale_id uuid)
returns table(sale_id uuid, occurred_at timestamptz, total money_amt, outstanding money_amt,
              line_count bigint)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select s.id, s.occurred_at, s.total,
         (s.total - coalesce((select sum(pa.amount) from public.payment_allocations pa
                               where pa.sale_id = s.id), 0))::money_amt,
         (select count(*) from public.sale_lines sl where sl.sale_id = s.id)
    from public.sales me
    join public.sales s on s.store_customer_id = me.store_customer_id and s.store_id = me.store_id
   where me.id = p_sale_id
     and me.store_customer_id is not null
     and s.status = 'posted'
     and public.is_store_member(me.store_id)
   order by s.occurred_at desc
   limit 200;
$function$;
revoke all on function public.mergeable_receipts(uuid) from public, anon;
grant execute on function public.mergeable_receipts(uuid) to authenticated;

-- ─── One receipt out of several, read only ─────────────────────────────────────────────────
create or replace function public.merged_receipts(p_sale_ids uuid[])
returns jsonb
language plpgsql
stable security definer
set search_path = public, pg_temp
as $function$
declare
  v_ids   uuid[];
  v_store uuid;
  v_cust  uuid;
  v_head  record;
begin
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_sale_ids, '{}')) x where x is not null;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'choose the receipts to put together' using errcode = '22023';
  end if;
  if (select count(*) from public.sales where id = any (v_ids)) <> array_length(v_ids, 1) then
    raise exception 'one of those receipts does not exist' using errcode = 'P0002';
  end if;

  select min(store_id::text)::uuid, min(store_customer_id::text)::uuid into v_store, v_cust
    from public.sales where id = any (v_ids);
  if not public.is_store_member(v_store)
     or exists (select 1 from public.sales where id = any (v_ids) and store_id <> v_store) then
    raise exception 'those receipts are not all from your shop' using errcode = '42501';
  end if;
  if v_cust is null or exists (select 1 from public.sales where id = any (v_ids)
                                and store_customer_id is distinct from v_cust) then
    raise exception 'only one customer''s receipts can be put together, and the customer must be named'
      using errcode = '22023';
  end if;
  if exists (select 1 from public.sales where id = any (v_ids) and status <> 'posted') then
    raise exception 'a cancelled receipt cannot be put with the others' using errcode = '22023';
  end if;

  -- The newest is the one the paper is dated and numbered by.
  select * into v_head from public.sales where id = any (v_ids) order by occurred_at desc, created_at desc limit 1;

  return jsonb_build_object(
    'sale', jsonb_build_object(
      'id', v_head.id,
      'occurred_at', v_head.occurred_at,
      'total', (select sum(total) from public.sales where id = any (v_ids)),
      'fee_amount', (select coalesce(sum(fee_amount), 0) from public.sales where id = any (v_ids)),
      'fee_label', null,
      'note', null,
      'transfer_details', v_head.transfer_details,
      'revision', null,
      'status', 'posted'
    ),
    'customer', (
      select jsonb_build_object('id', sc.id, 'name', sc.display_name, 'business', sc.business_name,
                                'phone', i.phone, 'balance', public.customer_balance_total(sc.id))
        from public.store_customers sc
        left join public.identities i on i.id = sc.identity_id
       where sc.id = v_cust),
    'corrected', null,
    /*
     * THE SAME THING AT THE SAME PRICE IS ONE LINE: item, shape and price. 20 Bigi and 5 Bigi at
     * one price are 25 Bigi; at two prices they are two lines, each true.
     */
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.first_id,
               'product_id', g.product_id,
               'product_name', g.product_name,
               'base_unit', g.base_unit,
               'entered_qty', g.entered_qty,
               'pack_name', null,
               'unit_name', g.unit_name,
               'unit_plural', g.unit_plural,
               'base_qty', g.base_qty,
               'unit_price', g.unit_price,
               'line_total', g.line_total,
               'containers_out', g.containers_out,
               'deposit', g.deposit) order by g.first_at)
        from (
          select sl.product_id, p.name as product_name, p.base_unit, su.name as unit_name,
                 su.plural as unit_plural, sl.unit_price,
                 sum(sl.entered_qty) as entered_qty, sum(sl.base_qty) as base_qty,
                 sum(sl.line_total) as line_total, sum(sl.containers_out) as containers_out,
                 sum(sl.deposit_charged) as deposit,
                 min(sl.created_at) as first_at,
                 (array_agg(sl.id order by sl.created_at))[1] as first_id
            from public.sale_lines sl
            join public.products p on p.id = sl.product_id
            left join public.product_units pu on pu.id = sl.sale_unit_id
            left join public.store_units su on su.id = pu.store_unit_id
           where sl.sale_id = any (v_ids)
           group by sl.product_id, p.name, p.base_unit, sl.sale_unit_id, su.name, su.plural, sl.unit_price
        ) g
    ), '[]'::jsonb),
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object('label', c.label, 'amount', c.amount, 'note', c.note)
                       order by s.occurred_at, c.sort_order)
        from public.sale_charges c join public.sales s on s.id = c.sale_id
       where c.sale_id = any (v_ids)
    ), '[]'::jsonb),
    -- Every payment on these receipts, up to now.
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('id', pay.id, 'amount', pa.amount, 'method', pay.method,
                                          'reference', pay.reference, 'occurred_at', pay.occurred_at)
                       order by pay.occurred_at)
        from public.payment_allocations pa
        join public.payments pay on pay.id = pa.payment_id
       where pa.sale_id = any (v_ids)
    ), '[]'::jsonb),
    'change', jsonb_build_object(
      'owed',  coalesce((select sum(c.amount) from public.sale_change c
                          where c.sale_id = any (v_ids) and c.kind = 'owed'), 0),
      'given', coalesce((select jsonb_agg(jsonb_build_object('amount', c.amount, 'method', c.method,
                                                             'occurred_at', c.occurred_at) order by c.occurred_at)
                           from public.sale_change c where c.sale_id = any (v_ids) and c.kind = 'given'), '[]'::jsonb)
    ),
    'deposit_unpaid', (select coalesce(sum(public.sale_deposit_unpaid(x)), 0) from unnest(v_ids) x),
    'deposit_taken', (select coalesce(sum(public.sale_deposit_put_down(x)), 0) from unnest(v_ids) x),
    'deposit_total', coalesce((select sum(sl.deposit_charged) from public.sale_lines sl where sl.sale_id = any (v_ids)), 0),
    -- ONCE, as it stands now.
    'empties', public.customer_containers_as_at(v_cust, now()),
    'account', jsonb_build_object('owed_after', public.customer_owed_as_at(v_cust, now())),
    'merged_parts', (
      select jsonb_agg(jsonb_build_object('id', s.id, 'occurred_at', s.occurred_at, 'total', s.total)
                       order by s.occurred_at)
        from public.sales s where s.id = any (v_ids))
  );
end;
$function$;
revoke all on function public.merged_receipts(uuid[]) from public, anon;
grant execute on function public.merged_receipts(uuid[]) to authenticated;

notify pgrst, 'reload schema';
