-- 0253 - Receipts combined into one
--
-- "Merging receipts should be possible: I have done one for the customer and then another one, and
-- sending two to a customer that both carry the balance and still with you makes the customer
-- think it is more than it is." (The owner, 6 Oct 2026; the options are chosen per merge, the NEW
-- receipt is the one that stays, and any receipts of the customer can be combined.)
--
-- COMBINED, NOT REWRITTEN. Each sale stays exactly as it was recorded — its lines, its stock, its
-- payments, its empties, its day in the reports. What changes is the PAPER: the newest receipt of
-- the group prints and shares as one document holding all of them, and says the customer's balance
-- and what is still with them ONCE, as at the latest of them. The others say they are part of it,
-- and their links open it. Taken apart again, every receipt reads as it did.
--
--   receipt_combines        which receipt is combined into which (undone, never deleted)
--   receipt_group_head      the receipt a sale prints under (itself when it is not combined)
--   receipt_group_members   the head and what is combined into it, oldest first, still posted
--   combine_receipts        combine any of one customer's receipts; the newest is the head
--   uncombine_receipt       take one out, or take a whole group apart from its head
--   combinable_receipts     the customer's receipts, for choosing
--   receipt_detail          the till's receipt: `sale_detail`, plus the combined paper
--   shared_receipt_of       the customer's link for one sale (read_shared_receipt's body, verbatim)
--   read_shared_receipt     the link, combined when the receipt is

create table if not exists public.receipt_combines (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id),
  into_sale_id  uuid not null references public.sales(id),
  from_sale_id  uuid not null references public.sales(id),
  reason        text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  undone_at     timestamptz,
  undone_by     uuid,
  constraint receipt_combines_not_itself check (into_sale_id <> from_sale_id)
);

-- A receipt is in one group at a time.
create unique index if not exists receipt_combines_one_home
  on public.receipt_combines (from_sale_id) where undone_at is null;
create index if not exists receipt_combines_into
  on public.receipt_combines (into_sale_id) where undone_at is null;

alter table public.receipt_combines enable row level security;
drop policy if exists receipt_combines_read on public.receipt_combines;
create policy receipt_combines_read on public.receipt_combines
  for select using (public.is_store_member(store_id));
-- Written only through the functions below.

-- ─── The group ──────────────────────────────────────────────────────────────────────────────
create or replace function public.receipt_group_head(p_sale_id uuid)
returns uuid
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select coalesce((
    select rc.into_sale_id
      from public.receipt_combines rc
      join public.sales h on h.id = rc.into_sale_id
      join public.sales f on f.id = rc.from_sale_id
     where rc.from_sale_id = p_sale_id
       and rc.undone_at is null
       -- A cancelled head holds nothing; a cancelled part is in nothing.
       and h.status = 'posted' and f.status = 'posted'
     limit 1
  ), p_sale_id);
$function$;

create or replace function public.receipt_group_members(p_head uuid)
returns table(sale_id uuid, occurred_at timestamptz)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select s.id, s.occurred_at
    from public.sales s
   where s.id = p_head
      or (s.status = 'posted'
          and exists (select 1 from public.sales h where h.id = p_head and h.status = 'posted')
          and s.id in (select rc.from_sale_id from public.receipt_combines rc
                        where rc.into_sale_id = p_head and rc.undone_at is null))
   order by s.occurred_at, s.created_at;
$function$;

-- ─── One paper out of several ───────────────────────────────────────────────────────────────
/*
 * THE PARTS, ADDED UP — the same for the till's reading and the customer's link, whose keys it
 * reads where they exist. Lines, charges, payments, change and what each receipt sent out are put
 * one after the other, oldest receipt first, each line saying which receipt it is from; money is
 * added; and the account — what they owe, what is still with them — is read ONCE, as at the
 * latest moment in the group, which is the whole point.
 */
create or replace function public.combine_receipt_json(
  p_head jsonb,
  p_parts jsonb[],
  p_customer uuid,
  p_moment timestamptz
)
returns jsonb
language plpgsql
stable security definer
set search_path = public, pg_temp
as $function$
declare
  v_out  jsonb := p_head;
  v_sum  numeric;
begin
  -- Arrays, end to end; each line knows its receipt.
  v_out := jsonb_set(v_out, '{lines}', coalesce((
    select jsonb_agg(l.value || jsonb_build_object(
             'receipt_id', p.part -> 'sale' ->> 'id',
             'receipt_at', p.part -> 'sale' ->> 'occurred_at')
           order by p.ord, l.ord)
      from unnest(p_parts) with ordinality as p(part, ord),
           jsonb_array_elements(coalesce(p.part -> 'lines', '[]'::jsonb)) with ordinality as l(value, ord)
  ), '[]'::jsonb));

  v_out := jsonb_set(v_out, '{charges}', coalesce((
    select jsonb_agg(c.value order by p.ord, c.ord)
      from unnest(p_parts) with ordinality as p(part, ord),
           jsonb_array_elements(coalesce(p.part -> 'charges', '[]'::jsonb)) with ordinality as c(value, ord)
  ), '[]'::jsonb));

  v_out := jsonb_set(v_out, '{empties_this_sale}', coalesce((
    select jsonb_agg(c.value order by p.ord, c.ord)
      from unnest(p_parts) with ordinality as p(part, ord),
           jsonb_array_elements(coalesce(p.part -> 'empties_this_sale', '[]'::jsonb)) with ordinality as c(value, ord)
  ), '[]'::jsonb));

  /*
   * PAYMENTS. The till's reading lists each one; the link's groups them by method — kept in its
   * own shape, so "cash" is one line across the receipts as it is on one.
   */
  if not (p_head ? 'paid_total') then
    v_out := jsonb_set(v_out, '{payments}', coalesce((
      select jsonb_agg(c.value order by p.ord, c.ord)
        from unnest(p_parts) with ordinality as p(part, ord),
             jsonb_array_elements(coalesce(p.part -> 'payments', '[]'::jsonb)) with ordinality as c(value, ord)
    ), '[]'::jsonb));
  else
    v_out := jsonb_set(v_out, '{payments}', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'amount', m.amount) order by m.method)
        from (
          select c.value ->> 'method' as method, sum((c.value ->> 'amount')::numeric) as amount
            from unnest(p_parts) as p(part),
                 jsonb_array_elements(coalesce(p.part -> 'payments', '[]'::jsonb)) as c(value)
           group by 1
        ) m
    ), '[]'::jsonb));
    select sum(coalesce((p.part ->> 'paid_total')::numeric, 0)) into v_sum from unnest(p_parts) as p(part);
    v_out := jsonb_set(v_out, '{paid_total}', to_jsonb(coalesce(v_sum, 0)));
  end if;

  -- The money each receipt carries, added.
  select sum(coalesce((p.part -> 'sale' ->> 'total')::numeric, 0)) into v_sum from unnest(p_parts) as p(part);
  v_out := jsonb_set(v_out, '{sale,total}', to_jsonb(coalesce(v_sum, 0)));
  select sum(coalesce((p.part -> 'sale' ->> 'fee_amount')::numeric, 0)) into v_sum from unnest(p_parts) as p(part);
  v_out := jsonb_set(v_out, '{sale,fee_amount}', to_jsonb(coalesce(v_sum, 0)));

  select sum(coalesce((p.part ->> 'deposit_total')::numeric, 0)) into v_sum from unnest(p_parts) as p(part);
  v_out := jsonb_set(v_out, '{deposit_total}', to_jsonb(coalesce(v_sum, 0)));
  select sum(coalesce((p.part ->> 'deposit_taken')::numeric, 0)) into v_sum from unnest(p_parts) as p(part);
  v_out := jsonb_set(v_out, '{deposit_taken}', to_jsonb(coalesce(v_sum, 0)));
  select sum(coalesce((p.part ->> 'deposit_unpaid')::numeric, 0)) into v_sum from unnest(p_parts) as p(part);
  v_out := jsonb_set(v_out, '{deposit_unpaid}', to_jsonb(coalesce(v_sum, 0)));

  -- Change: what was owed at each, and every handing-over.
  select sum(coalesce((p.part -> 'change' ->> 'owed')::numeric, 0)) into v_sum from unnest(p_parts) as p(part);
  v_out := jsonb_set(v_out, '{change}', jsonb_build_object(
    'owed', coalesce(v_sum, 0),
    'given', coalesce((
      select jsonb_agg(g.value order by g.value ->> 'occurred_at')
        from unnest(p_parts) as p(part),
             jsonb_array_elements(coalesce(p.part -> 'change' -> 'given', '[]'::jsonb)) as g(value)
    ), '[]'::jsonb)));

  -- ONCE, as at the latest of them: everything still with them, and where the account stands.
  if p_customer is not null then
    v_out := jsonb_set(v_out, '{empties}', coalesce(public.customer_containers_as_at(p_customer, p_moment), '[]'::jsonb));
    v_out := jsonb_set(v_out, '{account}', jsonb_build_object(
      'owed_after', public.customer_owed_as_at(p_customer, p_moment)));
  end if;

  -- And which receipts these are, for the paper to say.
  v_out := v_out || jsonb_build_object('combined_parts', (
    select jsonb_agg(jsonb_build_object(
             'id', p.part -> 'sale' ->> 'id',
             'occurred_at', p.part -> 'sale' ->> 'occurred_at',
             'total', p.part -> 'sale' -> 'total') order by p.ord)
      from unnest(p_parts) with ordinality as p(part, ord)));
  return v_out;
end;
$function$;
revoke all on function public.combine_receipt_json(jsonb, jsonb[], uuid, timestamptz) from public, anon, authenticated;

-- ─── The till's receipt ─────────────────────────────────────────────────────────────────────
/*
 * `sale_detail` for this sale, as ever — what every action on the receipt works from — and:
 *   combined       when it heads a group: the parts, and the PAPER that prints for all of them;
 *   combined_into  when it is part of one: the receipt it now prints under.
 * Corrections keep reading `sale_document`, one sale at a time, so a combined receipt is never
 * corrected into a sale that holds another one's lines.
 */
create or replace function public.receipt_detail(p_sale_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = public, pg_temp
as $function$
declare
  v_own    jsonb;
  v_head   uuid;
  v_parts  jsonb[];
  v_moment timestamptz;
  v_cust   uuid;
begin
  v_own := public.sale_detail(p_sale_id);
  if v_own is null then
    return null;
  end if;

  v_head := public.receipt_group_head(p_sale_id);
  if v_head <> p_sale_id then
    return v_own || jsonb_build_object('combined_into', (
      select jsonb_build_object('id', h.id, 'occurred_at', h.occurred_at, 'total', h.total)
        from public.sales h where h.id = v_head));
  end if;

  if (select count(*) from public.receipt_group_members(p_sale_id)) < 2 then
    return v_own;
  end if;

  select array_agg(public.sale_detail(m.sale_id) order by m.occurred_at),
         max(public.receipt_moment(m.sale_id))
    into v_parts, v_moment
    from public.receipt_group_members(p_sale_id) m;
  select store_customer_id into v_cust from public.sales where id = p_sale_id;

  return v_own || jsonb_build_object('combined', jsonb_build_object(
    'paper', public.combine_receipt_json(v_own, v_parts, v_cust, v_moment)));
end;
$function$;
revoke all on function public.receipt_detail(uuid) from public, anon;
grant execute on function public.receipt_detail(uuid) to authenticated;

-- ─── The customer's link ────────────────────────────────────────────────────────────────────
-- read_shared_receipt's own body, word for word, for one sale; reached only from the link.
create or replace function public.shared_receipt_of(p_sale_id uuid)
returns jsonb
language sql
stable security definer
set search_path = public, pg_temp
as $function$
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
      'cancelled_reason', case when s.status = 'voided' then s.amend_reason end,
      /*
       * AND WHETHER THIS REPLACES A COPY THEY MAY STILL BE HOLDING.
       *
       * The customer is the ONE person guaranteed to have the old version — the shop sent it to
       * them. A corrected bill that looks identical to the one in their hand is how a shop ends up
       * arguing about a figure neither of them can source.
       */
      'revision', coalesce(s.revision, 1),
      'corrected', (
        select jsonb_build_object('replaced_at', r.amended_at, 'was_total', r.document -> 'total')
          from public.sale_revisions r
         where r.sale_id = s.id
         order by r.revision desc
         limit 1
      )
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

    -- THE CHANGE (0246): what was owed at this sale, what has been given, and how.
    'change', jsonb_build_object(
      'owed',  coalesce((select sum(c.amount) from public.sale_change c where c.sale_id = s.id and c.kind = 'owed'), 0),
      'given', coalesce((select jsonb_agg(jsonb_build_object('amount', c.amount, 'method', c.method,
                                                             'occurred_at', c.occurred_at) order by c.occurred_at)
                           from public.sale_change c where c.sale_id = s.id and c.kind = 'given'), '[]'::jsonb)
    ),
    -- And how much of it is still to be paid (0247).
    'deposit_unpaid', public.sale_deposit_unpaid(s.id),
    -- Put down as a deposit AT this sale (0244): the customer's money, held for them.
    'deposit_taken', public.sale_deposit_put_down(s.id),
    'deposit_total', coalesce((
      select sum(sl.deposit_charged) from public.sale_lines sl where sl.sale_id = s.id
    ), 0),

    /*
     * STILL WITH YOU — what THIS receipt sent out, in the shape it went out in.
     *
     * «the reader "still with you" uses what was bought by the customer — if it is 0.5 goldberg,
     *  3 gulder, 10 big turbo, it uses that data»
     *
     * Read from the container rows the sale itself wrote (`ref_table = 'sale_lines'`), netted
     * against anything written back against the same lines — which is exactly what a correction
     * does — so an amended receipt prints what it says NOW. One row per product shape, with its
     * maker, so the screen can apply the counter's rule: whole ones add across a maker, parts stay
     * with their beer. That rule lives in `rollUpOwed`, once, rather than in SQL twice.
     *
     * This used to read `deposit_ledger` pools on the shared link and nothing at all on the till's
     * copy, so a new sale printed no containers on either.
     */
    -- As at this sale: what they held before plus what it sent out (0149).
    'empties', case when sc.id is null then '[]'::jsonb
                    else public.customer_containers_as_at(sc.id, public.receipt_moment(s.id)) end,
    'account', case when sc.id is null then null
                    else jsonb_build_object(
                           'owed_after', public.customer_owed_as_at(sc.id, public.receipt_moment(s.id))) end,
    'empties_this_sale', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', t.product_id,
               'product_name', t.product_name,
               'product_unit_id', t.product_unit_id,
               'unit_name', t.unit_name,
               'unit_plural', t.unit_plural,
               'base_qty', t.base_qty,
               'group_id', t.group_id,
               'group_name', t.group_name,
               'owed', t.owed
             ) order by t.group_name nulls last, t.product_name)
        from (
          select ce.product_id,
                 pr.name  as product_name,
                 ce.product_unit_id,
                 su.name  as unit_name,
                 su.plural as unit_plural,
                 pu.base_qty,
                 g.group_id,
                 g.group_name,
                 sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) as owed
            /*
             * THIS SALE'S CONTAINER ROWS, from either place they can be.
             *
             * Written by the sale itself (`sale_lines`, since 0117), or carried over from the old deposit
             * ledger (0110), where the deposit row points at the sale. 62 older receipts have theirs only
             * in the second place and printed nothing although the ledger was right.
             */
            from (
              select c.* from public.customer_empties c
                join public.sale_lines sl on c.ref_table = 'sale_lines' and sl.id = c.ref_id
               where sl.sale_id = s.id
              union all
              select c.* from public.customer_empties c
                join public.deposit_ledger dl on c.ref_table = 'deposit_ledger' and dl.id = c.ref_id
               where dl.ref_table = 'sales' and dl.ref_id = s.id
            ) ce
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
           where true
             and coalesce(ce.side, 'they_hold') = 'they_hold'
             /*
              * AND NOT TAKEN BACK BY A VOID. `unowe_voided_sale` (0117) writes its reversal under
              * `ref_table = 'sale_void'` pointing at the OUT row, not at the line — so without this a
              * cancelled receipt would still list the crates as with the customer.
              */
             and not exists (
               select 1 from public.customer_empties v
                where v.ref_table = 'sale_void' and v.ref_id = ce.id
             )
           group by ce.product_id, pr.name, ce.product_unit_id, su.name, su.plural,
                    pu.base_qty, g.group_id, g.group_name
          having sum(case when ce.direction = 'out' then ce.qty else -ce.qty end) > 0
        ) t
    ), '[]'::jsonb),

    'payments', coalesce((
      select jsonb_agg(x)
        from (
          select jsonb_build_object('method', pay.method, 'amount', sum(pa.amount)) as x
            from public.payment_allocations pa
            join public.payments pay on pay.id = pa.payment_id
           where pa.sale_id = s.id
             -- Paid as at this version (0240), as the account below is.
             and pay.occurred_at <= public.receipt_moment(s.id)
           group by pay.method
           order by pay.method
        ) grouped
    ), '[]'::jsonb),

    'paid_total', coalesce((
      select sum(pa.amount) from public.payment_allocations pa
        join public.payments pay on pay.id = pa.payment_id
       where pa.sale_id = s.id and pay.occurred_at <= public.receipt_moment(s.id)
    ), 0)
  )
  from public.sales s
  join public.stores st on st.id = s.store_id
  left join public.store_settings ss on ss.store_id = s.store_id
  left join public.store_customers sc on sc.id = s.store_customer_id
  where s.id = p_sale_id;
$function$;
revoke all on function public.shared_receipt_of(uuid) from public, anon, authenticated;

create or replace function public.read_shared_receipt(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_link   record;
  v_out    jsonb;
  v_head   uuid;
  v_parts  jsonb[];
  v_moment timestamptz;
  v_cust   uuid;
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

  /*
   * COMBINED (0253): a link to any receipt of a group opens the whole group, as one — the copy the
   * customer was sent first now says what the newest says, rather than a second bill beside it.
   */
  v_head := public.receipt_group_head(v_link.ref_id);
  if (select count(*) from public.receipt_group_members(v_head)) < 2 then
    v_out := public.shared_receipt_of(v_link.ref_id);
  else
    select array_agg(public.shared_receipt_of(m.sale_id) order by m.occurred_at),
           max(public.receipt_moment(m.sale_id))
      into v_parts, v_moment
      from public.receipt_group_members(v_head) m;
    select store_customer_id into v_cust from public.sales where id = v_head;
    v_out := public.combine_receipt_json(public.shared_receipt_of(v_head), v_parts, v_cust, v_moment)
             || jsonb_build_object('opened_as', v_link.ref_id);
  end if;

  update public.share_links
     set view_count = view_count + 1, last_seen_at = now()
   where id = v_link.id;

  return v_out;
end;
$function$;

-- ─── Combining, and taking apart ────────────────────────────────────────────────────────────
/*
 * ANY OF ONE CUSTOMER'S RECEIPTS, AND THE NEWEST ONE STAYS.
 *
 * Every receipt named must be posted, in one shop and for one named customer (a walk-in has no
 * account to say once). A receipt already heading a group brings its group along; one already in
 * another group moves. The head is the newest of them all — the receipt the customer was sent
 * last, and the one whose moment the account is read at.
 */
create or replace function public.combine_receipts(p_sale_ids uuid[], p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_ids    uuid[];
  v_store  uuid;
  v_cust   uuid;
  v_head   uuid;
  v_bad    text;
begin
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_sale_ids, '{}')) x where x is not null;
  if coalesce(array_length(v_ids, 1), 0) < 2 then
    raise exception 'choose at least two receipts to combine' using errcode = '22023';
  end if;

  -- Bring along what is already combined into any of them.
  select array_agg(distinct x) into v_ids from (
    select unnest(v_ids) as x
    union
    select rc.from_sale_id from public.receipt_combines rc
     where rc.into_sale_id = any (v_ids) and rc.undone_at is null
  ) t;

  select min(s.store_id::text)::uuid, min(s.store_customer_id::text)::uuid into v_store, v_cust
    from public.sales s where s.id = any (v_ids);
  if v_store is null or (select count(*) from public.sales where id = any (v_ids)) <> array_length(v_ids, 1) then
    raise exception 'one of those receipts does not exist' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'sales.amend') then
    raise exception 'you do not have permission to combine receipts' using errcode = '42501';
  end if;
  if exists (select 1 from public.sales where id = any (v_ids) and store_id <> v_store) then
    raise exception 'those receipts are from different shops' using errcode = '22023';
  end if;
  if v_cust is null or exists (select 1 from public.sales where id = any (v_ids)
                                and store_customer_id is distinct from v_cust) then
    raise exception 'only one customer''s receipts can be combined, and the customer must be named'
      using errcode = '22023';
  end if;
  select string_agg('#' || upper(left(id::text, 8)) || ' is ' || status, ', ') into v_bad
    from public.sales where id = any (v_ids) and status <> 'posted';
  if v_bad is not null then
    raise exception 'only receipts that stand can be combined: %', v_bad using errcode = '22023';
  end if;

  select id into v_head from public.sales where id = any (v_ids) order by occurred_at desc, created_at desc limit 1;

  -- Out of wherever they were, then into the newest.
  update public.receipt_combines
     set undone_at = now(), undone_by = auth.uid()
   where undone_at is null
     and (from_sale_id = any (v_ids) or into_sale_id = any (v_ids));

  insert into public.receipt_combines (store_id, into_sale_id, from_sale_id, reason)
  select v_store, v_head, x, nullif(btrim(coalesce(p_reason, '')), '')
    from unnest(v_ids) x where x <> v_head;

  return v_head;
end;
$function$;
revoke all on function public.combine_receipts(uuid[], text) from public, anon;
grant execute on function public.combine_receipts(uuid[], text) to authenticated;

/*
 * TAKE IT OUT — one receipt from its group, or, from the head, the whole group apart. Undone, not
 * deleted: who combined what, and when, stays on the record.
 */
create or replace function public.uncombine_receipt(p_sale_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_store uuid;
  v_n     integer;
begin
  select store_id into v_store from public.sales where id = p_sale_id;
  if v_store is null then
    raise exception 'that receipt does not exist' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_store, 'sales.amend') then
    raise exception 'you do not have permission to change combined receipts' using errcode = '42501';
  end if;
  update public.receipt_combines
     set undone_at = now(), undone_by = auth.uid()
   where undone_at is null
     and (from_sale_id = p_sale_id or into_sale_id = p_sale_id);
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke all on function public.uncombine_receipt(uuid) from public, anon;
grant execute on function public.uncombine_receipt(uuid) to authenticated;

-- The customer's receipts, for choosing: what each came to, what is still open on it, and where it
-- prints now.
create or replace function public.combinable_receipts(p_sale_id uuid)
returns table(sale_id uuid, occurred_at timestamptz, total money_amt, outstanding money_amt,
              line_count bigint, head_id uuid)
language sql
stable security definer
set search_path = public, pg_temp
as $function$
  select s.id, s.occurred_at, s.total,
         (s.total - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.sale_id = s.id), 0))::money_amt,
         (select count(*) from public.sale_lines sl where sl.sale_id = s.id),
         public.receipt_group_head(s.id)
    from public.sales me
    join public.sales s on s.store_customer_id = me.store_customer_id and s.store_id = me.store_id
   where me.id = p_sale_id
     and me.store_customer_id is not null
     and s.status = 'posted'
     and public.is_store_member(me.store_id)
   order by s.occurred_at desc
   limit 200;
$function$;
revoke all on function public.combinable_receipts(uuid) from public, anon;
grant execute on function public.combinable_receipts(uuid) to authenticated;

notify pgrst, 'reload schema';
