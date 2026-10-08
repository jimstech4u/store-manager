-- 0255 - A customer's statement, for a period, to print or send
--
-- "In the customer's account page, a statement in the header actions: print a detailed account
-- statement to the printer or share it like a receipt, PDF and more — payments in, sales, items and
-- all of that — and select what we want there, filter, and a range of dates." (The owner, 8 Oct 2026.)
--
-- One read, nothing written. For the period (either end open):
--   opening   what they owed as it began (`customer_owed_as_at`, the receipts' own rule)
--   events    every move on the account inside it — `customer_history`, the account page's own list
--   items     what was on each sale inside it, by line
--   closing   what they owed as it ended, and what was still with them then
-- The page chooses which kinds go on the paper; the figures at either end are always the account's.

create or replace function public.customer_statement_detail(
  p_store_customer_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql
stable security definer
set search_path = public, pg_temp
as $function$
declare
  v_store uuid;
  v_end   timestamptz := coalesce(p_to, now());
begin
  select store_id into v_store from public.store_customers where id = p_store_customer_id;
  if v_store is null or not public.is_store_member(v_store) then
    return null;
  end if;

  return jsonb_build_object(
    'customer', (
      select jsonb_build_object('id', sc.id, 'name', sc.display_name, 'business', sc.business_name,
                                'phone', i.phone)
        from public.store_customers sc
        left join public.identities i on i.id = sc.identity_id
       where sc.id = p_store_customer_id),
    'from', p_from,
    'to', p_to,
    'opening', case when p_from is null then 0
                    else public.customer_owed_as_at(p_store_customer_id, p_from) end,
    'closing', public.customer_owed_as_at(p_store_customer_id, v_end),
    'events', coalesce((
      select jsonb_agg(to_jsonb(h) order by h.occurred_at)
        from public.customer_history(p_store_customer_id, 100000) h
       where (p_from is null or h.occurred_at >= p_from)
         and h.occurred_at < v_end
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'sale_id', sl.sale_id,
               'product_name', p.name,
               'entered_qty', sl.entered_qty,
               'unit_name', su.name,
               'unit_plural', su.plural,
               'unit_price', sl.unit_price,
               'line_total', sl.line_total) order by s.occurred_at, sl.created_at)
        from public.sales s
        join public.sale_lines sl on sl.sale_id = s.id
        join public.products p on p.id = sl.product_id
        left join public.product_units pu on pu.id = sl.sale_unit_id
        left join public.store_units su on su.id = pu.store_unit_id
       where s.store_customer_id = p_store_customer_id
         and s.status = 'posted'
         and (p_from is null or s.occurred_at >= p_from)
         and s.occurred_at < v_end
    ), '[]'::jsonb),
    'empties', public.customer_containers_as_at(p_store_customer_id, v_end)
  );
end;
$function$;
revoke all on function public.customer_statement_detail(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.customer_statement_detail(uuid, timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
