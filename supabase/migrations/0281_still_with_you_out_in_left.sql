-- 0281 - Still with you: what was out, what came in, what is left — and an undo counts when it undoes
--
-- "Now we get empties out and still with you, so only one has to remain, which is still with you, but
-- we make it (in/out) on the groups … and an empties setting to toggle and preview whether empties on
-- the receipt are single or grouped (default)." (12 Nov.) The paper keeps ONE empties section, "Still
-- with you", each line saying out · in · left, by maker or item by item as the shop chooses. Three
-- things are needed for it:
--
--   1. THE SHOP'S CHOICE: `store_settings.receipt_empties_grouped`, by maker unless it says otherwise.
--   2. WHAT CAME IN AT THE SALE, per item: returns against the receipt dated at or before its moment
--      (the counter records them at the sale's moment), less what was undone. "Out" is then what was
--      left plus what came in — everything that was with them at the counter.
--   3. AN UNDO COUNTS WHEN IT UNDOES. `customer_containers_as_at` — the paper's "left", as at the sale —
--      took each row on its own date, and an undo (0280) is made later than the return it undoes: a
--      crate recorded back at the counter and then "not brought back after all" still read as back on
--      the paper. New look's #22BAA745 said nothing was with them after being set to none back. An
--      undo is now dated, for this purpose, by the move it undoes: as if the return never happened.

-- ─── 1. The shop's choice ─────────────────────────────────────────────────────────────────
alter table public.store_settings
  add column if not exists receipt_empties_grouped boolean not null default true;

comment on column public.store_settings.receipt_empties_grouped is
  'Still with you on the receipt: true by maker (whole crates of a maker added up), false item by item.';

-- ─── 3. As at a moment, an undo counts at the date of what it undoes ───────────────────────
create or replace function public.customer_containers_as_at(p_customer uuid, p_at timestamptz)
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  with moves as (
    select ce.*,
           -- An undo (0280) points at the move it undoes; it takes that move's date.
           case when ce.ref_table = 'customer_empties'
                then coalesce((select t.occurred_at from public.customer_empties t where t.id = ce.ref_id),
                              ce.occurred_at)
                else ce.occurred_at end as counts_at
      from public.customer_empties ce
     where ce.store_customer_id = p_customer
       and coalesce(ce.side, 'they_hold') = 'they_hold'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', t.product_id,
           'product_name', t.product_name,
           'product_unit_id', t.product_unit_id,
           'unit_name', t.unit_name,
           'unit_plural', t.unit_plural,
           'base_qty', t.base_qty,
           'group_id', t.group_id,
           'group_name', t.group_name,
           'owed', t.owed
         ) order by t.group_name nulls last, t.product_name), '[]'::jsonb)
    from (
      -- Each beer's own containers.
      select ce.product_id,
             pr.name   as product_name,
             ce.product_unit_id,
             su.name   as unit_name,
             su.plural as unit_plural,
             pu.base_qty,
             g.group_id,
             g.group_name,
             sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as owed
        from moves ce
        join public.products pr on pr.id = ce.product_id
        join public.product_units pu on pu.id = ce.product_unit_id
        join public.store_units su on su.id = pu.store_unit_id
        left join lateral (
          select c.id as group_id, c.name as group_name
            from public.product_category_links l
            join public.product_categories c on c.id = l.category_id
           where l.product_id = pr.id and coalesce(c.status, 'active') = 'active'
           order by c.name
           limit 1
        ) g on true
       where ce.counts_at <= p_at
       group by ce.product_id, pr.name, ce.product_unit_id, su.name, su.plural,
                pu.base_qty, g.group_id, g.group_name
      having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
      union all
      -- And the maker's, entered without naming a beer (an opening balance, a book carried over).
      select null::uuid, pc.name, null::uuid, su.name, su.plural,
             public.group_unit_base_qty(pc.id, su.id),
             pc.id, pc.name,
             sum(case when ce.direction = 'out' then ce.qty else -ce.qty end)
        from moves ce
        join public.product_categories pc on pc.id = ce.category_id
        join public.store_units su on su.id = ce.store_unit_id
       where ce.product_id is null
         and ce.counts_at <= p_at
       group by pc.id, pc.name, su.id, su.name, su.plural
      having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
    ) t;
$function$;

-- ─── 2. What came in at the sale ──────────────────────────────────────────────────────────
/*
 * Per item, what came back against the receipt at or before its moment — the counter's returns,
 * this receipt's own and older crates handed in with it — less what was undone. Shaped like the
 * rows of `customer_containers_as_at` ('owed' is the quantity in), so the paper reads both alike.
 * Internal: the app reaches it through `sale_empties_in`, a shared link through `read_shared_receipt`.
 */
create or replace function public.empties_in_at_sale_of(p_sale_id uuid)
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'product_id', t.product_id,
           'product_name', t.product_name,
           'product_unit_id', t.product_unit_id,
           'unit_name', t.unit_name,
           'unit_plural', t.unit_plural,
           'base_qty', t.base_qty,
           'group_id', t.group_id,
           'group_name', t.group_name,
           'owed', t.qty
         ) order by t.group_name nulls last, t.product_name), '[]'::jsonb)
    from (
      select pr.id as product_id, pr.name as product_name, ce.product_unit_id,
             su.name as unit_name, su.plural as unit_plural, pu.base_qty,
             g.group_id, g.group_name,
             sum(ce.qty - public.empties_undone(ce.id)) as qty
        from public.sales s
        join public.customer_empties ce
          on ce.ref_table = 'sales' and ce.ref_id = s.id
        join public.product_units pu on pu.id = ce.product_unit_id
        join public.products pr on pr.id = pu.product_id
        join public.store_units su on su.id = pu.store_unit_id
        left join lateral (
          select c.id as group_id, c.name as group_name
            from public.product_category_links l
            join public.product_categories c on c.id = l.category_id
           where l.product_id = pr.id and coalesce(c.status, 'active') = 'active'
           order by c.name
           limit 1
        ) g on true
       where s.id = p_sale_id
         and ce.direction in ('returned', 'damaged')
         and coalesce(ce.side, 'they_hold') = 'they_hold'
         and coalesce(ce.reason, '') not like 'receipt corrected:%'
         and ce.occurred_at <= s.occurred_at
       group by pr.id, pr.name, ce.product_unit_id, su.name, su.plural, pu.base_qty, g.group_id, g.group_name
      having sum(ce.qty - public.empties_undone(ce.id)) > 0
    ) t;
$function$;

revoke all on function public.empties_in_at_sale_of(uuid) from public, anon, authenticated;

create or replace function public.sale_empties_in(p_sale_id uuid)
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select case when exists (select 1 from public.sales s where s.id = p_sale_id and public.is_store_member(s.store_id))
              then public.empties_in_at_sale_of(p_sale_id)
              else '[]'::jsonb end;
$function$;

revoke all on function public.sale_empties_in(uuid) from public, anon;
grant execute on function public.sale_empties_in(uuid) to authenticated;

-- ─── The customer's own copy, from a link: the same figures and the shop's choice ─────────
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
  -- 0281: what came in at the sale, and whether the shop says Still with you by maker.
  if v_out is not null then
    v_out := v_out || jsonb_build_object(
      'empties_in', public.empties_in_at_sale_of(v_link.ref_id),
      'empties_grouped', coalesce((
        select ss.receipt_empties_grouped
          from public.sales s join public.store_settings ss on ss.store_id = s.store_id
         where s.id = v_link.ref_id), true));
  end if;

  update public.share_links
     set view_count = view_count + 1, last_seen_at = now()
   where id = v_link.id;

  return v_out;
end;
$function$;
