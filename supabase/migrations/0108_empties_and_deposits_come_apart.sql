-- 0108 — Empties and deposits come apart, and empties are owed in the shape they left in
--
-- «empties different, deposit different» — and the reason the two were welded together is worth
-- writing down, because the seam is everywhere.
--
-- `deposit_ledger` records a QUANTITY OF CONTAINERS against a pool, and derives money from the
-- pool's rate. So "I am holding twenty thousand naira for Daniel" cannot be said at all: it has to
-- be expressed as a number of crates, at a rate, in a pool. `take_deposit` takes `p_category_id`
-- and `p_qty` and has no signature that omits them. A shop that takes a round sum against a
-- customer's account — which is what shops do — had nowhere to put it.
--
-- And the containers themselves were tracked in `empties_categories`: pools, invented separately
-- from the product, named "NBL crate", with their own return shapes in `empties_return_units`.
-- A product ALREADY says what it comes in and which of those shapes come back — that is what the
-- four ticks on the shape are for. So the shop said it twice, in two vocabularies, and the second
-- one could disagree with the first.
--
-- Two ledgers, then, each answering one question:
--
--   `customer_deposits`  money the shop is holding, and where it went. No pool, no quantity.
--   `customer_empties`   containers owed back, IN THE PRODUCT'S OWN SHAPE.
--
-- Both append-only, because both are money or goods somebody will dispute one day.
--
-- NOTHING IS DROPPED HERE. `deposit_ledger`, `empties_categories` and the screens reading them keep
-- working exactly as they do; these tables are new and the UI moves over onto them. Retiring the
-- old path is a separate step, taken once nothing reads it.

-- ─── Money the shop is holding ──────────────────────────────────────────────────────

create table if not exists public.customer_deposits (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  store_customer_id uuid not null references public.store_customers (id) on delete restrict,

  /*
   * WHAT HAPPENED TO IT, and all three are ordinary.
   *
   *   taken     — the shop received money to hold.
   *   given     — it was handed back.
   *   retained  — the shop kept it, against breakage or a loss, and said why.
   *
   * `retained` is separate from `given` because it is INCOME and the other is not. Netting them
   * into one signed figure would make a shop's takings unexplainable during a dispute, which is
   * the same reason `deposit_forfeits` was a table rather than a subtraction.
   */
  direction   text not null check (direction in ('taken', 'given', 'retained')),
  amount      money_amt not null check (amount > 0),

  -- Required for anything but taking it. "Where did my deposit go" is the question this table
  -- exists to answer, and an unexplained retention is the answer nobody accepts.
  reason      text,

  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),

  constraint customer_deposits_reason_when_leaving
    check (direction = 'taken' or btrim(coalesce(reason, '')) <> '')
);

create index if not exists customer_deposits_customer_idx
  on public.customer_deposits (store_customer_id, occurred_at desc);
create index if not exists customer_deposits_store_idx
  on public.customer_deposits (store_id, occurred_at desc);

comment on table public.customer_deposits is
  'Money the shop holds for a customer, and every move of it. Deliberately NOT joined to empties: '
  'a deposit is a round sum agreed between two people, not a quantity of crates at a rate. Partial '
  'returns are ordinary, so this is a ledger and never a column.';

create trigger no_mutation before update or delete on public.customer_deposits
  for each row execute function public.tg_append_only();

alter table public.customer_deposits enable row level security;

create policy customer_deposits_read on public.customer_deposits
  for select using (public.is_store_member(store_id));

-- Written only through the functions below, which check the permission AND that the customer is
-- this shop's — the hole 0097 closed across the four old deposit writers.
create policy customer_deposits_no_insert on public.customer_deposits
  for insert with check (false);

-- ─── Containers owed back, in the shape they left in ────────────────────────────────

create table if not exists public.customer_empties (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores (id) on delete cascade,
  store_customer_id uuid not null references public.store_customers (id) on delete restrict,

  /*
   * THE PRODUCT AND THE SHAPE, which is the whole change.
   *
   * A pool said "NBL crate" and a product said "Goldberg, sold in crates, the crate comes back".
   * Those are the same fact written twice, and only the second one is checkable: it is on the
   * product, the shop entered it on the product form, and the till already sells in it.
   *
   * `product_unit_id` is the shape — three crates of Goldberg is three of THAT row, not
   * thirty-six bottles. Which is what a shop says, and what it can count on a step.
   */
  product_id      uuid not null references public.products (id) on delete restrict,
  product_unit_id uuid not null references public.product_units (id) on delete restrict,

  /*
   *   out       — they took them: a sale, or what they already had when the account opened.
   *   returned  — they brought them back.
   *   damaged   — agreed gone. Broken, lost, kept. The obligation closes without the thing.
   *
   * Partial returns are the normal case and this is why it is a ledger: three crates back on
   * Tuesday and two on Friday are two rows, and the account can say so.
   */
  direction text not null check (direction in ('out', 'returned', 'damaged')),
  qty       qty  not null check (qty > 0),

  reason    text,
  -- What caused it, when something did: a sale, an opening balance. Null for a hand-entered line.
  ref_table text,
  ref_id    uuid,

  occurred_at timestamptz not null default now(),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists customer_empties_customer_idx
  on public.customer_empties (store_customer_id, occurred_at desc);
create index if not exists customer_empties_store_idx
  on public.customer_empties (store_id, occurred_at desc);
create index if not exists customer_empties_shape_idx
  on public.customer_empties (store_customer_id, product_unit_id);

comment on table public.customer_empties is
  'Containers a customer owes back, counted in the PRODUCT SHAPE they left in — three crates of '
  'Goldberg, not thirty-six bottles and not a pool called "NBL crate". Grouping for display (all '
  'NBL together) is done from the product groups at read time, never stored.';

create trigger no_mutation before update or delete on public.customer_empties
  for each row execute function public.tg_append_only();

alter table public.customer_empties enable row level security;

create policy customer_empties_read on public.customer_empties
  for select using (public.is_store_member(store_id));

create policy customer_empties_no_insert on public.customer_empties
  for insert with check (false);
