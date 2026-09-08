-- 0105 — The empties the shop itself is holding
--
-- «we have to enter the crates we have, bottles we have, and then the crate empties and bottles
--  empty … not "Containers already out with customers", because that is from customerform»
--
-- Two different facts were wearing one name. What a CUSTOMER still has is an obligation, it belongs
-- to that customer, and it is already recorded properly: `backfill_empties` takes a customer id and
-- appends to `deposit_ledger`, and both the customer form and the account page call it. Asked on
-- the product form it had no customer to attach to, so the answer was validated, required at a
-- counter — and then written nowhere at all. A field that cannot change anything is worse than a
-- missing one, because it looks answered.
--
-- What the shop itself is holding had no home anywhere. A distributor opens with a stack of empty
-- crates and a crate of empty bottles in the yard; on day one that is as real as the full stock
-- beside it, and there was no table that could say so.
--
-- COUNTED, NOT ACCRUED. This is a count with a date on it, the same shape as `open_stock_by_count`,
-- and deliberately NOT a running balance. A balance would have to be opening plus what customers
-- brought back minus what went back to the brewery — and that last flow does not exist yet, so a
-- balance would drift upward for ever and be believed. "Forty crates, counted on the 8th" stays
-- true as a statement about the 8th.

create table if not exists public.empties_counts (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references public.stores (id) on delete cascade,
  empties_category_id uuid not null references public.empties_categories (id) on delete restrict,
  qty                 qty  not null check (qty >= 0),
  -- Zero is an answer. "None in the yard" and "nobody looked" are different facts, and the form
  -- refuses to conflate them, so the table has to be able to hold the first one.
  counted_at          timestamptz not null default now(),
  note                text,
  counted_by          uuid default auth.uid(),
  created_at          timestamptz not null default now()
);

create index if not exists empties_counts_store_pool_idx
  on public.empties_counts (store_id, empties_category_id, counted_at desc);

comment on table public.empties_counts is
  'What the shop had in its OWN yard when somebody counted it. Not what customers owe — that is '
  'deposit_ledger, against a customer. A count with a date, never a running balance: nothing yet '
  'records empties going back to the brewery, so an accrued figure would only ever climb.';

-- A count is a fact about a moment. Correcting one is another count, so the history says what was
-- believed and when — the same reason the ledgers are append-only.
create trigger no_mutation before update or delete on public.empties_counts
  for each row execute function public.tg_append_only();

alter table public.empties_counts enable row level security;

create policy empties_counts_read on public.empties_counts
  for select using (public.is_store_member(store_id));

-- Written only through the function below, which checks the permission and that the pool is this
-- shop's. A direct insert would be a client naming its own store_id.
create policy empties_counts_none on public.empties_counts
  for insert with check (false);

-- ─── Recording one ──────────────────────────────────────────────────────────────────

create or replace function public.count_empties_on_hand(
  p_store_id    uuid,
  p_category_id uuid,
  p_qty         qty,
  p_note        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'deposits.manage') then
    raise exception 'you do not have permission to count empties' using errcode = '42501';
  end if;

  /*
   * AND THE POOL HAS TO BE THIS SHOP'S.
   *
   * Permission in a store answers "may this person act here". It does not answer "is this pool
   * theirs" — the hole 0097 closed across all four deposit writers, where a member of one shop
   * could write rows into another shop's ledger and the shop being written to could not see how
   * they got there. Asked first, where no argument can skip it.
   */
  if not exists (
    select 1 from public.empties_categories
     where id = p_category_id and store_id = p_store_id
  ) then
    raise exception 'that pool does not belong to this shop' using errcode = '42501';
  end if;

  insert into public.empties_counts (store_id, empties_category_id, qty, note)
  values (p_store_id, p_category_id, p_qty, p_note)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.count_empties_on_hand(uuid, uuid, qty, text) from public;
grant execute on function public.count_empties_on_hand(uuid, uuid, qty, text) to authenticated;

-- ─── And reading it back ────────────────────────────────────────────────────────────

-- The latest count for each pool, with WHEN, because the date is half the fact. A pool nobody has
-- ever counted is absent rather than zero: "none" and "never looked" stay different here too.
create or replace function public.store_empties_on_hand(p_store_id uuid)
returns table (
  empties_category_id uuid,
  category_name       text,
  qty                 qty,
  counted_at          timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct on (ec.id) ec.id, ec.name, c.qty, c.counted_at
    from public.empties_counts c
    join public.empties_categories ec on ec.id = c.empties_category_id
   where c.store_id = p_store_id
     and public.is_store_member(p_store_id)
   order by ec.id, c.counted_at desc, c.created_at desc;
$$;

revoke all on function public.store_empties_on_hand(uuid) from public;
grant execute on function public.store_empties_on_hand(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('count_empties_on_hand', 'store_empties_on_hand')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'an empties-count function has % overloads', n;
    end if;
  end loop;
end;
$check$;
