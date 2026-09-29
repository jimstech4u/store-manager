-- 0225 - The empties ONE SALE still owes
--
-- "the empties to be settled before the receipt is just the qty of empties that sale contributed,
-- not the whole empties qty the customer has — that is done from account -> empties page. So if
-- that sale has been settled, we do not see it."
--
-- `sale_empties_outstanding(sale)` is what this receipt sent out, less what has come back AGAINST
-- this receipt (`ref_table = 'sales'`, written by the receipt's own "all back" / "part"), and never
-- more than the customer still holds of that shape overall — crates brought back from the account
-- page settle the same crates, and a receipt must not offer them a second time.
--
-- The sale's own container rows are found exactly as `sale_detail`'s `empties_this_sale` finds
-- them (the sale's lines, or the old deposit ledger pointing at the sale), and a voided sale's are
-- excluded the same way, so the receipt and this can never disagree about what the sale sent out.

create or replace function public.sale_empties_outstanding(p_sale_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  base_qty        qty,
  group_id        uuid,
  group_name      text,
  side            text,
  owed            qty
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with s as (
    select id, store_id, store_customer_id from public.sales
     where id = p_sale_id and public.is_store_member(store_id)
  ),
  went_out as (
    select ce.product_id, ce.product_unit_id,
           sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as qty
      from (
        select c.* from public.customer_empties c
          join public.sale_lines sl on c.ref_table = 'sale_lines' and sl.id = c.ref_id
          join s on sl.sale_id = s.id
        union all
        select c.* from public.customer_empties c
          join public.deposit_ledger dl on c.ref_table = 'deposit_ledger' and dl.id = c.ref_id
          join s on dl.ref_table = 'sales' and dl.ref_id = s.id
      ) ce
     where coalesce(ce.side, 'they_hold') = 'they_hold'
       and not exists (select 1 from public.customer_empties v
                        where v.ref_table = 'sale_void' and v.ref_id = ce.id)
     group by ce.product_id, ce.product_unit_id
  ),
  came_back as (
    select c.product_unit_id, sum(c.qty) as qty
      from public.customer_empties c join s on c.ref_table = 'sales' and c.ref_id = s.id
     where c.direction <> 'out' and coalesce(c.side, 'they_hold') = 'they_hold'
     group by c.product_unit_id
  ),
  still_held as (
    select c.product_unit_id,
           sum(case when c.direction = 'out' then c.qty else -c.qty end) as qty
      from public.customer_empties c join s on c.store_customer_id = s.store_customer_id
     where coalesce(c.side, 'they_hold') = 'they_hold'
     group by c.product_unit_id
  )
  select w.product_id, pr.name, w.product_unit_id, su.name, su.plural, pu.base_qty,
         g.group_id, g.group_name, 'they_hold'::text,
         least(w.qty - coalesce(b.qty, 0), coalesce(h.qty, 0))::qty
    from went_out w
    join public.products pr on pr.id = w.product_id
    join public.product_units pu on pu.id = w.product_unit_id
    join public.store_units su on su.id = pu.store_unit_id
    left join came_back b on b.product_unit_id = w.product_unit_id
    left join still_held h on h.product_unit_id = w.product_unit_id
    left join lateral (
      select c.id as group_id, c.name as group_name
        from public.product_category_links l
        join public.product_categories c on c.id = l.category_id
       where l.product_id = pr.id and coalesce(c.status, 'active') = 'active'
       order by c.name
       limit 1
    ) g on true
   where least(w.qty - coalesce(b.qty, 0), coalesce(h.qty, 0)) > 0
   order by g.group_name nulls last, pr.name;
$fn$;

grant execute on function public.sale_empties_outstanding(uuid) to authenticated;

notify pgrst, 'reload schema';
