-- =====================================================================================
-- 0001 — Foundation: types, tenancy, RBAC, audit, append-only enforcement
--
-- Everything here exists because of a decision recorded in STORE_MANAGER_PLAN.md
-- ("Gap resolutions — the architectural spine"). The two that shape this file most:
--
--   C4  fixed-precision numerics — quantities and money are NEVER floats, because a drifting
--       stock figure makes CRODS variance meaningless, and CRODS is the product's core feature.
--   C1  append-only history — enforced by the database, not by convention, so that a staff
--       member (or a future bug) cannot edit yesterday's sales until a variance disappears.
-- =====================================================================================

create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists pg_trgm;       -- fuzzy customer lookup (identity graph)

-- ─── Domains ────────────────────────────────────────────────────────────────────────
-- Named domains rather than bare numerics so the intent travels with the column and every
-- table agrees on precision. 4dp on quantity covers 1.4kg and 3.4kg down to the gram; 6dp on
-- unit cost so ₦283.333333 × 12 rounds back to ₦3,400.00 instead of drifting.

create domain qty        as numeric(18, 4);
create domain money_amt  as numeric(18, 2);
create domain unit_cost  as numeric(18, 6);

-- ─── Units of measure ───────────────────────────────────────────────────────────────
-- `allows_fraction` is a real business rule, not decoration: 3.4 kg of powder is valid,
-- 3.4 bottles is a data-entry error that should be refused at the point it is made.

create table public.units (
  code            text primary key,
  name            text not null,
  allows_fraction boolean not null default false
);

insert into public.units (code, name, allows_fraction) values
  ('piece',  'Piece',      false),
  ('kg',     'Kilogram',   true),
  ('g',      'Gram',       true),
  ('litre',  'Litre',      true),
  ('cl',     'Centilitre', true),
  ('metre',  'Metre',      true),
  ('yard',   'Yard',       true);

-- ─── Stores (tenants) ───────────────────────────────────────────────────────────────

create table public.stores (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  currency      text not null default 'NGN',
  timezone      text not null default 'Africa/Lagos',
  -- Set when the owner finishes entering opening balances. Until then the store is in
  -- onboarding and CRODS has no first period to build from.
  onboarded_at  timestamptz,
  created_by    uuid not null references auth.users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index on public.stores (created_by);

-- ─── RBAC ───────────────────────────────────────────────────────────────────────────
-- A real permission matrix, per the plan: one check function used everywhere, never
-- `if role = 'admin'` scattered through application code — and enforced in the database so a
-- direct API call cannot bypass it.

create table public.roles (
  code        text primary key,
  name        text not null,
  rank        int  not null            -- higher = more authority; used for "can manage role X"
);

insert into public.roles (code, name, rank) values
  ('owner',   'Owner',   30),
  ('manager', 'Manager', 20),
  ('staff',   'Staff',   10);

create table public.permissions (
  code        text primary key,
  description text not null
);

insert into public.permissions (code, description) values
  ('store.settings',      'Change store settings'),
  ('staff.manage',        'Invite, remove and re-role staff'),
  ('products.manage',     'Create and edit products, packs and pricing'),
  ('stock.receive',       'Record incoming stock and purchases'),
  ('stock.count',         'Enter physical counts and close CRODS periods'),
  ('stock.adjust',        'Record damages, losses and adjustments'),
  ('variance.resolve',    'Resolve a CRODS variance with a reason code'),
  ('period.reopen',       'Break a closed-period seal'),
  ('sales.record',        'Record a sale'),
  ('sales.amend',         'Amend or void a recorded sale'),
  ('payments.record',     'Record a customer payment'),
  ('customers.manage',    'Create and edit customer records'),
  ('customers.merge',     'Merge duplicate customer identities'),
  ('deposits.manage',     'Record empties returns and deposit refunds'),
  ('backfill.manage',     'Enter and edit opening balances'),
  ('reports.view',        'View reports and margins');

create table public.role_permissions (
  role_code       text not null references public.roles (code) on delete cascade,
  permission_code text not null references public.permissions (code) on delete cascade,
  primary key (role_code, permission_code)
);

-- owner: everything
insert into public.role_permissions (role_code, permission_code)
select 'owner', code from public.permissions;

-- manager: day-to-day plus stock authority, but not staff/settings/seal-breaking
insert into public.role_permissions (role_code, permission_code)
select 'manager', code from public.permissions
where code in (
  'products.manage','stock.receive','stock.count','stock.adjust','variance.resolve',
  'sales.record','sales.amend','payments.record','customers.manage','deposits.manage',
  'reports.view'
);

-- staff: sell, take payment, record damage. Cannot resolve variances — the person who can
-- make stock disappear must not also be the person who explains it away.
insert into public.role_permissions (role_code, permission_code)
select 'staff', code from public.permissions
where code in ('sales.record','payments.record','stock.adjust','customers.manage','deposits.manage');

create table public.store_members (
  store_id    uuid not null references public.stores (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role_code   text not null references public.roles (code),
  invited_by  uuid references auth.users (id),
  joined_at   timestamptz not null default now(),
  primary key (store_id, user_id)
);

create index on public.store_members (user_id);

-- ─── Authorization helpers ──────────────────────────────────────────────────────────
--
-- SECURITY DEFINER is required, not stylistic: these are called FROM RLS policies on
-- store_members itself, and an invoker-rights function reading that table would re-enter its
-- own policy and recurse forever. Running as the owner reads underneath RLS and terminates.
--
-- `set search_path` is mandatory on every SECURITY DEFINER function — without it a caller can
-- prepend a schema and hijack what `store_members` resolves to.
--
-- EXECUTE is granted to `authenticated` deliberately. RLS policies evaluate as the CALLING
-- role, so a policy calling this function needs the caller to hold the grant. (Academix learned
-- this the hard way: revoking EXECUTE on a function used by invoker-rights callers took down 28
-- RPCs in production — see ACADEMIX_PLAN Q37.)

create or replace function public.is_store_member(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.store_members m
    where m.store_id = p_store_id
      and m.user_id  = auth.uid()
  );
$$;

create or replace function public.has_permission(p_store_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.store_members m
    join public.role_permissions rp on rp.role_code = m.role_code
    where m.store_id        = p_store_id
      and m.user_id         = auth.uid()
      and rp.permission_code = p_permission
  );
$$;

-- The caller's role in a store, or null. Used by the app to render only what a user may do —
-- the UI hides it, the database enforces it.
create or replace function public.my_role(p_store_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role_code
  from public.store_members m
  where m.store_id = p_store_id
    and m.user_id  = auth.uid();
$$;

grant execute on function public.is_store_member(uuid)       to authenticated;
grant execute on function public.has_permission(uuid, text)  to authenticated;
grant execute on function public.my_role(uuid)               to authenticated;

-- ─── Append-only enforcement ────────────────────────────────────────────────────────
--
-- Attached to every ledger table. This is the difference between a convention people forget
-- and an invariant the database refuses to break — including for service_role, which bypasses
-- RLS but not triggers. Corrections append a reversing row; they never edit history.

create or replace function public.tg_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'append-only: % rows cannot be %. Append a reversing entry instead.',
    tg_table_name, lower(tg_op)
    using errcode = 'restrict_violation';
end;
$$;

-- ─── updated_at ─────────────────────────────────────────────────────────────────────

create or replace function public.tg_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger touch_updated_at before update on public.stores
  for each row execute function public.tg_touch_updated_at();

-- ─── Audit log ──────────────────────────────────────────────────────────────────────
--
-- Every mutation of a document (sale, purchase, customer, product) lands here with who, when,
-- prior value, new value and reason. Ledger movements do not need this — they are already
-- immutable — but documents are editable in real time, which is a stated product requirement,
-- and an edit that leaves no trace would defeat the reconciliation this product exists for.

create table public.audit_log (
  id            bigserial primary key,
  store_id      uuid references public.stores (id) on delete cascade,
  table_name    text not null,
  record_id     uuid not null,
  op            text not null check (op in ('insert','update','delete')),
  prior_value   jsonb,
  new_value     jsonb,
  reason        text,
  actor         uuid default auth.uid(),
  at            timestamptz not null default now()
);

create index on public.audit_log (store_id, table_name, record_id, at desc);
create index on public.audit_log (store_id, at desc);

create trigger no_mutation before update or delete on public.audit_log
  for each row execute function public.tg_append_only();

-- Generic audit trigger. `reason` is carried on the row being changed when the table has an
-- `amend_reason` column, so a correction records WHY, which is the part that settles disputes.
create or replace function public.tg_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store_id uuid;
  v_reason   text;
  v_rec      jsonb;
begin
  v_rec := to_jsonb(coalesce(new, old));
  v_store_id := nullif(v_rec ->> 'store_id', '')::uuid;
  v_reason   := v_rec ->> 'amend_reason';

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  values (
    v_store_id,
    tg_table_name,
    (v_rec ->> 'id')::uuid,
    lower(tg_op),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    v_reason
  );

  return coalesce(new, old);
end;
$$;

-- ─── RLS: stores, members ───────────────────────────────────────────────────────────

alter table public.stores        enable row level security;
alter table public.store_members enable row level security;
alter table public.audit_log     enable row level security;

-- Reference tables are readable by any signed-in user; they hold no tenant data.
alter table public.units            enable row level security;
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;

create policy read_units   on public.units            for select to authenticated using (true);
create policy read_roles   on public.roles            for select to authenticated using (true);
create policy read_perms   on public.permissions      for select to authenticated using (true);
create policy read_rp      on public.role_permissions for select to authenticated using (true);

create policy stores_read on public.stores
  for select to authenticated
  using (public.is_store_member(id));

-- Anyone signed in may create a store; they become its owner (see create_store()).
-- created_by is pinned to auth.uid() so a client cannot claim someone else made it.
create policy stores_insert on public.stores
  for insert to authenticated
  with check (created_by = auth.uid());

create policy stores_update on public.stores
  for update to authenticated
  using (public.has_permission(id, 'store.settings'))
  with check (public.has_permission(id, 'store.settings'));

create policy members_read on public.store_members
  for select to authenticated
  using (public.is_store_member(store_id));

create policy members_write on public.store_members
  for all to authenticated
  using (public.has_permission(store_id, 'staff.manage'))
  with check (public.has_permission(store_id, 'staff.manage'));

create policy audit_read on public.audit_log
  for select to authenticated
  using (store_id is not null and public.has_permission(store_id, 'reports.view'));

-- ─── Store creation ─────────────────────────────────────────────────────────────────
-- A store and its owner membership must appear together or not at all: a store with no owner
-- is unreachable by anyone, including the person who just created it.

create or replace function public.create_store(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store_id uuid;
  v_uid      uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'store name is required' using errcode = '22023';
  end if;

  insert into public.stores (name, slug, created_by)
  values (trim(p_name), lower(trim(p_slug)), v_uid)
  returning id into v_store_id;

  insert into public.store_members (store_id, user_id, role_code, invited_by)
  values (v_store_id, v_uid, 'owner', v_uid);

  return v_store_id;
end;
$$;

grant execute on function public.create_store(text, text) to authenticated;
