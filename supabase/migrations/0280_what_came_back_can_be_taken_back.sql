-- 0280 - What came back can be taken back, and a receipt knows its own containers
--
-- "Give me New look's empties from the last two receipts … the empties haven't been brought back, so
-- I need to revert that." (11 Nov, on WhatsApp.) Three things stood in the way:
--
--   1. NOTHING COULD UNDO "BROUGHT BACK". A crate recorded as returned stayed returned; the only way
--      to say "they still have it" was to sell it to them again.
--   2. A RECEIPT DID NOT KNOW ITS OWN CONTAINERS. What went out with it, what came back with it and
--      what is still out were three questions with no one answer — the agent read the statement and
--      guessed, without quantities.
--   3. CORRECTING A RECEIPT LEFT WHAT CAME BACK BEHIND. New look's #D1746E61 was corrected from three
--      Amstel Malta crates to two; three stayed "brought back against this receipt", so the books say
--      they returned a crate more than they took. `correct_sale` refuses a correction once containers
--      came back against the receipt's LINES, but the counter records them against the RECEIPT.
--
-- So: an undo is its own row (the ledger is append-only — never an edit), `sale_empties` answers the
-- three questions for one receipt, and `set_sale_empties_back` sets "came back with this receipt" to a
-- figure, recording returns or undos, whichever gets there. The receipt, the correction flow and the
-- agent all use that one function.

-- ─── An undo points at what it undoes ───────────────────────────────────────────────
create index if not exists customer_empties_undo_idx
  on public.customer_empties (ref_id) where ref_table = 'customer_empties';

/** How much of a move has been undone so far. */
create or replace function public.empties_undone(p_move_id uuid)
returns qty
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(u.qty), 0)::qty from public.customer_empties u
   where u.ref_table = 'customer_empties' and u.ref_id = p_move_id;
$$;

revoke all on function public.empties_undone(uuid) from public, anon, authenticated;

/*
 * UNDO ONE MOVE, or part of it: "they did not bring those back after all". The opposite row, in the
 * same shape, on the same side, pointing at the move it undoes — so the history shows both, and the
 * move cannot be undone twice. Only a return or a write-off, and not one that moved money with it
 * (a deposit refunded) — that is corrected from Deposits, where the money is.
 */
create or replace function public.undo_empties_move(p_move_id uuid, p_qty qty default null, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_m    public.customer_empties%rowtype;
  v_left qty;
  v_qty  qty;
  v_id   uuid;
begin
  select * into v_m from public.customer_empties where id = p_move_id;
  if not found then
    raise exception 'that container record is not there' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_m.store_id, 'deposits.manage') then
    raise exception 'you do not have permission to record containers' using errcode = '42501';
  end if;
  if v_m.direction not in ('returned', 'damaged') then
    raise exception 'only a return or a write-off can be undone' using errcode = '22023';
  end if;
  if v_m.ref_table in ('customer_empties', 'sale_void', 'deposit_ledger', 'sale_lines') then
    raise exception 'that one is part of a receipt or a deposit: correct it there' using errcode = '22023';
  end if;

  v_left := v_m.qty - public.empties_undone(v_m.id);
  v_qty  := coalesce(p_qty, v_left);
  if v_qty <= 0 or v_qty > v_left then
    raise exception 'only % of that can still be undone', v_left using errcode = '22023';
  end if;

  insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                       category_id, store_unit_id, side, direction, qty, reason,
                                       ref_table, ref_id, occurred_at)
  values (v_m.store_id, v_m.store_customer_id, v_m.product_id, v_m.product_unit_id,
          v_m.category_id, v_m.store_unit_id, v_m.side, 'out', v_qty,
          coalesce(nullif(btrim(p_reason), ''),
                   case when v_m.direction = 'damaged' then 'Write-off undone' else 'Not brought back after all' end),
          'customer_empties', v_m.id, now())
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.undo_empties_move(uuid, qty, text) from public, anon;
grant execute on function public.undo_empties_move(uuid, qty, text) to authenticated;

/*
 * ONE RECEIPT'S CONTAINERS: per shape, what went out with it, what came back with it, and what is
 * still out. "Went out" is what its CURRENT lines sent (a correction's reversed lines are gone);
 * "came back" is what was recorded against the receipt or its lines, less anything undone.
 */
create or replace function public.sale_empties(p_sale_id uuid)
returns table (
  product_id uuid, product_name text, product_unit_id uuid, unit_name text, unit_plural text,
  base_qty qty, group_id uuid, group_name text, went_out qty, came_back qty, still_out qty
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with s as (
    select id from public.sales where id = p_sale_id and public.is_store_member(store_id)
  ),
  went as (
    select ce.product_id, ce.product_unit_id, sum(ce.qty) as qty
      from public.customer_empties ce
      join public.sale_lines sl on ce.ref_table = 'sale_lines' and sl.id = ce.ref_id
      join s on sl.sale_id = s.id
     where ce.direction = 'out' and coalesce(ce.side, 'they_hold') = 'they_hold'
       and not exists (select 1 from public.customer_empties v where v.ref_table = 'sale_void' and v.ref_id = ce.id)
     group by ce.product_id, ce.product_unit_id
  ),
  back as (
    select ce.product_unit_id, sum(ce.qty - public.empties_undone(ce.id)) as qty
      from public.customer_empties ce
     where ce.direction in ('returned', 'damaged') and coalesce(ce.side, 'they_hold') = 'they_hold'
       and coalesce(ce.reason, '') not like 'receipt corrected:%'
       and ((ce.ref_table = 'sales' and ce.ref_id = p_sale_id)
            or (ce.ref_table = 'sale_lines'
                and ce.ref_id in (select sl.id from public.sale_lines sl join s on sl.sale_id = s.id)))
     group by ce.product_unit_id
  ),
  units as (
    select w.product_unit_id from went w
    union
    select b.product_unit_id from back b where b.qty > 0
  )
  select pr.id, pr.name, u.product_unit_id, su.name, su.plural, pu.base_qty,
         g.group_id, g.group_name,
         coalesce(w.qty, 0)::qty, coalesce(b.qty, 0)::qty,
         greatest(coalesce(w.qty, 0) - coalesce(b.qty, 0), 0)::qty
    from units u
    join public.product_units pu on pu.id = u.product_unit_id
    join public.products pr on pr.id = pu.product_id
    join public.store_units su on su.id = pu.store_unit_id
    left join went w on w.product_unit_id = u.product_unit_id
    left join back b on b.product_unit_id = u.product_unit_id
    left join lateral (
      select c.id as group_id, c.name as group_name
        from public.product_category_links l
        join public.product_categories c on c.id = l.category_id
       where l.product_id = pr.id and coalesce(c.status, 'active') = 'active'
       order by c.name limit 1
    ) g on true
   order by g.group_name nulls last, pr.name;
$fn$;

revoke all on function public.sale_empties(uuid) from public, anon;
grant execute on function public.sale_empties(uuid) to authenticated;

/*
 * SET WHAT CAME BACK WITH THIS RECEIPT — `p_units` is [{product_unit_id, qty}], the figure each shape
 * should stand at. Up: a return against the receipt. Down: the newest returns against it undone first.
 * Never above what went out with it (older crates are the account's business, not this receipt's).
 * `p_at_sale` dates a return at the sale's own moment (at the counter, before the paper prints).
 */
create or replace function public.set_sale_empties_back(
  p_sale_id uuid,
  p_units   jsonb,
  p_reason  text default null,
  p_at_sale boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sale    public.sales%rowtype;
  v_u       record;
  v_now     record;
  v_target  qty;
  v_diff    qty;
  v_take    qty;
  v_row     record;
  v_changed int := 0;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if not found then
    raise exception 'that receipt is not there' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_sale.store_id, 'deposits.manage') then
    raise exception 'you do not have permission to record containers' using errcode = '42501';
  end if;
  if v_sale.store_customer_id is null then
    raise exception 'nobody is named on that receipt, so nobody holds its containers' using errcode = '22023';
  end if;

  for v_u in
    select (e ->> 'product_unit_id')::uuid as pu, greatest((e ->> 'qty')::numeric, 0) as qty
      from jsonb_array_elements(coalesce(p_units, '[]'::jsonb)) e
  loop
    select * into v_now from public.sale_empties(p_sale_id) x where x.product_unit_id = v_u.pu;
    if not found then
      raise exception 'that container did not go out with this receipt' using errcode = '22023';
    end if;
    v_target := v_u.qty;
    /*
     * Never ADD beyond what went out with it. What already stands above that is allowed: at the counter
     * "include what they had from before" records older crates against the new receipt, so a receipt
     * can carry more back than it sent out — those can be undone here, not added to.
     */
    if v_target > greatest(v_now.went_out, v_now.came_back) then
      raise exception 'only % % went out with this receipt', v_now.went_out, lower(v_now.unit_plural)
        using errcode = '22023';
    end if;
    v_diff := v_target - v_now.came_back;

    if v_diff > 0 then
      insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                           side, direction, qty, reason, ref_table, ref_id, occurred_at)
      values (v_sale.store_id, v_sale.store_customer_id, v_now.product_id, v_u.pu,
              'they_hold', 'returned', v_diff, 'Brought back against this receipt', 'sales', p_sale_id,
              case when p_at_sale then v_sale.occurred_at else now() end);
      v_changed := v_changed + 1;
    elsif v_diff < 0 then
      v_diff := -v_diff;
      -- The newest returns against the receipt first.
      for v_row in
        select ce.id, ce.qty - public.empties_undone(ce.id) as left_qty
          from public.customer_empties ce
         where ce.ref_table = 'sales' and ce.ref_id = p_sale_id and ce.product_unit_id = v_u.pu
           and ce.direction in ('returned', 'damaged')
         order by ce.occurred_at desc, ce.created_at desc
      loop
        exit when v_diff <= 0;
        continue when v_row.left_qty <= 0;
        v_take := least(v_row.left_qty, v_diff);
        perform public.undo_empties_move(v_row.id, v_take, p_reason);
        v_diff := v_diff - v_take;
      end loop;
      if v_diff > 0 then
        raise exception 'part of what came back was recorded on its lines: correct the receipt instead'
          using errcode = '22023';
      end if;
      v_changed := v_changed + 1;
    end if;
  end loop;

  return jsonb_build_object('changed', v_changed, 'units', (
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.sale_empties(p_sale_id) x));
end;
$$;

revoke all on function public.set_sale_empties_back(uuid, jsonb, text, boolean) from public, anon;
grant execute on function public.set_sale_empties_back(uuid, jsonb, text, boolean) to authenticated;

/*
 * Receipts CORRECTED AFTER their containers came back, which now show more back than went out (3
 * above) — for the shop to look at before anything is changed. Read only. More back than out is not
 * by itself wrong: older crates handed in at the counter are recorded against the new receipt.
 */
create or replace function public.sale_empties_mismatches(p_store_id uuid)
returns table (sale_id uuid, occurred_at timestamptz, customer text, product_name text, unit_plural text,
               went_out qty, came_back qty)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id, s.occurred_at, c.display_name, x.product_name, x.unit_plural, x.went_out, x.came_back
    from public.sales s
    join public.store_customers c on c.id = s.store_customer_id
    cross join lateral public.sale_empties(s.id) x
   where s.store_id = p_store_id and s.status = 'posted' and public.is_store_member(p_store_id)
     and x.came_back > x.went_out
     and exists (
       select 1 from public.customer_empties ce
         join public.sale_revisions r on r.sale_id = s.id and r.amended_at > ce.created_at
        where ce.ref_table = 'sales' and ce.ref_id = s.id and ce.product_unit_id = x.product_unit_id
          and ce.direction in ('returned', 'damaged')
     )
     /*
      * And everything that came back fitted inside what the receipt sent out BEFORE it was corrected:
      * then it was all this receipt's own, and the correction cut below it. More than that means older
      * crates were handed in with it, which is not a mistake.
      */
     and x.came_back <= (
       -- The old line in that same shape: the containers go out in the shape the item was sold in
       -- (the document's own containers_out is 0 since containers moved to customer_empties).
       select coalesce(sum((l ->> 'entered_qty')::numeric), 0)
         from public.sale_revisions r
         cross join lateral jsonb_array_elements(r.document -> 'lines') l
        where r.sale_id = s.id
          and r.revision = (select max(r2.revision) from public.sale_revisions r2 where r2.sale_id = s.id)
          and (l ->> 'sale_unit_id')::uuid = x.product_unit_id
     )
   order by s.occurred_at desc;
$$;

revoke all on function public.sale_empties_mismatches(uuid) from public, anon;
grant execute on function public.sale_empties_mismatches(uuid) to authenticated;

-- ─── What a receipt still owes counts undos ─────────────────────────────────────────
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
    -- 0280: less what was undone ("not brought back after all").
    select c.product_unit_id, sum(c.qty - public.empties_undone(c.id)) as qty
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

-- ─── The history: which receipt a return was against, what is undone, and what undoes ──
drop function if exists public.customer_empties_ledger(uuid);
create function public.customer_empties_ledger(p_store_customer_id uuid)
returns table (
  id uuid,
  product_name text,
  unit_name text,
  unit_plural text,
  direction text,
  qty qty,
  reason text,
  occurred_at timestamptz,
  product_id uuid,
  sale_id uuid,
  side text,
  undone qty,        -- 0280: how much of this move has been undone
  undoes uuid,       -- 0280: the move this row undoes
  can_undo boolean   -- 0280: a return or write-off made by hand or at the counter, not fully undone
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with rows as (
    select ce.*,
           case when ce.ref_table in ('sale_void', 'customer_empties') then o.ref_table else ce.ref_table end as src_table,
           case when ce.ref_table in ('sale_void', 'customer_empties') then o.ref_id else ce.ref_id end as src_id
      from public.customer_empties ce
      left join public.customer_empties o
        on ce.ref_table in ('sale_void', 'customer_empties') and o.id = ce.ref_id
     where ce.store_customer_id = p_store_customer_id
  )
  select ce.id,
         coalesce(p.name, gc.name),
         coalesce(su.name, gsu.name),
         coalesce(su.plural, gsu.plural),
         ce.direction, ce.qty, ce.reason, ce.occurred_at,
         ce.product_id,
         case ce.src_table
           when 'sale_lines' then (select sl.sale_id from public.sale_lines sl where sl.id = ce.src_id)
           when 'sales' then ce.src_id
           when 'deposit_ledger' then (
             select dl.ref_id from public.deposit_ledger dl
              where dl.id = ce.src_id and dl.ref_table = 'sales'
           )
         end,
         coalesce(ce.side, 'they_hold'),
         public.empties_undone(ce.id),
         case when ce.ref_table = 'customer_empties' then ce.ref_id end,
         ce.direction in ('returned', 'damaged')
           and coalesce(ce.ref_table, '') not in ('customer_empties', 'sale_void', 'deposit_ledger', 'sale_lines')
           and ce.qty > public.empties_undone(ce.id)
    from rows ce
    join public.store_customers c on c.id = ce.store_customer_id
    left join public.products p on p.id = ce.product_id
    left join public.product_units pu on pu.id = ce.product_unit_id
    left join public.store_units su on su.id = pu.store_unit_id
    left join public.product_categories gc on gc.id = ce.category_id
    left join public.store_units gsu on gsu.id = ce.store_unit_id
   where public.is_store_member(c.store_id)
   order by ce.occurred_at desc, ce.created_at desc;
$function$;
revoke all on function public.customer_empties_ledger(uuid) from public, anon;
grant execute on function public.customer_empties_ledger(uuid) to authenticated;

notify pgrst, 'reload schema';
