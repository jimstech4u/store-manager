-- 0109 — Writing and reading the two ledgers
--
-- 0108 made the tables. These are the only ways into them, which is why both tables refuse a
-- direct insert: every one of these reads the caller's permission and checks the customer belongs
-- to the shop being named. `assert_deposit_target` (0097) exists because four writers took a
-- customer id on trust, and a member of one shop could write rows against another shop's customer
-- while the shop being written to could not see how they got there.

-- ─── A deposit: taken, given back, or kept ──────────────────────────────────────────

create or replace function public.take_customer_deposit(
  p_store_id    uuid,
  p_customer_id uuid,
  p_amount      money_amt,
  p_reason      text default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to hold deposits' using errcode = '42501';
  end if;

  -- The customer must be this shop's. Asked first, where no optional argument can skip it.
  if not exists (
    select 1 from public.store_customers
     where id = p_customer_id and store_id = p_store_id
  ) then
    raise exception 'that customer does not belong to this shop' using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'a deposit has to be an amount' using errcode = '22023';
  end if;

  insert into public.customer_deposits (store_id, store_customer_id, direction, amount, reason,
                                        occurred_at)
  values (p_store_id, p_customer_id, 'taken', p_amount, nullif(btrim(coalesce(p_reason, '')), ''),
          coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$$;

/*
 * GIVING IT BACK, OR KEEPING IT — one function, because they are the same gesture with a different
 * meaning and a shop decides which as it happens.
 *
 * `p_keep` says which. Both need a reason and both refuse to move more than is being held: a
 * deposit account that can go negative is one nobody can reconcile, and the figure it would go
 * negative against is somebody's money.
 */
create or replace function public.settle_customer_deposit(
  p_store_id    uuid,
  p_customer_id uuid,
  p_amount      money_amt,
  p_keep        boolean default false,
  p_reason      text default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_held money_amt;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to move deposits' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.store_customers
     where id = p_customer_id and store_id = p_store_id
  ) then
    raise exception 'that customer does not belong to this shop' using errcode = '42501';
  end if;

  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'say why' using errcode = '22023';
  end if;

  select coalesce(sum(case when direction = 'taken' then amount else -amount end), 0)
    into v_held
    from public.customer_deposits
   where store_customer_id = p_customer_id;

  if p_amount is null or p_amount <= 0 then
    raise exception 'that is not an amount' using errcode = '22023';
  end if;

  -- Told before the button where the screen can, and enforced here regardless: a stale screen must
  -- not be able to get round it.
  if p_amount > v_held then
    raise exception 'you are only holding % for them', v_held using errcode = '23514';
  end if;

  insert into public.customer_deposits (store_id, store_customer_id, direction, amount, reason,
                                        occurred_at)
  values (p_store_id, p_customer_id,
          case when p_keep then 'retained' else 'given' end,
          p_amount, btrim(p_reason), coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.take_customer_deposit(uuid, uuid, money_amt, text, timestamptz) from public;
grant execute on function public.take_customer_deposit(uuid, uuid, money_amt, text, timestamptz) to authenticated;
revoke all on function public.settle_customer_deposit(uuid, uuid, money_amt, boolean, text, timestamptz) from public;
grant execute on function public.settle_customer_deposit(uuid, uuid, money_amt, boolean, text, timestamptz) to authenticated;

-- ─── Empties: out, back, or gone ────────────────────────────────────────────────────

/*
 * ONE WRITER FOR ALL THREE DIRECTIONS.
 *
 * A return and a write-off close the same obligation and differ only in whether the thing came
 * back, so splitting them into two functions would duplicate every check for no gain. Taking them
 * out is the same row with the sign the other way.
 *
 * The SHAPE is checked against the product, not trusted: a client-authored `product_unit_id` naming
 * another product's crate would put the obligation on the wrong item for ever.
 */
create or replace function public.record_customer_empties(
  p_store_id       uuid,
  p_customer_id    uuid,
  p_product_unit_id uuid,
  p_direction      text,
  p_qty            qty,
  p_reason         text default null,
  p_ref_table      text default null,
  p_ref_id         uuid default null,
  p_occurred_at    timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id         uuid;
  v_product_id uuid;
  v_owed       qty;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to record empties' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.store_customers
     where id = p_customer_id and store_id = p_store_id
  ) then
    raise exception 'that customer does not belong to this shop' using errcode = '42501';
  end if;

  if p_direction not in ('out', 'returned', 'damaged') then
    raise exception '% is not something that happens to a container', p_direction
      using errcode = '22023';
  end if;

  -- The shape, and the shop it belongs to, read from the product rather than taken on trust.
  select p.id into v_product_id
    from public.product_units pu
    join public.products p on p.id = pu.product_id
   where pu.id = p_product_unit_id and p.store_id = p_store_id;

  if v_product_id is null then
    raise exception 'that shape does not belong to this shop' using errcode = '42501';
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'say how many' using errcode = '22023';
  end if;

  /*
   * NOT MORE THAN IS OWED, for anything coming back.
   *
   * Usually over-returning means the customer has brought another shop's crates, or somebody has
   * already recorded this lot. Either way the ledger must not go negative: a customer the shop
   * believes it owes containers to is a figure nobody can act on.
   */
  if p_direction in ('returned', 'damaged') then
    select coalesce(sum(case when direction = 'out' then qty else -qty end), 0)
      into v_owed
      from public.customer_empties
     where store_customer_id = p_customer_id
       and product_unit_id = p_product_unit_id;

    if p_qty > v_owed then
      raise exception 'they only owe % of those', v_owed using errcode = '23514';
    end if;
  end if;

  insert into public.customer_empties (store_id, store_customer_id, product_id, product_unit_id,
                                       direction, qty, reason, ref_table, ref_id, occurred_at)
  values (p_store_id, p_customer_id, v_product_id, p_product_unit_id, p_direction, p_qty,
          nullif(btrim(coalesce(p_reason, '')), ''), p_ref_table, p_ref_id,
          coalesce(p_occurred_at, now()))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_customer_empties(uuid, uuid, uuid, text, qty, text, text, uuid, timestamptz) from public;
grant execute on function public.record_customer_empties(uuid, uuid, uuid, text, qty, text, text, uuid, timestamptz) to authenticated;

-- ─── Reading them ───────────────────────────────────────────────────────────────────

-- Every customer this shop has ever held a deposit for, whether or not it is holding one now. A
-- list of only the outstanding ones cannot answer "did we give Daniel his money back?".
create or replace function public.customers_with_deposits(p_store_id uuid)
returns table (
  store_customer_id uuid,
  customer_name     text,
  phone             text,
  held              money_amt,
  taken_total       money_amt,
  given_total       money_amt,
  retained_total    money_amt,
  last_at           timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.display_name, i.phone,
         coalesce(sum(case when d.direction = 'taken' then d.amount else -d.amount end), 0)::money_amt,
         coalesce(sum(case when d.direction = 'taken'    then d.amount else 0 end), 0)::money_amt,
         coalesce(sum(case when d.direction = 'given'    then d.amount else 0 end), 0)::money_amt,
         coalesce(sum(case when d.direction = 'retained' then d.amount else 0 end), 0)::money_amt,
         max(d.occurred_at)
    from public.customer_deposits d
    join public.store_customers c on c.id = d.store_customer_id
    join public.identities i on i.id = c.identity_id
   where d.store_id = p_store_id
     and public.is_store_member(p_store_id)
   group by c.id, c.display_name, i.phone
   order by 4 desc, max(d.occurred_at) desc;
$$;

revoke all on function public.customers_with_deposits(uuid) from public;
grant execute on function public.customers_with_deposits(uuid) to authenticated;

-- Every move of one customer's deposit, newest first. This IS the trace.
create or replace function public.customer_deposit_ledger(p_store_customer_id uuid)
returns table (
  id          uuid,
  direction   text,
  amount      money_amt,
  reason      text,
  occurred_at timestamptz,
  running     money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.direction, d.amount, d.reason, d.occurred_at,
         /*
          * WHAT WAS HELD AFTER THIS ROW. Computed here rather than on the client, because a
          * running balance the screen works out is one that disagrees with the server the moment
          * two rows share a timestamp.
          */
         sum(case when d.direction = 'taken' then d.amount else -d.amount end)
           over (order by d.occurred_at, d.created_at
                 rows between unbounded preceding and current row)::money_amt
    from public.customer_deposits d
    join public.store_customers c on c.id = d.store_customer_id
   where d.store_customer_id = p_store_customer_id
     and public.is_store_member(c.store_id)
   order by d.occurred_at desc, d.created_at desc;
$$;

revoke all on function public.customer_deposit_ledger(uuid) from public;
grant execute on function public.customer_deposit_ledger(uuid) to authenticated;

-- Every customer with an empties record, cleared or not — the same reason as above.
create or replace function public.customers_with_empties(p_store_id uuid)
returns table (
  store_customer_id uuid,
  customer_name     text,
  phone             text,
  still_out         qty,
  shapes_out        int,
  last_at           timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with per_shape as (
    select e.store_customer_id,
           e.product_unit_id,
           sum(case when e.direction = 'out' then e.qty else -e.qty end) as owed,
           max(e.occurred_at) as last_at
      from public.customer_empties e
     where e.store_id = p_store_id
     group by e.store_customer_id, e.product_unit_id
  )
  select c.id, c.display_name, i.phone,
         coalesce(sum(greatest(ps.owed, 0)), 0)::qty,
         count(*) filter (where ps.owed > 0)::int,
         max(ps.last_at)
    from per_shape ps
    join public.store_customers c on c.id = ps.store_customer_id
    join public.identities i on i.id = c.identity_id
   where public.is_store_member(p_store_id)
   group by c.id, c.display_name, i.phone
   order by 4 desc, max(ps.last_at) desc;
$$;

revoke all on function public.customers_with_empties(uuid) from public;
grant execute on function public.customers_with_empties(uuid) to authenticated;

/*
 * WHAT ONE CUSTOMER OWES, shape by shape — and the group each product belongs to, so the screen can
 * roll them up.
 *
 * The rolling up is NOT done here. "Three and a half Goldberg plus two and a half Gulder is five
 * NBL and two halves" is a presentation rule with an opinion in it, and it belongs somewhere it can
 * be read and argued with rather than buried in SQL. What this owes the screen is the honest
 * per-shape figure and the group name to gather by.
 */
create or replace function public.customer_empties_owed(p_store_customer_id uuid)
returns table (
  product_id      uuid,
  product_name    text,
  product_unit_id uuid,
  unit_name       text,
  unit_plural     text,
  base_qty        qty,
  group_id        uuid,
  group_name      text,
  taken           qty,
  returned        qty,
  damaged         qty,
  owed            qty
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.name, pu.id, su.name, su.plural, pu.base_qty,
         g.id, g.name,
         coalesce(sum(e.qty) filter (where e.direction = 'out'), 0)::qty,
         coalesce(sum(e.qty) filter (where e.direction = 'returned'), 0)::qty,
         coalesce(sum(e.qty) filter (where e.direction = 'damaged'), 0)::qty,
         (coalesce(sum(e.qty) filter (where e.direction = 'out'), 0)
          - coalesce(sum(e.qty) filter (where e.direction = 'returned'), 0)
          - coalesce(sum(e.qty) filter (where e.direction = 'damaged'), 0))::qty
    from public.customer_empties e
    join public.store_customers c on c.id = e.store_customer_id
    join public.products p on p.id = e.product_id
    join public.product_units pu on pu.id = e.product_unit_id
    join public.store_units su on su.id = pu.store_unit_id
    /*
     * THE FIRST GROUP, which is the maker.
     *
     * A product can be in several — that is what `product_category_links` is for — and the first is
     * the one `set_product_groups` keeps on `products.category_id`, so it is the one the shop named
     * first. Rolling up by a second group would put a crate in two totals at once.
     */
    left join lateral (
      select pc.id, pc.name
        from public.product_category_links pcl
        join public.product_categories pc on pc.id = pcl.category_id
       where pcl.product_id = p.id
       order by pc.name
       limit 1
    ) g on true
   where e.store_customer_id = p_store_customer_id
     and public.is_store_member(c.store_id)
   group by p.id, p.name, pu.id, su.name, su.plural, pu.base_qty, g.id, g.name
   order by g.name nulls last, p.name, pu.base_qty desc;
$$;

revoke all on function public.customer_empties_owed(uuid) from public;
grant execute on function public.customer_empties_owed(uuid) to authenticated;

-- The trace: every movement, newest first, for one customer.
create or replace function public.customer_empties_ledger(p_store_customer_id uuid)
returns table (
  id           uuid,
  product_name text,
  unit_name    text,
  unit_plural  text,
  direction    text,
  qty          qty,
  reason       text,
  occurred_at  timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id, p.name, su.name, su.plural, e.direction, e.qty, e.reason, e.occurred_at
    from public.customer_empties e
    join public.store_customers c on c.id = e.store_customer_id
    join public.products p on p.id = e.product_id
    join public.product_units pu on pu.id = e.product_unit_id
    join public.store_units su on su.id = pu.store_unit_id
   where e.store_customer_id = p_store_customer_id
     and public.is_store_member(c.store_id)
   order by e.occurred_at desc, e.created_at desc;
$$;

revoke all on function public.customer_empties_ledger(uuid) from public;
grant execute on function public.customer_empties_ledger(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('take_customer_deposit', 'settle_customer_deposit',
                          'record_customer_empties', 'customers_with_deposits',
                          'customer_deposit_ledger', 'customers_with_empties',
                          'customer_empties_owed', 'customer_empties_ledger')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a ledger function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
