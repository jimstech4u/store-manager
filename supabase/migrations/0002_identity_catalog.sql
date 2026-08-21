-- =====================================================================================
-- 0002 — Identity graph, catalog, packaging, returnables, pricing
--
-- Decisions implemented here (STORE_MANAGER_PLAN.md → Gap resolutions):
--   GAP 10  the GLOBAL identity holds phone only; names live per-store, so looking up a
--           customer never reveals a competing store's labels for that person
--   GAP 9   duplicate identities are merged, never deleted, so the merge is auditable
--   GAP 1   packs work at point of SALE, not only receiving
--   GAP 4/5 returnables split into contents (derived per base unit) and containers
--           (declared by the seller, because "did the crate leave?" cannot be derived)
-- =====================================================================================

-- ─── Identity graph (cross-tenant) ──────────────────────────────────────────────────
--
-- Deliberately almost empty. Phone is the only reliable key in this market: names arrive
-- approximate — the person at the counter is often a child sent by the business owner, who
-- knows roughly a name and a number. Anything descriptive stored HERE would be visible to
-- every store that looks the number up, which would leak one distributor's customer list to a
-- competitor in the same market. Labels belong to the store that collected them.

create table public.identities (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null unique,
  -- Set when this identity is merged INTO another. Never deleted: lookups redirect, and the
  -- trail of who was merged into whom stays auditable and reversible.
  merged_into uuid references public.identities (id),
  created_at  timestamptz not null default now()
);

create index on public.identities (merged_into) where merged_into is not null;
create index identities_phone_trgm on public.identities using gin (phone gin_trgm_ops);

-- ─── Per-store customer records ─────────────────────────────────────────────────────

create table public.store_customers (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores (id) on delete cascade,
  identity_id   uuid not null references public.identities (id),
  display_name  text not null,               -- this store's label for this person
  business_name text,
  notes         text,
  amend_reason  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (store_id, identity_id)
);

create index on public.store_customers (store_id);
create index store_customers_name_trgm on public.store_customers
  using gin (display_name gin_trgm_ops, business_name gin_trgm_ops);

create trigger touch_updated_at before update on public.store_customers
  for each row execute function public.tg_touch_updated_at();
create trigger audit after insert or update or delete on public.store_customers
  for each row execute function public.tg_audit();

-- ─── Empties categories (fungibility groups) ────────────────────────────────────────
--
-- The unit of obligation is the CATEGORY, not the product: Heineken, Star and Gulder are
-- different products sharing one "NBL bottle" pool, so 12 bottles sold across the three are
-- settled by returning any 12 NBL bottles. Scoped per store because each business decides
-- which of its products are interchangeable on return.

create table public.empties_categories (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null,
  kind       text not null check (kind in ('content', 'container')),
  deposit    money_amt not null default 0,   -- default deposit per unit; overridable per sale
  created_at timestamptz not null default now(),
  unique (store_id, name)
);

create index on public.empties_categories (store_id);

-- ─── Products ───────────────────────────────────────────────────────────────────────

create table public.products (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores (id) on delete cascade,
  name          text not null,
  sku           text,
  base_unit     text not null references public.units (code),
  status        text not null default 'active' check (status in ('active','archived')),
  -- Moving weighted average (GAP 13). Recomputed on every receipt; chosen over FIFO because it
  -- survives the negative stock that offline sync makes inevitable, needs no batch tracking,
  -- and is explainable to a shop owner as "your average cost".
  avg_unit_cost unit_cost not null default 0,
  -- Opening-stock cost is often an owner's estimate on day one. Flagged so early margins read
  -- as approximate instead of confidently wrong (GAP 11).
  cost_is_estimated boolean not null default false,
  -- CRODS variance tolerance (GAP 8): below this, record without escalating. A business that
  -- sees a red flag every single day stops reading flags.
  variance_tolerance_qty qty     not null default 1,
  variance_tolerance_pct numeric(6,3) not null default 0.5,
  -- Which unit this product is usually spoken about in, so the seller sees "2 packs" not
  -- "24 pieces" (GAP 1). Points at a pack; null means the base unit.
  default_display_pack_id uuid,
  amend_reason  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (store_id, sku)
);

create index on public.products (store_id, status);
create index products_name_trgm on public.products using gin (name gin_trgm_ops);

create trigger touch_updated_at before update on public.products
  for each row execute function public.tg_touch_updated_at();
create trigger audit after insert or update or delete on public.products
  for each row execute function public.tg_audit();

-- ─── Packs: conversion definitions ──────────────────────────────────────────────────
--
-- A pack is a way of SAYING a quantity, not a separate stock pool. "1 crate" and "12 pieces"
-- are the same 12 base units. Used at receiving AND at sale — an earlier draft of the plan said
-- receiving only, which was wrong: sellers quote and sell in packs constantly, and forcing a
-- mental conversion at a busy counter is how a tool gets abandoned.

create table public.product_packs (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references public.products (id) on delete cascade,
  name          text not null,              -- "Crate", "Pack", "Bag"
  base_unit_qty qty  not null check (base_unit_qty > 0),
  created_at    timestamptz not null default now(),
  unique (product_id, name)
);

create index on public.product_packs (product_id);

alter table public.products
  add constraint products_display_pack_fk
  foreign key (default_display_pack_id) references public.product_packs (id) on delete set null;

-- ─── Returnable components ──────────────────────────────────────────────────────────
--
-- A single crate sale creates TWO obligations that are returned independently and at different
-- rates — 12 bottles and 1 crate — which is why one category per product was not enough.
--
--   kind='content'   → qty_per_base_unit, derived automatically (1 bottle per piece)
--   kind='container' → declared by the seller at point of sale, because whether the crate
--                      physically left with the customer cannot be inferred from quantity:
--                      6 loose bottles may or may not go out in a crate.

create table public.product_returnables (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references public.products (id) on delete cascade,
  empties_category_id uuid not null references public.empties_categories (id) on delete restrict,
  qty_per_base_unit   qty,                  -- required for 'content', null for 'container'
  created_at          timestamptz not null default now(),
  unique (product_id, empties_category_id)
);

create index on public.product_returnables (product_id);

-- ─── Pricing: reference points, not a rules engine ──────────────────────────────────
--
-- The seller decides the actual price in the moment — confirmed with the domain expert, who
-- may sell at list price past a discount threshold "to help sell based on many factors". These
-- tables exist to SHOW the right numbers at the counter, never to compute a final price. Margin
-- stays truthful regardless of which reference was used, because it is computed against landed
-- cost independently.

create table public.product_prices (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  -- Priced per PACK where one is given, per base unit otherwise: a distributor thinks
  -- "₦3,700 a pack", and storing it per-piece would round badly on the way back out.
  pack_id    uuid references public.product_packs (id) on delete cascade,
  price      money_amt not null check (price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, pack_id)
);

create trigger touch_updated_at before update on public.product_prices
  for each row execute function public.tg_touch_updated_at();

-- What this specific customer normally pays.
create table public.customer_prices (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  store_customer_id uuid not null references public.store_customers (id) on delete cascade,
  product_id        uuid not null references public.products (id) on delete cascade,
  pack_id           uuid references public.product_packs (id) on delete cascade,
  price             money_amt not null check (price >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (store_customer_id, product_id, pack_id)
);

create index on public.customer_prices (store_id, product_id);

create trigger touch_updated_at before update on public.customer_prices
  for each row execute function public.tg_touch_updated_at();

-- "5 or more packs? ₦3,600 each" — shown as a hint, applied only if the seller chooses to.
create table public.quantity_hints (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  pack_id    uuid references public.product_packs (id) on delete cascade,
  min_qty    qty  not null check (min_qty > 0),
  price      money_amt not null check (price >= 0),
  created_at timestamptz not null default now()
);

create index on public.quantity_hints (product_id);

-- ─── RLS ────────────────────────────────────────────────────────────────────────────

alter table public.identities          enable row level security;
alter table public.store_customers     enable row level security;
alter table public.empties_categories  enable row level security;
alter table public.products            enable row level security;
alter table public.product_packs       enable row level security;
alter table public.product_returnables enable row level security;
alter table public.product_prices      enable row level security;
alter table public.customer_prices     enable row level security;
alter table public.quantity_hints      enable row level security;

-- Identities carry nothing private (a phone number, which the looker-up already typed), and
-- cross-store recognition is the point. Lookup goes through find_identity_by_phone() so the
-- app never needs to scan the table.
create policy identities_read on public.identities
  for select to authenticated using (true);

create policy customers_rw on public.store_customers
  for all to authenticated
  using (public.is_store_member(store_id))
  with check (public.has_permission(store_id, 'customers.manage'));

create policy empties_read on public.empties_categories
  for select to authenticated using (public.is_store_member(store_id));
create policy empties_write on public.empties_categories
  for all to authenticated
  using (public.has_permission(store_id, 'products.manage'))
  with check (public.has_permission(store_id, 'products.manage'));

create policy products_read on public.products
  for select to authenticated using (public.is_store_member(store_id));
create policy products_write on public.products
  for all to authenticated
  using (public.has_permission(store_id, 'products.manage'))
  with check (public.has_permission(store_id, 'products.manage'));

-- Child tables inherit their parent product's store through a join; written as EXISTS so the
-- policy cannot be satisfied by a client-supplied store_id.
create policy packs_read on public.product_packs
  for select to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.is_store_member(p.store_id)));
create policy packs_write on public.product_packs
  for all to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

create policy returnables_read on public.product_returnables
  for select to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.is_store_member(p.store_id)));
create policy returnables_write on public.product_returnables
  for all to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

create policy prices_read on public.product_prices
  for select to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.is_store_member(p.store_id)));
create policy prices_write on public.product_prices
  for all to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

create policy cust_prices_read on public.customer_prices
  for select to authenticated using (public.is_store_member(store_id));
create policy cust_prices_write on public.customer_prices
  for all to authenticated
  using (public.has_permission(store_id, 'products.manage'))
  with check (public.has_permission(store_id, 'products.manage'));

create policy hints_read on public.quantity_hints
  for select to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.is_store_member(p.store_id)));
create policy hints_write on public.quantity_hints
  for all to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

-- ─── Identity resolution ────────────────────────────────────────────────────────────
--
-- Normalising the phone is what makes the graph work at all: the same person is typed as
-- 08031234567, +2348031234567 and 2348031234567 by three different staff, and three spellings
-- would become three identities with the debt split between them.

create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
as $$
  select case
    when d like '234%'  and length(d) = 13 then '0' || right(d, 10)
    when d like '0%'    and length(d) = 11 then d
    when length(d) = 10                    then '0' || d
    else d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) s;
$$;

-- Resolve a phone to an identity, creating one if needed, and following a merge if that
-- identity has since been merged away.
create or replace function public.resolve_identity(p_phone text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := public.normalize_phone(p_phone);
  v_id    uuid;
  v_into  uuid;
begin
  if coalesce(v_phone, '') = '' then
    raise exception 'a phone number is required to identify a customer' using errcode = '22023';
  end if;

  select id, merged_into into v_id, v_into
  from public.identities where phone = v_phone;

  if v_id is null then
    insert into public.identities (phone) values (v_phone) returning id into v_id;
    return v_id;
  end if;

  -- Follow the merge chain to whichever identity survives.
  while v_into is not null loop
    v_id := v_into;
    select merged_into into v_into from public.identities where id = v_id;
  end loop;

  return v_id;
end;
$$;

grant execute on function public.normalize_phone(text)  to authenticated;
grant execute on function public.resolve_identity(text) to authenticated;
