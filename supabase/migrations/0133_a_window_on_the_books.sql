-- 0133 — A window on the books
--
-- «we need filters, summary sections like daily, weekly, monthly, customs in the ui so we have a
--  better overview rather than just list and cards»
--
-- There was NO date filtering anywhere on the server. `list_sales(p_store_id, p_query, p_after_at,
-- p_after_id, p_limit)` has no range at all, and the sales report asked for `p_limit: 1000` and then
-- filtered to thirty days IN JAVASCRIPT.
--
-- PostgREST caps a response at 1,000 rows regardless of what is asked for. So a shop with more than
-- a thousand sales got a report that was quietly missing the rest — no error, no empty result, just
-- a window that silently stopped covering the thing being looked for. It is the same trap that cost
-- a session on the deposit probe, this time in a document somebody files and acts on.
--
-- ─── ONE VOCABULARY, RESOLVED ON THE SERVER ─────────────────────────────────────────
--
-- Every report, every list summary and every filter chip goes through `period_range`, for two
-- reasons that are both about being wrong in ways nobody notices:
--
--   THE SHOP'S DAY, NOT THE PHONE'S. `stores.timezone` is the shop's own clock, and eight seconds
--   of skew once put a delivery in the wrong counting period and wrote 147 phantom bottles into
--   stock. "Today's takings" read at seven in the morning has to agree with the calendar on the
--   wall, and a till phone is routinely minutes out and not rarely hours.
--
--   HALF-OPEN, ALWAYS. `[from, to)`. An inclusive end date double-counts the boundary day, and the
--   boundary day is the one somebody checks against the drawer.
--
-- The LABEL comes back from the server too, so the printed document and the screen say the same
-- thing and neither has to reconstruct it. A report on paper that cannot say what window it covers
-- is not evidence of anything.

create or replace function public.period_range(
  p_store_id uuid,
  p_kind     text default 'this_month',
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns table (from_at timestamptz, to_at timestamptz, label text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tz    text;
  v_today date;
  v_a     date;
  v_b     date;
begin
  select coalesce(timezone, 'UTC') into v_tz from public.stores where id = p_store_id;
  if v_tz is null then
    raise exception 'unknown shop' using errcode = 'P0002';
  end if;

  v_today := (now() at time zone v_tz)::date;

  case coalesce(p_kind, 'this_month')
    when 'today'        then v_a := v_today;                          v_b := v_today + 1;
    when 'yesterday'    then v_a := v_today - 1;                      v_b := v_today;
    when 'this_week'    then v_a := date_trunc('week', v_today)::date; v_b := v_a + 7;
    when 'last_week'    then v_a := date_trunc('week', v_today)::date - 7; v_b := v_a + 7;
    when 'this_month'   then v_a := date_trunc('month', v_today)::date; v_b := (v_a + interval '1 month')::date;
    when 'last_month'   then v_a := (date_trunc('month', v_today) - interval '1 month')::date;
                             v_b := date_trunc('month', v_today)::date;
    when 'this_quarter' then v_a := date_trunc('quarter', v_today)::date; v_b := (v_a + interval '3 months')::date;
    when 'this_year'    then v_a := date_trunc('year', v_today)::date; v_b := (v_a + interval '1 year')::date;
    when 'last_year'    then v_a := (date_trunc('year', v_today) - interval '1 year')::date;
                             v_b := date_trunc('year', v_today)::date;
    when 'last_7'       then v_a := v_today - 6;                      v_b := v_today + 1;
    when 'last_30'      then v_a := v_today - 29;                     v_b := v_today + 1;
    when 'all'          then v_a := null;                             v_b := null;
    when 'custom'       then
      /*
       * A CUSTOM RANGE IS STILL RESOLVED HERE.
       *
       * The caller sends timestamps, and they are taken as given rather than re-truncated — a
       * screen that has already asked "from which day to which day" has done the truncating with a
       * date picker the shop can see. What this branch guarantees is that the LABEL is built the
       * same way as every other one.
       */
      from_at := p_from;
      to_at   := p_to;
      label   := case
                   when p_from is null and p_to is null then 'Everything'
                   when p_from is null then 'Up to ' || to_char((p_to at time zone v_tz) - interval '1 day', 'FMDD Mon YYYY')
                   when p_to is null then 'From ' || to_char(p_from at time zone v_tz, 'FMDD Mon YYYY')
                   else to_char(p_from at time zone v_tz, 'FMDD Mon')
                        || ' – '
                        || to_char((p_to at time zone v_tz) - interval '1 day', 'FMDD Mon YYYY')
                 end;
      return next;
      return;
    else
      raise exception 'unknown period %', p_kind using errcode = '22023';
  end case;

  if v_a is null then
    from_at := null;
    to_at   := null;
    label   := 'Everything';
    return next;
    return;
  end if;

  -- Back into absolute time, at midnight in the SHOP's zone.
  from_at := v_a::timestamp at time zone v_tz;
  to_at   := v_b::timestamp at time zone v_tz;

  label := case
             when v_b = v_a + 1 then to_char(v_a, 'FMDay, FMDD Mon YYYY')
             when v_a = date_trunc('month', v_a)::date
                  and v_b = (v_a + interval '1 month')::date then to_char(v_a, 'FMMonth YYYY')
             when v_a = date_trunc('year', v_a)::date
                  and v_b = (v_a + interval '1 year')::date then to_char(v_a, 'YYYY')
             else to_char(v_a, 'FMDD Mon') || ' – ' || to_char(v_b - 1, 'FMDD Mon YYYY')
           end;
  return next;
end;
$fn$;

revoke all on function public.period_range(uuid, text, timestamptz, timestamptz) from public;
grant execute on function public.period_range(uuid, text, timestamptz, timestamptz) to authenticated;

-- ─── What a window came to ──────────────────────────────────────────────────────────

/*
 * The summary that sits ON a list rather than in a reports tab.
 *
 * «summary sections like daily, weekly, monthly, customs in the ui so we have a better overview
 *  rather than just list and cards»
 *
 * Aggregated ON THE SERVER over the whole window — not summed from the page that happens to be
 * loaded, which is exactly how the old sales report came to be wrong. A shop with 1,400 receipts in
 * a month gets the total of 1,400, not of the first thousand.
 */
create or replace function public.sales_summary(
  p_store_id uuid,
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  p_staff    uuid default null,
  p_customer uuid default null
)
returns table (
  receipts   int,
  billed     money_amt,
  paid       money_amt,
  owing      money_amt,
  voided     int,
  corrected  int,
  customers  int,
  busiest_day date
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with mine as (
    select s.*
      from public.sales s
     where s.store_id = p_store_id
       and (p_from is null or s.occurred_at >= p_from)
       and (p_to   is null or s.occurred_at <  p_to)
       and (p_staff is null or s.created_by = p_staff)
       and (p_customer is null or s.store_customer_id = p_customer)
       and public.has_permission(p_store_id, 'reports.view')
  ),
  posted as (select * from mine where status = 'posted')
  select (select count(*) from posted)::int,
         coalesce((select sum(total) from posted), 0)::money_amt,
         coalesce((select sum(a.amount)
                     from public.payment_allocations a
                     join posted p on p.id = a.sale_id), 0)::money_amt,
         (coalesce((select sum(total) from posted), 0)
          - coalesce((select sum(a.amount)
                        from public.payment_allocations a
                        join posted p on p.id = a.sale_id), 0))::money_amt,
         (select count(*) from mine where status = 'voided')::int,
         (select count(*) from mine where coalesce(revision, 1) > 1)::int,
         (select count(distinct store_customer_id) from posted
           where store_customer_id is not null)::int,
         (select (s.occurred_at at time zone coalesce(st.timezone, 'UTC'))::date
            from posted s
            join public.stores st on st.id = p_store_id
           group by 1
           order by sum(s.total) desc
           limit 1);
$fn$;

revoke all on function public.sales_summary(uuid, timestamptz, timestamptz, uuid, uuid) from public;
grant execute on function public.sales_summary(uuid, timestamptz, timestamptz, uuid, uuid) to authenticated;

-- ─── Day by day, which is how a shop reads a month ──────────────────────────────────

create or replace function public.sales_by_day(
  p_store_id uuid,
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  p_staff    uuid default null
)
returns table (day date, receipts int, billed money_amt, paid money_amt)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select (s.occurred_at at time zone coalesce(st.timezone, 'UTC'))::date as day,
         count(*)::int,
         coalesce(sum(s.total), 0)::money_amt,
         coalesce(sum((select coalesce(sum(a.amount), 0)
                         from public.payment_allocations a
                        where a.sale_id = s.id)), 0)::money_amt
    from public.sales s
    join public.stores st on st.id = s.store_id
   where s.store_id = p_store_id
     and s.status = 'posted'
     and (p_from is null or s.occurred_at >= p_from)
     and (p_to   is null or s.occurred_at <  p_to)
     and (p_staff is null or s.created_by = p_staff)
     and public.has_permission(p_store_id, 'reports.view')
   group by 1
   order by 1;
$fn$;

revoke all on function public.sales_by_day(uuid, timestamptz, timestamptz, uuid) from public;
grant execute on function public.sales_by_day(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- ─── What sold, and what it made ────────────────────────────────────────────────────

create or replace function public.sales_by_product(
  p_store_id uuid,
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns table (
  product_id   uuid,
  product_name text,
  sold_base    qty,
  receipts     int,
  revenue      money_amt,
  cost         money_amt,
  margin       money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.id, p.name,
         coalesce(sum(l.base_qty), 0)::qty,
         count(distinct l.sale_id)::int,
         coalesce(sum(l.line_total), 0)::money_amt,
         coalesce(sum(l.base_qty * l.unit_cost_at_sale), 0)::money_amt,
         /*
          * MARGIN AT THE COST CARRIED ON THE LINE, not at today's average.
          *
          * `unit_cost_at_sale` was stamped when the sale happened, which is the whole reason it
          * exists: last month's margin must not change because this month's delivery was cheaper.
          */
         (coalesce(sum(l.line_total), 0)
          - coalesce(sum(l.base_qty * l.unit_cost_at_sale), 0))::money_amt
    from public.sale_lines l
    join public.sales s on s.id = l.sale_id
    join public.products p on p.id = l.product_id
   where s.store_id = p_store_id
     and s.status = 'posted'
     and (p_from is null or s.occurred_at >= p_from)
     and (p_to   is null or s.occurred_at <  p_to)
     and public.has_permission(p_store_id, 'reports.view')
   group by p.id, p.name
   order by 5 desc;
$fn$;

revoke all on function public.sales_by_product(uuid, timestamptz, timestamptz) from public;
grant execute on function public.sales_by_product(uuid, timestamptz, timestamptz) to authenticated;

-- ─── Money in, by how it arrived ────────────────────────────────────────────────────

create or replace function public.takings_by_method(
  p_store_id uuid,
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns table (method text, payments int, amount money_amt)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p.method, count(*)::int, coalesce(sum(p.amount), 0)::money_amt
    from public.payments p
   where p.store_id = p_store_id
     and p.direction = 'in'
     and (p_from is null or p.occurred_at >= p_from)
     and (p_to   is null or p.occurred_at <  p_to)
     and public.has_permission(p_store_id, 'reports.view')
   group by p.method
   order by 3 desc;
$fn$;

revoke all on function public.takings_by_method(uuid, timestamptz, timestamptz) from public;
grant execute on function public.takings_by_method(uuid, timestamptz, timestamptz) to authenticated;

-- ─── Who owes, and for how long ─────────────────────────────────────────────────────

/*
 * Ageing, which is the report an owner asks for by name.
 *
 * The buckets are on the OLDEST unpaid receipt rather than on the balance as a whole: a customer
 * who owes ₦200,000 from last week and ₦5,000 from March has a March problem, and a single "days
 * since last payment" figure hides it.
 */
create or replace function public.debtors_aged(p_store_id uuid)
returns table (
  store_customer_id uuid,
  customer_name text,
  phone         text,
  balance       money_amt,
  oldest_at     timestamptz,
  days_old      int,
  bucket        text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with owing as (
    select c.id, c.display_name, i.phone,
           public.customer_balance(c.id) as balance,
           (select min(s.occurred_at)
              from public.sales s
             where s.store_customer_id = c.id
               and s.status = 'posted'
               and s.total > coalesce((select sum(a.amount) from public.payment_allocations a
                                        where a.sale_id = s.id), 0)) as oldest_at
      from public.store_customers c
      left join public.identities i on i.id = c.identity_id
     where c.store_id = p_store_id
       and coalesce(c.status, 'active') = 'active'
       and public.has_permission(p_store_id, 'reports.view')
  )
  select o.id, o.display_name, o.phone, o.balance, o.oldest_at,
         case when o.oldest_at is null then null
              else extract(day from now() - o.oldest_at)::int end,
         case
           when o.oldest_at is null then 'no unpaid receipt'
           when now() - o.oldest_at < interval '8 days'  then '0–7 days'
           when now() - o.oldest_at < interval '31 days' then '8–30 days'
           when now() - o.oldest_at < interval '61 days' then '31–60 days'
           else 'over 60 days'
         end
    from owing o
   where o.balance > 0
   order by o.oldest_at nulls last, o.balance desc;
$fn$;

revoke all on function public.debtors_aged(uuid) from public;
grant execute on function public.debtors_aged(uuid) to authenticated;

-- ─── The price list, for the wall ───────────────────────────────────────────────────

/*
 * Every item, every shape it sells in, and what it costs the customer.
 *
 * COST AND MARGIN NEVER APPEAR HERE. A seller printing a list for the wall must not need a
 * permission that also shows them what the shop paid — so this one is readable by anybody who may
 * sell, and the cost columns stay on the reports that are gated.
 */
create or replace function public.price_list(p_store_id uuid)
returns table (
  group_name   text,
  product_id   uuid,
  product_name text,
  unit_name    text,
  unit_plural  text,
  base_qty     qty,
  price        money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(g.name, 'Everything else'),
         p.id, p.name, su.name, su.plural, pu.base_qty, pu.sell_price
    from public.product_units pu
    join public.products p on p.id = pu.product_id
    join public.store_units su on su.id = pu.store_unit_id
    left join lateral (
      select c.name
        from public.product_category_links l
        join public.product_categories c on c.id = l.category_id
       where l.product_id = p.id and coalesce(c.status, 'active') = 'active'
       order by c.name limit 1
    ) g on true
   where p.store_id = p_store_id
     and pu.is_sold
     and coalesce(pu.sell_price, 0) > 0
     and coalesce(p.status, 'active') = 'active'
     and public.has_permission(p_store_id, 'sales.record')
   order by coalesce(g.name, 'Everything else'), p.name, pu.base_qty desc;
$fn$;

revoke all on function public.price_list(uuid) from public;
grant execute on function public.price_list(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('period_range', 'sales_summary', 'sales_by_day', 'sales_by_product',
                          'takings_by_method', 'debtors_aged', 'price_list')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a report function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
