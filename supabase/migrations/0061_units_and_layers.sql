-- ════════════════════════════════════════════════════════════════════════════════════════════
-- The catalogue, rebuilt around units the shop owns and cost the shop can trace
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Three things change together, because each is useless without the others.
--
-- UNITS BELONG TO THE SHOP. `units` is a fixed global list of nine codes, so a distributor selling
-- in kegs, rubbers or paint buckets has nowhere to put them. A shop names its own now, in singular
-- and plural, because "1 packs" on a receipt is the kind of thing that makes a business look
-- careless to its own customers.
--
-- A PRODUCT IS HANDLED IN UNITS, not in a base unit with packs bolted on. `product_packs` said how
-- many pieces are in a pack; it could not say that a pack is what you BUY and a piece is what you
-- SELL, which is the ordinary shape of every business here. One table now says both, and carries
-- the rules that go with selling in that unit: its price, whether the empties come back, and which
-- fractions of it a customer may buy.
--
-- COST IS TRACED IN LAYERS. The moving average was chosen deliberately and its reasoning is sound
-- — it survives negative stock and it is explainable. It cannot answer the question a shopkeeper
-- actually asks when setting a price: "the dearest stock I am still holding cost me what?" After a
-- cheaper delivery the average drops immediately while the expensive crates are still on the
-- shelf, and pricing against it sells them at a loss. Layers answer it, and the answer is the one
-- that stops money leaking.
--
-- ADDITIVE ONLY. Nothing is dropped here and every existing table still works: the readers move
-- over in the next step, and a migration that breaks a live till halfway through a deploy is not
-- worth the tidiness.

-- ─── Units the shop owns ────────────────────────────────────────────────────────────

create table if not exists public.store_units (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,

  /** What one of them is called: "Pack", "Crate", "Piece", "Keg". */
  name       text not null,
  /**
   * And what more than one is called.
   *
   * Not derived by adding an "s". "Boxes", "Kilogrammes" and "Cartons of 12" are all things a
   * shop says, and a receipt reading "2 Boxs" is worse than one that says nothing at all.
   */
  plural     text not null,

  /**
   * The shop's smallest unit for this thing, against which everything else is measured.
   *
   * Exactly one per product is marked as the base in `product_units`; this flag is about the unit
   * itself being indivisible — a piece cannot be broken down, a kilogramme can.
   */
  divisible  boolean not null default false,

  created_at timestamptz not null default now(),
  unique (store_id, name)
);

create index if not exists store_units_store_idx on public.store_units (store_id);

alter table public.store_units enable row level security;

create policy store_units_read on public.store_units
  for select to authenticated using (public.is_store_member(store_id));

create policy store_units_write on public.store_units
  for all to authenticated
  using (public.has_permission(store_id, 'products.manage'))
  with check (public.has_permission(store_id, 'products.manage'));

/*
 * Every existing shop starts with the units it is already using.
 *
 * Taken from the global list rather than invented, so nothing a shop has already entered stops
 * making sense — and the plural is the one a Nigerian shop actually says.
 */
/*
 * EVERY global unit, so no existing product is left without one.
 *
 * The nine in `units` are what products already point at through `base_unit` — miss one and that
 * product gets no base row and silently stops being sellable. The extras are the containers a
 * Nigerian distributor actually deals in, seeded so a shop is not made to type them on day one.
 */
insert into public.store_units (store_id, name, plural, divisible)
select s.id, u.name, u.plural, u.divisible
from public.stores s
cross join (
  -- The global list, pluralised. `allows_fraction` already says which can be divided.
  select gu.name,
         case gu.name when 'Centilitre' then 'Centilitres' else gu.name || 's' end as plural,
         gu.allows_fraction as divisible
    from public.units gu
  union
  select * from (values
    ('Pack',    'Packs',    false),
    ('Crate',   'Crates',   false),
    ('Carton',  'Cartons',  false),
    ('Bag',     'Bags',     false),
    ('Bottle',  'Bottles',  false),
    ('Keg',     'Kegs',     false)
  ) as extra(name, plural, divisible)
) as u(name, plural, divisible)
on conflict (store_id, name) do nothing;

-- ─── How a product is handled ───────────────────────────────────────────────────────

create table if not exists public.product_units (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references public.products (id) on delete cascade,
  store_unit_id uuid not null references public.store_units (id) on delete restrict,

  /**
   * How many BASE units one of these is. 1 for the base itself, 12 for a pack of twelve.
   *
   * Everything — stock, cost, counts — is held in base units, because that is the only figure two
   * different units can be added up in.
   */
  base_qty      qty not null check (base_qty > 0),

  /** Deliveries arrive in this. Shown under "Bought in". */
  is_bought     boolean not null default false,
  /** Customers buy in this. Shown under "Sold in". */
  is_sold       boolean not null default false,

  /** What one costs, per unit, when it is sold. Null while a unit is only ever bought in. */
  sell_price    money_amt check (sell_price >= 0),

  /**
   * The container comes back.
   *
   * Set on the unit rather than asked on every sale: a crate of Gulder is returnable because it is
   * a crate, and making a seller confirm that on each line is a question with one answer.
   */
  is_returnable boolean not null default false,

  /**
   * Which quantities a customer may buy.
   *
   * `whole_digit` with no fractions means 1, 2, 3. Allowing halves means 0.5, 1, 1.5. A shop that
   * sells half crates and quarter bags says so once here, and every sale screen then offers
   * exactly those and refuses the rest — which is what stops "4.3 crates" reaching a receipt.
   */
  whole_digit   boolean not null default true,
  allow_quarter boolean not null default false,
  allow_half    boolean not null default false,
  allow_three_quarter boolean not null default false,

  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (product_id, store_unit_id)
);

create index if not exists product_units_product_idx on public.product_units (product_id, sort_order);

create trigger touch_updated_at before update on public.product_units
  for each row execute function public.tg_touch_updated_at();

alter table public.product_units enable row level security;

create policy product_units_read on public.product_units
  for select to authenticated
  using (exists (select 1 from public.products p
                  where p.id = product_id and public.is_store_member(p.store_id)));

create policy product_units_write on public.product_units
  for all to authenticated
  using (exists (select 1 from public.products p
                  where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                       where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

/*
 * Everything already in the catalogue arrives here.
 *
 * The base unit first, then each pack as a unit of its own carrying the conversion it already
 * held. Sale units and prices come across in the next step, once the readers are ready for them —
 * this migration is deliberately only as far as it can go without changing what anything reads.
 */
insert into public.product_units (product_id, store_unit_id, base_qty, is_bought, is_sold, sort_order)
select p.id, su.id, 1, true, true, 0
from public.products p
join public.units gu on gu.code = p.base_unit
join public.store_units su on su.store_id = p.store_id and su.name = gu.name
on conflict (product_id, store_unit_id) do nothing;

insert into public.product_units (product_id, store_unit_id, base_qty, is_bought, is_sold, sort_order)
select pk.product_id, su.id, pk.base_unit_qty, true, true, 1
from public.product_packs pk
join public.products p on p.id = pk.product_id
join public.store_units su on su.store_id = p.store_id and su.name = pk.name
on conflict (product_id, store_unit_id) do nothing;

-- ─── What each layer of stock cost ──────────────────────────────────────────────────

create table if not exists public.stock_layers (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores (id) on delete cascade,
  product_id   uuid not null references public.products (id) on delete cascade,

  /** In BASE units, always — two deliveries in different units still add up. */
  qty_base     qty not null check (qty_base > 0),
  /**
   * How much of this delivery is left.
   *
   * Sales consume the oldest layer first. When it reaches zero the layer stays: it is the record
   * of what that stock cost, and margin on a sale made last month must not change because this
   * month's delivery was cheaper.
   */
  remaining_base qty not null check (remaining_base >= 0),

  /** What one BASE unit of this layer cost, fees and rebates already worked in. */
  unit_cost    unit_cost not null check (unit_cost >= 0),

  /** Where it came from, so a cost can always be traced back to a delivery. */
  ref_table    text,
  ref_id       uuid,

  received_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  constraint stock_layer_remaining_sane check (remaining_base <= qty_base)
);

create index if not exists stock_layers_fifo_idx
  on public.stock_layers (store_id, product_id, received_at)
  where remaining_base > 0;

alter table public.stock_layers enable row level security;

create policy stock_layers_read on public.stock_layers
  for select to authenticated using (public.is_store_member(store_id));

/*
 * Written by the functions that receive and sell stock, never by a client.
 *
 * A layer is an accounting record. Letting a browser insert one would mean letting a browser
 * decide what its own margin was.
 */
create policy stock_layers_write on public.stock_layers
  for all to authenticated using (false) with check (false);

/*
 * What is on the shelf now becomes one opening layer, at the average it was carried at.
 *
 * Not an attempt to reconstruct history: the batches that made up today's stock were never
 * recorded, so inventing them would be inventing costs. One honest layer at the figure the shop
 * has been using, and every delivery from here is traced properly.
 */
insert into public.stock_layers (store_id, product_id, qty_base, remaining_base, unit_cost, ref_table, received_at)
select p.store_id,
       p.id,
       greatest(onhand.qty, 0),
       greatest(onhand.qty, 0),
       p.avg_unit_cost,
       'opening',
       now()
from public.products p
join lateral (
  select coalesce(sum(m.qty_delta), 0) as qty
    from public.stock_movements m
   where m.product_id = p.id
) onhand on true
where onhand.qty > 0;

/**
 * The dearest stock still on the shelf.
 *
 * THE FIGURE TO PRICE AGAINST. The average drops the moment a cheaper delivery lands, while the
 * expensive crates are still there to be sold — so pricing against the average sells them at a
 * loss and the books only notice later. This answers what the shopkeeper is really asking.
 *
 * Falls back to the average when there are no layers at all, so a shop mid-migration is never
 * shown zero and told everything is profitable.
 */
create or replace function public.dearest_live_cost(p_product_id uuid)
returns unit_cost
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select max(l.unit_cost)
       from public.stock_layers l
       join public.products p on p.id = l.product_id
      where l.product_id = p_product_id
        and l.remaining_base > 0
        and public.is_store_member(p.store_id)),
    (select p.avg_unit_cost from public.products p
      where p.id = p_product_id and public.is_store_member(p.store_id)),
    0
  );
$$;

grant execute on function public.dearest_live_cost(uuid) to authenticated;
