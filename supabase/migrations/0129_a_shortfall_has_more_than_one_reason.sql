-- 0129 — A shortfall has more than one reason, and theft has somebody's name on it
--
-- «we could genuinely have damages (real loss) in the physical product and we need to ensure that
--  it is separate to the product stolen (which someone needs to pay) … we have to know if we sold
--  and not recorded, stolen, damaged and ensure that traces and a person (actor) is tied to every
--  record»
--
-- ─── ONE: one shortfall, one reason ─────────────────────────────────────────────────
--
-- `resolve_variance(p_period_id, p_reason, p_note)` writes ONE row for the WHOLE variance. The
-- worked case: 300 crates expected, 295 crates 1 bottle counted, 59 bottles gone. In a real shop
-- that is rarely one thing — a crate that got dropped, and a crate nobody can account for. Today
-- the shop picks the larger one and the rest is a lie inside the one table whose entire purpose is
-- to be the truth about loss.
--
-- And the two have opposite meanings. Damage is a cost of doing business; theft is a person. A
-- resolution that blends them tells an owner their breakage is running at 59 bottles a month when
-- 35 of them walked out of the door.
--
-- ─── TWO: theft is booked and nobody owes it ────────────────────────────────────────
--
-- `theft` values the loss at average cost, which is correct accounting and an incomplete record.
-- Stolen stock is somebody's to answer for, and there was nowhere to say whose.
--
-- Two places it can land, and NEITHER IS REQUIRED — a form that demands a culprit collects a guess:
--
--   a staff member  → `staff_charges`, a receivable against them. NOT a customer balance and NOT
--                     netted into takings: money recovered for stolen stock is not a sale.
--   a customer      → their account, as a charge, exactly like the charge composer on Take payment.
--   nobody          → the common case. It stays a loss.

-- ─── What a staff member owes the shop ──────────────────────────────────────────────

create table if not exists public.staff_charges (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  /*
   * WHO, as a user in this shop.
   *
   * `store_members` is keyed `(store_id, user_id)` and has no surrogate id, so the pair IS the
   * member — and the composite foreign key is what stops a charge being written against somebody
   * who is not on this shop at all.
   */
  member_user_id uuid not null references auth.users (id) on delete restrict,

  /*
   *   charged     — put on them. Stock that went missing on their watch, a till shortfall.
   *   paid        — they have handed it over, or it has come out of wages.
   *   written_off — the shop has decided not to pursue it. A decision, recorded, with a reason.
   *
   * A direction rather than a signed amount, for the same reason every other ledger here has one:
   * "minus twelve thousand" does not say which of three different things happened.
   */
  direction  text not null check (direction in ('charged', 'paid', 'written_off')),
  amount     money_amt not null check (amount > 0),

  -- Never optional. A charge against a person with no reason on it is unanswerable by the person.
  reason     text not null,

  ref_table  text,
  ref_id     uuid,

  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),

  constraint staff_charges_is_a_member
    foreign key (store_id, member_user_id)
    references public.store_members (store_id, user_id) on delete restrict
);

create index if not exists staff_charges_member_idx
  on public.staff_charges (store_id, member_user_id, occurred_at desc);
create index if not exists staff_charges_store_idx
  on public.staff_charges (store_id, occurred_at desc);

comment on table public.staff_charges is
  'What a staff member owes the shop, and what they have paid back. Separate from customer '
  'balances and never counted as takings — money recovered for stolen stock is not a sale.';

drop trigger if exists no_mutation on public.staff_charges;
create trigger no_mutation before update or delete on public.staff_charges
  for each row execute function public.tg_append_only();

alter table public.staff_charges enable row level security;

/*
 * READ BY MANAGERS, and by the person it is about.
 *
 * A charge against somebody that they cannot see is not a record, it is a rumour. `staff.manage`
 * covers the manager; the `user_id` test is what lets the person named read their own.
 */
drop policy if exists staff_charges_read on public.staff_charges;
create policy staff_charges_read on public.staff_charges
  for select using (
    public.has_permission(store_id, 'staff.manage')
    or member_user_id = auth.uid()
  );

drop policy if exists staff_charges_none on public.staff_charges;
create policy staff_charges_none on public.staff_charges
  for insert with check (false);

insert into public.permissions (code, description)
values ('staff.charge', 'Charge a staff member for missing stock or cash, and settle it')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code)
values ('owner', 'staff.charge'), ('manager', 'staff.charge')
on conflict do nothing;

create or replace function public.record_staff_charge(
  p_store_id    uuid,
  p_member_user_id uuid,
  p_amount      money_amt,
  p_direction   text,
  p_reason      text,
  p_ref_table   text default null,
  p_ref_id      uuid default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'staff.charge') then
    raise exception 'you do not have permission to charge staff' using errcode = '42501';
  end if;

  /*
   * AND THE MEMBER HAS TO BE THIS SHOP'S.
   *
   * Permission in a store answers "may this person act here", never "is this member theirs" — the
   * hole 0097 closed across the deposit writers. Asked first, where no optional argument can skip
   * it: a guard that only fires when something else was left out is not a guard.
   */
  if not exists (
    select 1 from public.store_members
     where user_id = p_member_user_id and store_id = p_store_id
  ) then
    raise exception 'that person is not on this shop' using errcode = '42501';
  end if;

  if p_direction not in ('charged', 'paid', 'written_off') then
    raise exception 'a staff charge is charged, paid or written_off' using errcode = '22023';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say what this is for' using errcode = '22023';
  end if;

  insert into public.staff_charges (store_id, member_user_id, direction, amount, reason,
                                    ref_table, ref_id, occurred_at)
  values (p_store_id, p_member_user_id, p_direction, p_amount, btrim(p_reason),
          p_ref_table, p_ref_id, p_occurred_at)
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_staff_charge(uuid, uuid, money_amt, text, text, text, uuid, timestamptz) from public;
grant execute on function public.record_staff_charge(uuid, uuid, money_amt, text, text, text, uuid, timestamptz) to authenticated;

-- What each person still owes, with what it was for.
create or replace function public.staff_charges_owed(p_store_id uuid)
returns table (
  member_user_id uuid,
  full_name   text,
  charged     money_amt,
  paid        money_amt,
  written_off money_amt,
  owing       money_amt,
  last_at     timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select m.user_id,
         u.email::text,
         coalesce(sum(c.amount) filter (where c.direction = 'charged'), 0)::money_amt,
         coalesce(sum(c.amount) filter (where c.direction = 'paid'), 0)::money_amt,
         coalesce(sum(c.amount) filter (where c.direction = 'written_off'), 0)::money_amt,
         (coalesce(sum(c.amount) filter (where c.direction = 'charged'), 0)
          - coalesce(sum(c.amount) filter (where c.direction = 'paid'), 0)
          - coalesce(sum(c.amount) filter (where c.direction = 'written_off'), 0))::money_amt,
         max(c.occurred_at)
    from public.staff_charges c
    join public.store_members m on m.store_id = c.store_id and m.user_id = c.member_user_id
    join auth.users u on u.id = m.user_id
   where c.store_id = p_store_id
     and public.has_permission(p_store_id, 'staff.manage')
   group by m.user_id, u.email
   order by 6 desc;
$fn$;

revoke all on function public.staff_charges_owed(uuid) from public;
grant execute on function public.staff_charges_owed(uuid) to authenticated;

-- ─── A variance is explained in as many pieces as it took ───────────────────────────

/*
 * THE OLD SIGNATURE GOES FIRST.
 *
 * 0058 added a second overload by "tidying" a working function's parameter list, PostgREST answered
 * 300 to every call, and the till stopped saving. A defaulted parameter bolted onto the side does
 * the same thing. Dropped explicitly, and the overload count is checked at the end.
 */
drop function if exists public.resolve_variance(uuid, text, text);
drop function if exists public.resolve_variance(uuid, jsonb, text);

create function public.resolve_variance(
  p_period_id uuid,
  p_parts     jsonb,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_p        record;
  v_avg_cost unit_cost;
  v_parts    jsonb;
  v_part     jsonb;
  v_qty      numeric;
  v_reason   text;
  v_sum      numeric := 0;
  v_id       uuid;
  v_ids      uuid[] := '{}';
  v_member   uuid;
  v_customer uuid;
  v_charge   numeric;
  v_sign     int;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'variance.resolve') then
    raise exception 'you do not have permission to resolve variances' using errcode = '42501';
  end if;
  if v_p.variance_qty is null then
    raise exception 'enter a physical count before resolving' using errcode = '22023';
  end if;
  if v_p.status <> 'open' then
    raise exception 'this period is already %', v_p.status using errcode = '22023';
  end if;

  /*
   * A BARE OBJECT IS ONE PART.
   *
   * The single-reason case is still the common one — most gaps are a miscount — and making every
   * caller wrap it in an array would be ceremony for nothing.
   */
  v_parts := case
               when jsonb_typeof(p_parts) = 'object' then jsonb_build_array(p_parts)
               else p_parts
             end;

  if v_parts is null or jsonb_typeof(v_parts) <> 'array' or jsonb_array_length(v_parts) = 0 then
    raise exception 'say what happened to the missing stock' using errcode = '22023';
  end if;

  select avg_unit_cost into v_avg_cost from public.products where id = v_p.product_id;

  /*
   * THE PARTS MUST ADD UP TO THE VARIANCE, EXACTLY.
   *
   * Not "at most". A remainder is an unexplained shortfall, and an unexplained shortfall is the one
   * thing a period is not allowed to close on — letting the parts fall short would move that gap
   * from a blocked close to a number nobody ever looks at again.
   *
   * The parts are given as PLAIN QUANTITIES and take the variance's sign. Asking somebody to type
   * "-24" for twenty-four broken bottles is asking for a sign error in front of a shelf.
   */
  v_sign := case when v_p.variance_qty < 0 then -1 else 1 end;

  for v_part in select * from jsonb_array_elements(v_parts)
  loop
    v_qty := abs((v_part ->> 'qty')::numeric);
    if v_qty is null or v_qty <= 0 then
      raise exception 'each reason needs a quantity' using errcode = '22023';
    end if;
    v_sum := v_sum + v_qty;
  end loop;

  if v_sum <> abs(v_p.variance_qty) then
    raise exception 'the reasons add up to %, but the count is off by % — every one has to be accounted for',
      v_sum, abs(v_p.variance_qty) using errcode = '22023';
  end if;

  for v_part in select * from jsonb_array_elements(v_parts)
  loop
    v_qty    := abs((v_part ->> 'qty')::numeric) * v_sign;
    v_reason := v_part ->> 'reason';
    v_member := nullif(v_part ->> 'charge_to_member_id', '')::uuid;  -- a user_id in this shop
    v_customer := nullif(v_part ->> 'charge_to_customer_id', '')::uuid;

    insert into public.variance_resolutions (store_id, stock_period_id, qty, reason, note,
                                             value_at_cost)
    values (v_p.store_id, p_period_id, v_qty, v_reason,
            coalesce(v_part ->> 'note', p_note),
            case when v_reason = 'miscount' then 0
                 else abs(v_qty) * coalesce(v_avg_cost, 0) end)
    returning id into v_id;
    v_ids := v_ids || v_id;

    /*
     * ONE MOVEMENT PER PART, and the KIND says which.
     *
     * The old function wrote a single blended `adjustment`. Twenty-four broken and thirty-five
     * stolen became "adjustment 59", and no report could ever separate them again — which is the
     * report an owner actually wants. `damage` is its own movement kind and has been since 0003.
     */
    if v_reason = 'miscount' then
      update public.stock_periods
         set actual_closing_qty = expected_closing_qty
       where id = p_period_id;
    else
      insert into public.stock_movements (store_id, product_id, kind, qty_delta, unit_cost,
                                          ref_table, ref_id, note)
      values (v_p.store_id, v_p.product_id,
              case when v_reason = 'unlogged_damage' then 'damage' else 'adjustment' end,
              v_qty, coalesce(v_avg_cost, 0), 'variance_resolutions', v_id,
              coalesce(v_part ->> 'note', p_note, v_reason));
    end if;

    /*
     * AND WHO ANSWERS FOR IT, when somebody does.
     *
     * The amount defaults to what the stock cost and can be overridden, because a shop recovers
     * what it sells for rather than what it paid. Naming nobody is the common case and stays
     * perfectly valid — a form that demands a culprit gets a guess, and a guess in this table is
     * worse than a blank.
     */
    if v_member is not null or v_customer is not null then
      v_charge := coalesce((v_part ->> 'charge_amount')::numeric,
                           abs(v_qty) * coalesce(v_avg_cost, 0));

      if v_charge > 0 and v_member is not null then
        perform public.record_staff_charge(
          v_p.store_id, v_member, v_charge, 'charged',
          coalesce(v_part ->> 'note', 'Stock missing at a count'),
          'variance_resolutions', v_id);
      end if;

      if v_charge > 0 and v_customer is not null then
        perform public.record_customer_charge(
          v_p.store_id, v_customer, v_charge,
          coalesce(v_part ->> 'note', 'Stock missing at a count'),
          false);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'period_id', p_period_id,
    'parts',     jsonb_array_length(v_parts),
    'ids',       to_jsonb(v_ids)
  );
end;
$fn$;

revoke all on function public.resolve_variance(uuid, jsonb, text) from public;
grant execute on function public.resolve_variance(uuid, jsonb, text) to authenticated;

-- ─── And a period cannot close on a gap that was only partly explained ──────────────

/*
 * The old check asked whether ANY resolution existed. With one reason per variance that was the
 * same question; with parts it is not — explaining 24 of 59 bottles would have satisfied it, and
 * the remaining 35 would have been sealed into a closed period by the act of explaining the 24.
 */
create or replace function public.close_stock_period(p_period_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_p        record;
  v_resolved numeric;
  v_next_id  uuid;
begin
  select * into v_p from public.stock_periods where id = p_period_id;
  if not found then
    raise exception 'unknown stock period' using errcode = '23503';
  end if;
  if not public.has_permission(v_p.store_id, 'stock.count') then
    raise exception 'you do not have permission to close periods' using errcode = '42501';
  end if;
  if v_p.status <> 'open' then
    raise exception 'this period is already %', v_p.status using errcode = '22023';
  end if;
  if v_p.actual_closing_qty is null then
    raise exception 'enter a physical count before closing' using errcode = '22023';
  end if;

  if v_p.variance_qty is distinct from 0
     and not public.variance_within_tolerance(p_period_id) then
    select coalesce(sum(abs(qty)), 0) into v_resolved
      from public.variance_resolutions where stock_period_id = p_period_id;

    if v_resolved < abs(v_p.variance_qty) then
      raise exception
        'this period is off by %, and only % of that has been explained',
        abs(v_p.variance_qty), v_resolved
        using errcode = '22023';
    end if;
  end if;

  update public.stock_periods
     set status     = 'closed',
         period_end = now(),
         closed_by  = auth.uid(),
         closed_at  = now()
   where id = p_period_id;

  insert into public.stock_periods (store_id, product_id, period_start, opening_qty, status)
  values (v_p.store_id, v_p.product_id, now(), v_p.actual_closing_qty, 'open')
  returning id into v_next_id;

  return v_next_id;
end;
$fn$;

revoke all on function public.close_stock_period(uuid) from public;
grant execute on function public.close_stock_period(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('resolve_variance', 'close_stock_period', 'record_staff_charge',
                          'staff_charges_owed')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a variance function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
