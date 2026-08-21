-- =====================================================================================
-- 0004 — Purchases (landed cost), sales, payments, deposits
--
-- Decisions implemented (STORE_MANAGER_PLAN.md):
--   §3    landed cost — distribution + delivery fees allocated across units received, so
--         margin is computed against what stock ACTUALLY cost
--   C2    offline — every write carries a client-generated UUID for idempotency, so a retry
--         after a flaky-network timeout cannot double-post money
--   GAP 6 payments allocate oldest-first, allocations stored explicitly, seller may override
--   GAP 4/5 deposits: contents derived per base unit, containers declared at point of sale
-- =====================================================================================

-- ─── Purchases: where landed cost is established ────────────────────────────────────
--
-- The single calculation that most justifies the product. 100 packs at ₦3,200 with ₦15,000
-- delivery and ₦5,000 distribution is not ₦266.67/piece — it is ₦283.33. A business pricing
-- off the invoice thinks a ₦3,300 pack sale earns ₦100 when it loses ₦100.

create table public.purchases (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  supplier_name     text,
  invoice_ref       text,
  distribution_fee  money_amt not null default 0 check (distribution_fee >= 0),
  delivery_fee      money_amt not null default 0 check (delivery_fee >= 0),
  status            text not null default 'posted' check (status in ('draft','posted','voided')),
  client_uuid       uuid unique,             -- offline idempotency
  amend_reason      text,
  occurred_at       timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.purchases (store_id, occurred_at desc);

create trigger touch_updated_at before update on public.purchases
  for each row execute function public.tg_touch_updated_at();
create trigger audit after insert or update or delete on public.purchases
  for each row execute function public.tg_audit();

create table public.purchase_lines (
  id              uuid primary key default gen_random_uuid(),
  purchase_id     uuid not null references public.purchases (id) on delete cascade,
  product_id      uuid not null references public.products (id) on delete restrict,
  -- What the buyer actually said ("10 crates"), kept alongside the base-unit quantity so the
  -- document reads back the way it was entered rather than in machine units.
  entered_qty     qty  not null check (entered_qty > 0),
  entered_pack_id uuid references public.product_packs (id),
  base_qty        qty  not null check (base_qty > 0),
  unit_cost_raw   unit_cost not null check (unit_cost_raw >= 0),
  unit_cost_landed unit_cost not null default 0,
  created_at      timestamptz not null default now()
);

create index on public.purchase_lines (purchase_id);
create index on public.purchase_lines (product_id);

-- ─── Sales ──────────────────────────────────────────────────────────────────────────

create table public.sales (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  store_customer_id uuid references public.store_customers (id) on delete restrict,
  -- Null customer is a legitimate walk-in cash sale. Requiring identity for every sale would
  -- push staff to invent one, which is worse than recording it honestly as anonymous.
  status            text not null default 'posted' check (status in ('draft','posted','voided')),
  total             money_amt not null default 0,
  -- Version, for real-time editing on an append-only history: an amendment bumps this and the
  -- prior state is preserved in audit_log (C1).
  revision          int not null default 1,
  amend_reason      text,
  client_uuid       uuid unique,             -- offline idempotency
  occurred_at       timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.sales (store_id, occurred_at desc);
create index on public.sales (store_customer_id) where store_customer_id is not null;

create trigger touch_updated_at before update on public.sales
  for each row execute function public.tg_touch_updated_at();
create trigger audit after insert or update or delete on public.sales
  for each row execute function public.tg_audit();

create table public.sale_lines (
  id              uuid primary key default gen_random_uuid(),
  sale_id         uuid not null references public.sales (id) on delete cascade,
  product_id      uuid not null references public.products (id) on delete restrict,
  entered_qty     qty  not null check (entered_qty > 0),
  entered_pack_id uuid references public.product_packs (id),
  base_qty        qty  not null check (base_qty > 0),
  unit_price      money_amt not null check (unit_price >= 0),   -- per ENTERED unit
  line_total      money_amt not null,
  -- Snapshot of average cost at the moment of sale. Historic margin must not move when
  -- today's average cost changes.
  unit_cost_at_sale unit_cost not null default 0,
  -- Did a container physically leave with the customer? (GAP 5) Cannot be derived from
  -- quantity — 6 loose bottles may or may not go out in a crate — so the seller declares it.
  containers_out  qty not null default 0,
  created_at      timestamptz not null default now()
);

create index on public.sale_lines (sale_id);
create index on public.sale_lines (product_id);

-- ─── Payments ───────────────────────────────────────────────────────────────────────

create table public.payments (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  store_customer_id uuid references public.store_customers (id) on delete restrict,
  amount            money_amt not null check (amount <> 0),
  method            text not null default 'cash' check (method in ('cash','transfer','pos','other')),
  direction         text not null default 'in' check (direction in ('in','out')),
  reference         text,
  client_uuid       uuid unique,             -- offline idempotency
  amend_reason      text,
  occurred_at       timestamptz not null default now(),
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.payments (store_id, occurred_at desc);
create index on public.payments (store_customer_id) where store_customer_id is not null;

create trigger touch_updated_at before update on public.payments
  for each row execute function public.tg_touch_updated_at();
create trigger audit after insert or update or delete on public.payments
  for each row execute function public.tg_audit();

-- Which sale a payment settled. The running balance stays the source of truth; these exist so
-- a receipt can answer "is Monday's sale paid?" and so aging reports can be honest (GAP 6).
create table public.payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references public.payments (id) on delete cascade,
  sale_id     uuid not null references public.sales (id) on delete cascade,
  amount      money_amt not null check (amount > 0),
  created_at  timestamptz not null default now(),
  unique (payment_id, sale_id)
);

create index on public.payment_allocations (sale_id);

-- ─── Deposits / empties ─────────────────────────────────────────────────────────────
--
-- Symmetric by design: this business collects deposits from customers (a liability) and pays
-- them to suppliers (a receivable). Same mechanic, opposite direction, one table.

create table public.deposit_ledger (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references public.stores (id) on delete cascade,
  store_customer_id   uuid references public.store_customers (id) on delete restrict,
  empties_category_id uuid not null references public.empties_categories (id) on delete restrict,
  direction           text not null check (direction in ('collected','paid')),
  -- Signed: positive creates an obligation, negative settles one. A return appends a negative
  -- row rather than editing the original, so the history shows what happened and when.
  qty_units           qty  not null check (qty_units <> 0),
  deposit_per_unit    money_amt not null default 0,
  ref_table           text,
  ref_id              uuid,
  note                text,
  occurred_at         timestamptz not null default now(),
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now()
);

create index on public.deposit_ledger (store_id, store_customer_id, empties_category_id);
create index on public.deposit_ledger (ref_table, ref_id);

create trigger no_mutation before update or delete on public.deposit_ledger
  for each row execute function public.tg_append_only();

-- Forfeits: empties never returned, so part of the deposit is kept. Recorded explicitly
-- because it is income, and money that simply vanished from a balance is money nobody can
-- explain during a dispute.
create table public.deposit_forfeits (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references public.stores (id) on delete cascade,
  store_customer_id   uuid references public.store_customers (id) on delete restrict,
  empties_category_id uuid not null references public.empties_categories (id) on delete restrict,
  qty_units           qty not null check (qty_units > 0),
  amount              money_amt not null check (amount >= 0),
  note                text,
  occurred_at         timestamptz not null default now(),
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now()
);

create trigger no_mutation before update or delete on public.deposit_forfeits
  for each row execute function public.tg_append_only();

-- ─── Balances ───────────────────────────────────────────────────────────────────────

-- What a customer owes: sales posted, minus payments in, plus payments out (refunds).
create or replace function public.customer_balance(p_store_customer_id uuid)
returns money_amt
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    coalesce((select sum(s.total) from public.sales s
              where s.store_customer_id = p_store_customer_id and s.status = 'posted'), 0)
    - coalesce((select sum(case when p.direction = 'in' then p.amount else -p.amount end)
                from public.payments p
                where p.store_customer_id = p_store_customer_id), 0)
  )::money_amt
  from public.store_customers sc
  where sc.id = p_store_customer_id
    and public.is_store_member(sc.store_id);
$$;

-- Outstanding empties for one customer in one category. Fungible within the category, which is
-- the point: 12 NBL bottles owed can be settled with any mix of Heineken, Star and Gulder.
create or replace function public.empties_outstanding(
  p_store_customer_id uuid,
  p_empties_category_id uuid
)
returns qty
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(d.qty_units), 0)::qty
  from public.deposit_ledger d
  join public.store_customers sc on sc.id = d.store_customer_id
  where d.store_customer_id   = p_store_customer_id
    and d.empties_category_id = p_empties_category_id
    and d.direction = 'collected'
    and public.is_store_member(sc.store_id);
$$;

grant execute on function public.customer_balance(uuid)     to authenticated;
grant execute on function public.empties_outstanding(uuid, uuid) to authenticated;

-- ─── RLS ────────────────────────────────────────────────────────────────────────────

alter table public.purchases           enable row level security;
alter table public.purchase_lines      enable row level security;
alter table public.sales               enable row level security;
alter table public.sale_lines          enable row level security;
alter table public.payments            enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.deposit_ledger      enable row level security;
alter table public.deposit_forfeits    enable row level security;

create policy purchases_read on public.purchases
  for select to authenticated using (public.is_store_member(store_id));
create policy purchases_write on public.purchases
  for all to authenticated
  using (public.has_permission(store_id, 'stock.receive'))
  with check (public.has_permission(store_id, 'stock.receive'));

create policy purchase_lines_rw on public.purchase_lines
  for all to authenticated
  using (exists (select 1 from public.purchases x
                 where x.id = purchase_id and public.is_store_member(x.store_id)))
  with check (exists (select 1 from public.purchases x
                 where x.id = purchase_id and public.has_permission(x.store_id, 'stock.receive')));

create policy sales_read on public.sales
  for select to authenticated using (public.is_store_member(store_id));
create policy sales_insert on public.sales
  for insert to authenticated
  with check (public.has_permission(store_id, 'sales.record'));
create policy sales_update on public.sales
  for update to authenticated
  using (public.has_permission(store_id, 'sales.amend'))
  with check (public.has_permission(store_id, 'sales.amend'));

create policy sale_lines_read on public.sale_lines
  for select to authenticated
  using (exists (select 1 from public.sales s
                 where s.id = sale_id and public.is_store_member(s.store_id)));
create policy sale_lines_write on public.sale_lines
  for all to authenticated
  using (exists (select 1 from public.sales s
                 where s.id = sale_id and public.has_permission(s.store_id, 'sales.record')))
  with check (exists (select 1 from public.sales s
                 where s.id = sale_id and public.has_permission(s.store_id, 'sales.record')));

create policy payments_read on public.payments
  for select to authenticated using (public.is_store_member(store_id));
create policy payments_insert on public.payments
  for insert to authenticated
  with check (public.has_permission(store_id, 'payments.record'));
create policy payments_update on public.payments
  for update to authenticated
  using (public.has_permission(store_id, 'sales.amend'))
  with check (public.has_permission(store_id, 'sales.amend'));

create policy alloc_rw on public.payment_allocations
  for all to authenticated
  using (exists (select 1 from public.payments p
                 where p.id = payment_id and public.is_store_member(p.store_id)))
  with check (exists (select 1 from public.payments p
                 where p.id = payment_id and public.has_permission(p.store_id, 'payments.record')));

create policy deposits_read on public.deposit_ledger
  for select to authenticated using (public.is_store_member(store_id));
create policy deposits_insert on public.deposit_ledger
  for insert to authenticated
  with check (public.has_permission(store_id, 'deposits.manage'));

create policy forfeits_read on public.deposit_forfeits
  for select to authenticated using (public.is_store_member(store_id));
create policy forfeits_insert on public.deposit_forfeits
  for insert to authenticated
  with check (public.has_permission(store_id, 'deposits.manage'));
