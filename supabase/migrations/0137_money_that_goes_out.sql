-- 0137 — Money that goes out
--
-- «another important thing is expense that we forgot business do have»
--
-- Every way money could LEAVE this shop was attached to something it bought or somebody it owed: a
-- delivery, a supplier payment, a deposit handed back. Rent, fuel, the generator, a staff advance,
-- the union levy, a bribe at a checkpoint nobody wants to call that — none of it had anywhere to
-- go, so a shop's takings were its profit and the arithmetic was wrong by exactly the cost of
-- running the place.
--
-- ─── NOT A SUPPLIER PAYMENT, and not a charge ───────────────────────────────────────
--
-- `supplier_payments` settles an account with somebody the shop buys stock from — it has a balance
-- on the other end of it. An expense has no other end: money leaves and nothing is owed afterwards.
-- Filing rent against a supplier would put it in that supplier's statement and in what the shop
-- owes them, and neither is true.
--
-- ─── CATEGORIES THE SHOP NAMES, not a fixed list ────────────────────────────────────
--
-- Nobody can name every cost a business has, and a screen that tries has ten empty fields on it for
-- the nine that do not apply today — the same argument that made fees on a delivery a composer
-- rather than a row of boxes. The shop names a category the first time it uses it, and the list it
-- builds is its own.

create table if not exists public.expense_categories (
  id       uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  name     text not null,
  status   text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

-- One name per shop, case-insensitively: "Fuel" and "fuel" are the same cost and must total as one.
create unique index if not exists expense_categories_name_idx
  on public.expense_categories (store_id, lower(name));

alter table public.expense_categories enable row level security;

drop policy if exists expense_categories_read on public.expense_categories;
create policy expense_categories_read on public.expense_categories
  for select using (public.is_store_member(store_id));

drop policy if exists expense_categories_none on public.expense_categories;
create policy expense_categories_none on public.expense_categories
  for insert with check (false);

create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete cascade,
  category_id uuid references public.expense_categories (id) on delete restrict,

  amount      money_amt not null check (amount > 0),

  /*
   * HOW IT LEFT. The same vocabulary `payments` uses, so "what went out in cash today" can be
   * asked of both without translating between two spellings of the same four words.
   */
  method      text not null default 'cash' check (method in ('cash', 'transfer', 'pos', 'other')),

  -- Never optional. An amount with no reason cannot be questioned six weeks later, and the one
  -- thing an expense record is for is being questioned.
  note        text not null,

  /*
   * WHO IT WENT TO, as free text and on purpose.
   *
   * A landlord is not a supplier and giving one a row would put rent in a stock account. Most of
   * these are paid to somebody the shop will never file: a bus fare, a mechanic, a council man.
   */
  paid_to     text,

  /** The staff member it was an advance to, when it is one — so it can be set against wages. */
  member_user_id uuid references auth.users (id) on delete restrict,

  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists expenses_store_idx on public.expenses (store_id, occurred_at desc);
create index if not exists expenses_category_idx on public.expenses (category_id, occurred_at desc);

comment on table public.expenses is
  'Money that left the shop and bought no stock and settled no account — rent, fuel, wages, '
  'transport. Not a supplier payment: an expense has nothing on the other end of it.';

/*
 * APPEND-ONLY, like every other money record here.
 *
 * A correction is another row saying what happened next — `reverse_expense` below — never an edit.
 * An expense that can be quietly changed is an expense nobody can be asked about.
 */
drop trigger if exists no_mutation on public.expenses;
create trigger no_mutation before update or delete on public.expenses
  for each row execute function public.tg_append_only();

drop trigger if exists audit_changes on public.expenses;
create trigger audit_changes after insert or update or delete on public.expenses
  for each row execute function public.tg_audit();

alter table public.expenses enable row level security;

/*
 * READ BY WHOEVER MAY SEE THE MONEY.
 *
 * `reports.view` rather than `payments.record`: what the shop spends is the owner's business, and a
 * seller who may take a payment has no reason to read the rent.
 */
drop policy if exists expenses_read on public.expenses;
create policy expenses_read on public.expenses
  for select using (public.has_permission(store_id, 'reports.view'));

drop policy if exists expenses_none on public.expenses;
create policy expenses_none on public.expenses
  for insert with check (false);

insert into public.permissions (code, description)
values ('expenses.record', 'Record money the shop spends — rent, fuel, transport, wages')
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code)
values ('owner', 'expenses.record'), ('manager', 'expenses.record')
on conflict do nothing;

-- ─── Recording one ──────────────────────────────────────────────────────────────────

create or replace function public.record_expense(
  p_store_id    uuid,
  p_amount      money_amt,
  p_note        text,
  p_category    text default null,
  p_method      text default 'cash',
  p_paid_to     text default null,
  p_member_user_id uuid default null,
  p_occurred_at timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cat uuid;
  v_id  uuid;
begin
  if not public.has_permission(p_store_id, 'expenses.record') then
    raise exception 'you do not have permission to record what the shop spends'
      using errcode = '42501';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'say how much went out' using errcode = '22023';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'say what it was for' using errcode = '22023';
  end if;

  /*
   * THE CATEGORY IS NAMED, AND FOUND IF IT ALREADY EXISTS.
   *
   * Somebody typing a name the shop already has means the one that is there — the product groups
   * learnt this in 0093 and the suppliers in 0125. Being told off for reusing a word is the worst
   * possible answer to somebody recording last week's fuel.
   */
  if coalesce(btrim(p_category), '') <> '' then
    select id into v_cat
      from public.expense_categories
     where store_id = p_store_id and lower(name) = lower(btrim(p_category));

    if v_cat is null then
      insert into public.expense_categories (store_id, name)
      values (p_store_id, btrim(p_category))
      returning id into v_cat;
    end if;
  end if;

  /*
   * AND A STAFF ADVANCE HAS TO BE THIS SHOP'S STAFF.
   *
   * Permission in a store answers "may this person act here", never "is this member theirs" — the
   * hole 0097 and 0098 closed across the trade writers.
   */
  if p_member_user_id is not null then
    if not exists (
      select 1 from public.store_members
       where user_id = p_member_user_id and store_id = p_store_id
    ) then
      raise exception 'that person is not on this shop' using errcode = '42501';
    end if;
  end if;

  insert into public.expenses (store_id, category_id, amount, method, note, paid_to,
                               member_user_id, occurred_at)
  values (p_store_id, v_cat, p_amount, coalesce(p_method, 'cash'), btrim(p_note),
          nullif(btrim(p_paid_to), ''), p_member_user_id, p_occurred_at)
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.record_expense(uuid, money_amt, text, text, text, text, uuid, timestamptz) from public;
grant execute on function public.record_expense(uuid, money_amt, text, text, text, text, uuid, timestamptz) to authenticated;

-- ─── Putting one right ──────────────────────────────────────────────────────────────

/*
 * A CORRECTION IS ANOTHER ROW, never an edit.
 *
 * The table refuses UPDATE and DELETE, correctly. What was missing everywhere else in this app is
 * the append that CORRECTS — the thing `stock_movements.reverses_id` has modelled since 0003 and
 * no other ledger copied. An expense keyed at ₦50,000 instead of ₦5,000 is exactly the mistake
 * somebody makes at the end of a long day.
 */
alter table public.expenses
  add column if not exists reverses_id uuid references public.expenses (id);

create or replace function public.reverse_expense(p_expense_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_e  record;
  v_id uuid;
begin
  select * into v_e from public.expenses where id = p_expense_id;
  if not found then
    raise exception 'that expense does not exist' using errcode = 'P0002';
  end if;
  if not public.has_permission(v_e.store_id, 'expenses.record') then
    raise exception 'you do not have permission to correct what the shop spends'
      using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'say why this is being taken back' using errcode = '22023';
  end if;

  if v_e.reverses_id is not null then
    raise exception 'that row is itself a correction' using errcode = '22023';
  end if;
  if exists (select 1 from public.expenses where reverses_id = p_expense_id) then
    raise exception 'that expense has already been taken back' using errcode = '22023';
  end if;

  /*
   * The negation, as its own row. `amount > 0` still holds — it is the REVERSES_ID that makes this
   * one subtract, so the trail reads as money out and then money back rather than as a figure that
   * quietly changed.
   */
  insert into public.expenses (store_id, category_id, amount, method, note, paid_to,
                               member_user_id, reverses_id)
  values (v_e.store_id, v_e.category_id, v_e.amount, v_e.method,
          'taken back: ' || btrim(p_reason), v_e.paid_to, v_e.member_user_id, p_expense_id)
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.reverse_expense(uuid, text) from public;
grant execute on function public.reverse_expense(uuid, text) to authenticated;

-- ─── Reading them back ──────────────────────────────────────────────────────────────

create or replace function public.list_expenses(
  p_store_id uuid,
  p_from     timestamptz default null,
  p_to       timestamptz default null,
  p_category uuid default null
)
returns table (
  id          uuid,
  amount      money_amt,
  method      text,
  note        text,
  paid_to     text,
  category_id uuid,
  category    text,
  occurred_at timestamptz,
  actor       text,
  reverses_id uuid,
  reversed    boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select e.id, e.amount, e.method, e.note, e.paid_to, e.category_id, c.name, e.occurred_at,
         coalesce(u.email::text, 'the shop'),
         e.reverses_id,
         exists (select 1 from public.expenses r where r.reverses_id = e.id)
    from public.expenses e
    left join public.expense_categories c on c.id = e.category_id
    left join auth.users u on u.id = e.created_by
   where e.store_id = p_store_id
     and (p_from is null or e.occurred_at >= p_from)
     and (p_to   is null or e.occurred_at <  p_to)
     and (p_category is null or e.category_id = p_category)
     and public.has_permission(p_store_id, 'reports.view')
   order by e.occurred_at desc, e.created_at desc;
$fn$;

revoke all on function public.list_expenses(uuid, timestamptz, timestamptz, uuid) from public;
grant execute on function public.list_expenses(uuid, timestamptz, timestamptz, uuid) to authenticated;

/*
 * WHAT IT CAME TO, by category.
 *
 * A reversal and the row it reverses CANCEL: `sum(case when reverses_id is null then amount else
 * -amount end)`. Both stay on the list, because the trail is the point, and neither is counted
 * twice in the total.
 */
create or replace function public.expenses_by_category(
  p_store_id uuid,
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns table (category_id uuid, category text, entries int, total money_amt)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select e.category_id,
         coalesce(c.name, 'Not put under anything'),
         /*
          * LIVE ENTRIES ONLY.
          *
          * Counting every row that is not itself a reversal read "2 entries · ₦3,000" for a heading
          * where one of the two had been taken back — a count and a total that disagree about what
          * happened. An entry that has been reversed is not an entry any more; it is a trace.
          */
         count(*) filter (
           where e.reverses_id is null
             and not exists (select 1 from public.expenses r where r.reverses_id = e.id)
         )::int,
         coalesce(sum(case when e.reverses_id is null then e.amount else -e.amount end), 0)::money_amt
    from public.expenses e
    left join public.expense_categories c on c.id = e.category_id
   where e.store_id = p_store_id
     and (p_from is null or e.occurred_at >= p_from)
     and (p_to   is null or e.occurred_at <  p_to)
     and public.has_permission(p_store_id, 'reports.view')
   group by e.category_id, c.name
   order by 4 desc;
$fn$;

revoke all on function public.expenses_by_category(uuid, timestamptz, timestamptz) from public;
grant execute on function public.expenses_by_category(uuid, timestamptz, timestamptz) to authenticated;

/*
 * AND WHAT THE SHOP ACTUALLY KEPT.
 *
 * Takings minus what was spent, which is the figure an owner means by "how did we do". Sales are
 * what was BILLED and payments are what arrived; both are here because they answer different
 * questions on the same day — a good month on paper with nothing in the drawer is exactly the
 * thing a shop needs to be able to see.
 */
create or replace function public.money_summary(
  p_store_id uuid,
  p_from     timestamptz default null,
  p_to       timestamptz default null
)
returns table (
  billed    money_amt,
  came_in   money_amt,
  spent     money_amt,
  kept      money_amt
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with took as (
    select coalesce(sum(p.amount), 0) as amt
      from public.payments p
     where p.store_id = p_store_id and p.direction = 'in'
       and (p_from is null or p.occurred_at >= p_from)
       and (p_to   is null or p.occurred_at <  p_to)
  ),
  sold as (
    select coalesce(sum(s.total), 0) as amt
      from public.sales s
     where s.store_id = p_store_id and s.status = 'posted'
       and (p_from is null or s.occurred_at >= p_from)
       and (p_to   is null or s.occurred_at <  p_to)
  ),
  out_ as (
    select coalesce(sum(case when e.reverses_id is null then e.amount else -e.amount end), 0) as amt
      from public.expenses e
     where e.store_id = p_store_id
       and (p_from is null or e.occurred_at >= p_from)
       and (p_to   is null or e.occurred_at <  p_to)
  )
  select (select amt from sold)::money_amt,
         (select amt from took)::money_amt,
         (select amt from out_)::money_amt,
         ((select amt from took) - (select amt from out_))::money_amt
   where public.has_permission(p_store_id, 'reports.view');
$fn$;

revoke all on function public.money_summary(uuid, timestamptz, timestamptz) from public;
grant execute on function public.money_summary(uuid, timestamptz, timestamptz) to authenticated;

-- What the shop has called things before, so the composer can offer them.
create or replace function public.expense_category_list(p_store_id uuid)
returns table (id uuid, name text, used int)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select c.id, c.name, count(e.id)::int
    from public.expense_categories c
    left join public.expenses e on e.category_id = c.id
   where c.store_id = p_store_id
     and coalesce(c.status, 'active') = 'active'
     and public.is_store_member(p_store_id)
   group by c.id, c.name
   order by count(e.id) desc, c.name;
$fn$;

revoke all on function public.expense_category_list(uuid) from public;
grant execute on function public.expense_category_list(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('record_expense', 'reverse_expense', 'list_expenses',
                          'expenses_by_category', 'money_summary', 'expense_category_list')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'an expense function has % overloads; PostgREST answers 300 to every call', n;
    end if;
  end loop;
end;
$check$;
