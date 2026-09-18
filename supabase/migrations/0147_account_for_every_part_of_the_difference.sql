-- 0147 — Every part of the difference is accounted for, in the shop's own words
--
-- «after counting, then before we close, we give account for the missing | additions … a multi line
--  addition from a form with select reasons (we can add more reasons, just like the customer and
--  product pickers) … when we have more than expected all reasons account for the addition, likewise
--  the less expected for the missing … because every day has to have why something happened»
--
-- ─── The gap was already splittable, and no screen could split it ───────────────────
--
-- 0129 made `resolve_variance` take PARTS — as many reasons as it took, each with its own quantity,
-- its own movement kind, and optionally the person who answers for it — and dropped the old
-- one-reason signature. The count screen was never moved onto it: it still sent `p_reason`, an
-- argument that has not existed since 0129, so CLOSING A COUNT WITH A GAP HAS BEEN FAILING on the
-- one screen a shop uses to do it. The screens catch up in this session; this migration adds the two
-- things they need.
--
-- ─── ONE: a shop names its own reasons ──────────────────────────────────────────────
--
-- Six codes decide the financial treatment and that list is not the shop's to extend — a seventh
-- kind of money movement is a migration, not a text box. What a shop absolutely does need is its own
-- WORDS: "spoilt in the sun", "went with the delivery van", "given to the landlord". Each shop
-- reason is a label plus the treatment it behaves as, so the books stay exact while the list reads
-- like the shop talks. Built-ins and the shop's own come back from one reader, because a picker with
-- two sources is a picker that sorts them wrongly.
--
-- ─── TWO: the row remembers the word that was chosen ────────────────────────────────
--
-- `reason` is the treatment; `reason_label` is what somebody picked. Without it every custom reason
-- collapses back into "adjustment" the moment it is written, which is exactly the report an owner
-- wants and the one they could not get.

-- ─── The shop's own reasons ─────────────────────────────────────────────────────────

create table if not exists public.variance_reasons (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  label      text not null check (length(trim(label)) > 0),
  -- Which way it can explain a gap: stock MISSING, stock SPARE, or either.
  direction  text not null default 'both' check (direction in ('short', 'over', 'both')),
  -- How the books treat it. The same six the ledger has always known.
  treatment  text not null check (treatment in (
               'miscount', 'theft', 'unrecorded_sale', 'unlogged_damage',
               'unrecorded_receipt', 'other')),
  is_active  boolean not null default true,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (store_id, label)
);

alter table public.variance_reasons enable row level security;

drop policy if exists variance_reasons_read on public.variance_reasons;
create policy variance_reasons_read on public.variance_reasons
  for select using (public.is_store_member(store_id));

drop policy if exists variance_reasons_none on public.variance_reasons;
create policy variance_reasons_none on public.variance_reasons
  for insert with check (false);

alter table public.variance_resolutions
  add column if not exists reason_label text;

-- ─── Adding one, from wherever a reason is chosen ───────────────────────────────────

create or replace function public.add_variance_reason(
  p_store_id  uuid,
  p_label     text,
  p_treatment text,
  p_direction text default 'both'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'stock.count') then
    raise exception 'You do not have permission to add a reason.' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_label), '') = '' then
    raise exception 'Give the reason a name.' using errcode = '22023';
  end if;

  insert into public.variance_reasons (store_id, label, direction, treatment)
  values (p_store_id, trim(p_label), coalesce(p_direction, 'both'), p_treatment)
  on conflict (store_id, label) do update set is_active = true
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.add_variance_reason(uuid, text, text, text) from public;
grant execute on function public.add_variance_reason(uuid, text, text, text) to authenticated;

-- ─── Every reason a gap can be given, built-in and the shop's own ───────────────────

create or replace function public.variance_reasons_for(p_store_id uuid)
returns table (
  id        uuid,
  label     text,
  hint      text,
  treatment text,
  direction text,
  is_custom boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select null::uuid, b.label, b.hint, b.treatment, b.direction, false
    from (values
      ('Sold, but nobody entered it', 'It went out of the shop and no receipt was made',
       'unrecorded_sale', 'short'),
      ('Broken or spoiled', 'Dropped, expired, leaked - it cannot be sold',
       'unlogged_damage', 'short'),
      ('Stolen or missing', 'Nobody can say where it went', 'theft', 'short'),
      ('Given out, not entered', 'A gift, a sample, or stock taken for the shop''s own use',
       'other', 'short'),
      ('Came in, but nobody entered it', 'A delivery was put on the shelf without being recorded',
       'unrecorded_receipt', 'over'),
      ('A return that was never entered', 'A customer brought stock back and it was not recorded',
       'unrecorded_receipt', 'over'),
      ('The count was wrong', 'A stack was missed, or something was counted twice',
       'miscount', 'both'),
      ('Something else', 'Say what it is in the note', 'other', 'both')
    ) as b(label, hint, treatment, direction)
   where public.is_store_member(p_store_id)
  union all
  select r.id, r.label, null::text, r.treatment, r.direction, true
    from public.variance_reasons r
   where r.store_id = p_store_id
     and r.is_active
     and public.is_store_member(p_store_id)
   order by 6, 2;
$fn$;

grant execute on function public.variance_reasons_for(uuid) to authenticated;

-- ─── Resolving, with the word the shop chose kept beside the treatment ──────────────
--
-- Spliced from 0129 and changed in three places: a `label` per part, declared, read and stored.

create or replace function public.resolve_variance(
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
  -- What the SHOP called it. 'unlogged_damage' is the treatment; "Fell off the truck" is the reason
  -- somebody will recognise in a report six weeks later.
  v_label    text;
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
    v_label  := nullif(v_part ->> 'label', '');
    v_member := nullif(v_part ->> 'charge_to_member_id', '')::uuid;  -- a user_id in this shop
    v_customer := nullif(v_part ->> 'charge_to_customer_id', '')::uuid;

    insert into public.variance_resolutions (store_id, stock_period_id, qty, reason, reason_label,
                                             note, value_at_cost)
    values (v_p.store_id, p_period_id, v_qty, v_reason, v_label,
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

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('resolve_variance', 'variance_reasons_for', 'add_variance_reason')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a variance function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
