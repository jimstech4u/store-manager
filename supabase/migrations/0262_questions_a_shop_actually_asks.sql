-- 0262 - The questions a shop actually asks
--
-- "Who took Zitar and still owes for it?" "Who is holding a deposit?" "Who owes above 100k?" "Who has
-- stopped buying?" "What should I order?" Each was a walk through several screens, or a figure
-- nobody could get at all. These are readers only: nothing here writes. The People page and the
-- item's page use them, and so does the WhatsApp assistant, as the member who is asking.
--
-- list_customers keeps every argument it had, in the same order, so the app that is deployed now
-- goes on working through the moment this lands. It grows three optional filters and two columns;
-- that cannot be done with CREATE OR REPLACE, and a second overload is what stopped the till in
-- 0058, so it is dropped and made again in one transaction.

drop function public.list_customers(uuid, text, text, uuid, integer, text);

create function public.list_customers(
  p_store_id uuid,
  p_query text default null,
  p_after_name text default null,
  p_after_id uuid default null,
  p_limit integer default 30,
  p_filter text default null,
  p_min_amount numeric default null,
  p_max_amount numeric default null,
  p_quiet_days integer default null
)
 RETURNS TABLE(id uuid, identity_id uuid, display_name text, business_name text, phone text, balance money_amt,
               deposit_held money_amt, last_sale_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with q as (
    select nullif(trim(coalesce(p_query, '')), '') as term
  ),
  matched as (
    select sc.id, sc.identity_id, sc.display_name, sc.business_name, i.phone,
           public.customer_balance_total(sc.id) as balance,
           -- The same sum customers_with_deposits holds them to: taken, less given back or kept.
           coalesce((select sum(case when d.direction = 'taken' then d.amount else -d.amount end)
                       from public.customer_deposits d
                      where d.store_id = p_store_id and d.store_customer_id = sc.id), 0) as deposit_held,
           (select max(s.occurred_at) from public.sales s
             where s.store_customer_id = sc.id and s.status = 'posted') as last_sale_at,
           case
             when q.term is null then 5
             when i.phone = public.normalize_phone(q.term) then 0
             when lower(sc.display_name) = lower(q.term) then 1
             when sc.display_name ilike q.term || '%' then 2
             when sc.display_name ilike '%' || q.term || '%' then 3
             when q.term ~ '[0-9]' and i.phone like '%' || public.normalize_phone(q.term) || '%' then 3
             else 4
           end as rank,
           case
             when q.term is null then 0
             else word_similarity(q.term, sc.display_name || ' ' || coalesce(sc.business_name, ''))
           end as score
      from public.store_customers sc
      cross join q
      join public.identities i on i.id = sc.identity_id
     where sc.store_id = p_store_id
       and public.is_store_member(p_store_id)
       and (
         q.term is null
         or (q.term ~ '[0-9]' and i.phone like '%' || public.normalize_phone(q.term) || '%')
         or sc.display_name  ilike '%' || q.term || '%'
         or sc.business_name ilike '%' || q.term || '%'
         /*
          * WHAT THEY MEANT (0261), only when nobody matched as typed, so "busayo" no longer brings
          * Moturayo along with Busayo Store; word by word, so a misspelt word still finds its name.
          */
         or (not exists (
               select 1 from public.store_customers s2
                 join public.identities i2 on i2.id = s2.identity_id
                where s2.store_id = p_store_id
                  and (s2.display_name ilike '%' || q.term || '%'
                       or s2.business_name ilike '%' || q.term || '%'
                       or (q.term ~ '[0-9]' and i2.phone like '%' || public.normalize_phone(q.term) || '%')))
             and not exists (select 1 from regexp_split_to_table(q.term, '\s+') w
                              where length(w) >= 3
                                and word_similarity(w, sc.display_name || ' ' || coalesce(sc.business_name, '')) < 0.3))
       )
       and (
         p_after_name is null
         or (sc.display_name, sc.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
       )
       and (
         p_filter <> 'empties' or p_filter is null
         or exists (
           select 1 from public.customer_empties ce
            where ce.store_customer_id = sc.id and coalesce(ce.side, 'they_hold') = 'they_hold'
            group by ce.product_unit_id
           having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0)
       )
  )
  select m.id, m.identity_id, m.display_name, m.business_name, m.phone, m.balance,
         m.deposit_held::money_amt, m.last_sale_at
    from matched m
   where (p_filter is null or p_filter in ('all', 'empties')
      or (p_filter = 'owes' and m.balance > 0.005)
      or (p_filter = 'credit' and m.balance < -0.005)
      or (p_filter = 'deposit' and m.deposit_held > 0.005)
      -- Somebody who has bought and then stopped; a customer who never bought has not gone quiet.
      or (p_filter = 'quiet' and m.last_sale_at < now() - make_interval(days => coalesce(p_quiet_days, 30))))
     -- "Above 100k" of whatever the filter is about.
     and (p_min_amount is null
          or case p_filter when 'deposit' then m.deposit_held when 'credit' then -m.balance else m.balance end >= p_min_amount)
     and (p_max_amount is null
          or case p_filter when 'deposit' then m.deposit_held when 'credit' then -m.balance else m.balance end <= p_max_amount)
   order by m.rank, m.score desc, m.display_name, m.id
   limit greatest(1, least(coalesce(p_limit, 30), 100));
$function$;

/*
 * WHO TOOK THIS AND STILL OWES FOR IT — each open receipt with the item on it.
 *
 * A receipt says how much of it is open, not which item that money was for: a part-paid receipt is
 * listed whole, and the line shown is what they took of THIS item. The customer's BALANCE is the
 * last word. A payment that was not allocated, or a correction, can leave a receipt reading open for
 * somebody who has cleared what they owe, so whatever the receipts say beyond the balance is taken
 * off the oldest first, the way a payment is, and a receipt with nothing left is not listed. The
 * opposite gap is old-book debt, which sits on no receipt: `balance` still carries it.
 */
create function public.who_owes_for_product(p_store_id uuid, p_product_id uuid)
 RETURNS TABLE(sale_id uuid, occurred_at timestamptz, customer_id uuid, customer_name text, phone text,
               lines jsonb, line_total money_amt, receipt_total money_amt, open_on_receipt money_amt, balance money_amt)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with open_receipts as (
    select s.id, s.occurred_at, s.total, s.store_customer_id,
           s.total - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.sale_id = s.id), 0) as open
      from public.sales s
     where s.store_id = p_store_id
       and s.status = 'posted'
       and s.store_customer_id is not null
       and public.is_store_member(p_store_id)
  ),
  owed as (
    select o.*,
           public.customer_balance_total(o.store_customer_id) as balance,
           sum(o.open) over w as running,
           sum(o.open) over (partition by o.store_customer_id) as all_open
      from open_receipts o
     where o.open > 0.005
    window w as (partition by o.store_customer_id order by o.occurred_at, o.id)
  ),
  really as (
    select b.*,
           least(b.open, greatest(0, b.running - greatest(0, b.all_open - greatest(b.balance, 0)))) as still_open
      from owed b
  )
  select r.id, r.occurred_at, sc.id, sc.display_name, i.phone,
         l.lines, l.line_total::money_amt, r.total::money_amt, r.still_open::money_amt, r.balance
    from really r
    join public.store_customers sc on sc.id = r.store_customer_id
    join public.identities i on i.id = sc.identity_id
    join lateral (
      select jsonb_agg(jsonb_build_object('qty', sl.entered_qty, 'unit', su.name, 'base_qty', sl.base_qty, 'line_total', sl.line_total)) as lines,
             sum(sl.line_total) as line_total
        from public.sale_lines sl
        left join public.product_units pu on pu.id = sl.sale_unit_id
        left join public.store_units su on su.id = pu.store_unit_id
       where sl.sale_id = r.id and sl.product_id = p_product_id
      having count(*) > 0
    ) l on true
   where r.still_open > 0.005
   order by r.still_open desc, r.occurred_at;
$function$;

/* Who took it at all, biggest first. Walk-ins are one row with no customer. */
create function public.who_bought_product(p_store_id uuid, p_product_id uuid, p_from timestamptz default null, p_to timestamptz default null)
 RETURNS TABLE(customer_id uuid, customer_name text, phone text, sold_base qty, amount money_amt, receipts integer, last_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select sc.id, coalesce(sc.display_name, 'Walk-in customers'), i.phone,
         sum(sl.base_qty)::qty, sum(sl.line_total)::money_amt, count(distinct s.id)::int, max(s.occurred_at)
    from public.sale_lines sl
    join public.sales s on s.id = sl.sale_id
    left join public.store_customers sc on sc.id = s.store_customer_id
    left join public.identities i on i.id = sc.identity_id
   where s.store_id = p_store_id
     and sl.product_id = p_product_id
     and s.status = 'posted'
     and (p_from is null or s.occurred_at >= p_from)
     and (p_to is null or s.occurred_at < p_to)
     and public.is_store_member(p_store_id)
   group by sc.id, sc.display_name, i.phone
   order by 5 desc;
$function$;

/* What one customer takes, most money first. */
create function public.customer_items(p_store_customer_id uuid, p_from timestamptz default null, p_to timestamptz default null)
 RETURNS TABLE(product_id uuid, product_name text, sold_base qty, amount money_amt, receipts integer, last_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p.id, p.name, sum(sl.base_qty)::qty, sum(sl.line_total)::money_amt, count(distinct s.id)::int, max(s.occurred_at)
    from public.sales s
    join public.sale_lines sl on sl.sale_id = s.id
    join public.products p on p.id = sl.product_id
   where s.store_customer_id = p_store_customer_id
     and s.status = 'posted'
     and (p_from is null or s.occurred_at >= p_from)
     and (p_to is null or s.occurred_at < p_to)
     and public.is_store_member(s.store_id)
   group by p.id, p.name
   order by 4 desc;
$function$;

/*
 * WHAT WILL RUN OUT, AND WHEN. What is on the shelf against how fast it has been leaving over the
 * last `p_days`. A low-stock level says an item is low today; this says which one is gone by Friday,
 * including one still above its level that is selling fast.
 */
create function public.stock_runway(p_store_id uuid, p_days integer default 14)
 RETURNS TABLE(product_id uuid, name text, on_hand qty, sold_base qty, per_day numeric, days_left numeric, last_sold_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with sold as (
    select sl.product_id, sum(sl.base_qty) as sold_base, max(s.occurred_at) as last_at
      from public.sales s
      join public.sale_lines sl on sl.sale_id = s.id
     where s.store_id = p_store_id
       and s.status = 'posted'
       and s.occurred_at >= now() - make_interval(days => greatest(1, coalesce(p_days, 14)))
       and public.is_store_member(p_store_id)
     group by sl.product_id
  )
  select p.id, p.name, h.on_hand::qty, x.sold_base::qty,
         round(x.sold_base / greatest(1, coalesce(p_days, 14)), 2),
         round(greatest(h.on_hand, 0) / nullif(x.sold_base / greatest(1, coalesce(p_days, 14)), 0), 1),
         x.last_at
    from sold x
    join public.products p on p.id = x.product_id and p.status = 'active'
    cross join lateral (select public.stock_on_hand(p.id) as on_hand) h
   order by 6 asc nulls last;
$function$;

grant execute on function public.list_customers(uuid, text, text, uuid, integer, text, numeric, numeric, integer) to authenticated, service_role;
grant execute on function public.who_owes_for_product(uuid, uuid) to authenticated, service_role;
grant execute on function public.who_bought_product(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.customer_items(uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.stock_runway(uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';
