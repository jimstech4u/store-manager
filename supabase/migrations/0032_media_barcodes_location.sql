-- =====================================================================================
-- 0032 — Pictures, barcodes and where a shop actually is
--
-- Three things that turn this from a ledger into a shopfront, and from a drinks tool into a
-- general point of sale.
--
-- 1. MEDIA. Products and shops get several images and optional video, ordered, with one primary.
--    A marketplace without pictures is a spreadsheet, and nobody shops from a spreadsheet. Stored
--    in Supabase Storage; only the path is kept here, so the database never holds bytes.
--
-- 2. BARCODES. Scan to find, scan to add. This is what makes the product usable beyond drinks —
--    clothing, provisions, anything with a label. A barcode is per STORE, not global: the same
--    EAN can sit on two shops' shelves, and one shop's private SKU must not collide with
--    another's.
--
-- 3. LOCATION. A pin, an address, and a distance search. "Shops near me" is the first thing a
--    shopper wants from a marketplace, and a distributor's catchment is physical.
-- =====================================================================================

-- ─── Media ──────────────────────────────────────────────────────────────────────────

create table if not exists public.product_media (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  kind       text not null default 'image' check (kind in ('image', 'video')),
  /** Path within the storage bucket. Never a full URL — the host can change; the path cannot. */
  path       text not null,
  alt        text,
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists product_media_idx on public.product_media (product_id, sort_order);

create table if not exists public.store_media (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  kind       text not null default 'image' check (kind in ('image', 'video')),
  path       text not null,
  alt        text,
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists store_media_idx on public.store_media (store_id, sort_order);

alter table public.product_media enable row level security;
alter table public.store_media   enable row level security;

-- Readable by anyone when the shop is public — that is the entire point of a shopfront picture.
create policy product_media_read on public.product_media
  for select to anon, authenticated
  using (exists (
    select 1 from public.products p join public.stores s on s.id = p.store_id
    where p.id = product_id and (s.is_public or public.is_store_member(s.id))
  ));

create policy product_media_write on public.product_media
  for all to authenticated
  using (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')))
  with check (exists (select 1 from public.products p
                 where p.id = product_id and public.has_permission(p.store_id, 'products.manage')));

create policy store_media_read on public.store_media
  for select to anon, authenticated
  using (exists (select 1 from public.stores s
                 where s.id = store_id and (s.is_public or public.is_store_member(s.id))));

create policy store_media_write on public.store_media
  for all to authenticated
  using (public.has_permission(store_id, 'store.settings'))
  with check (public.has_permission(store_id, 'store.settings'));

-- ─── Storage bucket ─────────────────────────────────────────────────────────────────
--
-- Public-read: these are shopfront pictures meant to be seen, and signing every thumbnail on a
-- marketplace grid would be latency for no privacy — the images are already public information
-- once a shop opts in. WRITING is another matter and is restricted below.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 10485760,
        array['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm'])
on conflict (id) do update
  set public = true,
      file_size_limit = 10485760,
      allowed_mime_types = excluded.allowed_mime_types;

-- Paths are `<store_id>/...`, so a member can only write inside their own shop's folder. Without
-- this any signed-in user could overwrite another shop's pictures.
drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'media');

drop policy if exists media_insert on storage.objects;
create policy media_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and public.is_store_member(nullif(split_part(name, '/', 1), '')::uuid)
  );

drop policy if exists media_update on storage.objects;
create policy media_update on storage.objects
  for update to authenticated
  using (bucket_id = 'media'
         and public.is_store_member(nullif(split_part(name, '/', 1), '')::uuid));

drop policy if exists media_delete on storage.objects;
create policy media_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'media'
         and public.is_store_member(nullif(split_part(name, '/', 1), '')::uuid));

-- ─── Barcodes ───────────────────────────────────────────────────────────────────────

alter table public.products
  add column if not exists barcode text;

-- Unique per STORE. The same EAN legitimately appears in two shops, and a global unique would
-- stop the second shop from ever adding it.
create unique index if not exists products_barcode_store_key
  on public.products (store_id, barcode) where barcode is not null;

/**
 * Find a product by a scanned code.
 *
 * Returns null rather than raising when nothing matches: an unknown barcode is a normal event at
 * a counter — a new line the shop has not added yet — and the app answers it by offering to
 * create the product, not by showing an error.
 */
create or replace function public.product_by_barcode(p_store_id uuid, p_barcode text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id,
    'name', p.name,
    'base_unit', p.base_unit,
    'barcode', p.barcode,
    'on_hand', coalesce((select sum(m.qty_delta) from public.stock_movements m
                          where m.product_id = p.id), 0)
  )
  from public.products p
  where p.store_id = p_store_id
    and p.barcode = trim(p_barcode)
    and p.status = 'active'
    and public.is_store_member(p_store_id);
$$;

-- ─── Location ───────────────────────────────────────────────────────────────────────

alter table public.stores
  add column if not exists address   text,
  add column if not exists latitude  numeric(9, 6),
  add column if not exists longitude numeric(9, 6);

/**
 * Distance in kilometres, by the haversine formula.
 *
 * Deliberately plain arithmetic rather than PostGIS: "shops within 20km" needs accuracy of a few
 * hundred metres, which this gives comfortably, and adding a spatial extension for one query is
 * a dependency the project would carry forever.
 */
create or replace function public.distance_km(
  lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric
)
returns numeric
language sql
immutable
as $$
  select case
    when lat1 is null or lon1 is null or lat2 is null or lon2 is null then null
    else round((
      6371 * acos(
        least(1.0, greatest(-1.0,
          cos(radians(lat1)) * cos(radians(lat2)) * cos(radians(lon2) - radians(lon1))
          + sin(radians(lat1)) * sin(radians(lat2))
        ))
      )
    )::numeric, 2)
  end;
$$;

/** Public shops, nearest first when a position is given. */
create or replace function public.public_stores_near(
  p_lat    numeric default null,
  p_lon    numeric default null,
  p_query  text default null,
  p_within_km numeric default null,
  p_limit  int default 24
)
returns table (
  id            uuid,
  name          text,
  code          text,
  description   text,
  address       text,
  latitude      numeric,
  longitude     numeric,
  distance_km   numeric,
  product_count bigint,
  cover_path    text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select s.id, s.name, s.code, s.public_description, s.address, s.latitude, s.longitude,
         public.distance_km(p_lat, p_lon, s.latitude, s.longitude),
         (select count(*) from public.products p
           where p.store_id = s.id and p.status = 'active' and p.confirmed_at is not null),
         (select sm.path from public.store_media sm
           where sm.store_id = s.id and sm.kind = 'image'
           order by sm.sort_order limit 1)
  from public.stores s
  cross join q
  where s.is_public
    and s.onboarded_at is not null
    and (q.term is null
         or s.name ilike '%' || q.term || '%'
         or s.address ilike '%' || q.term || '%'
         or s.public_description ilike '%' || q.term || '%')
    and (
      p_within_km is null
      or p_lat is null
      -- A shop with no pin is not excluded by a radius filter: it may well be nearby, and
      -- hiding it would punish the shop for not having set a location yet.
      or s.latitude is null
      or public.distance_km(p_lat, p_lon, s.latitude, s.longitude) <= p_within_km
    )
  order by
    case when p_lat is null or s.latitude is null then 1 else 0 end,
    public.distance_km(p_lat, p_lon, s.latitude, s.longitude) nulls last,
    s.name
  limit greatest(1, least(coalesce(p_limit, 24), 60));
$$;

-- ─── Public product listing, now with a picture ─────────────────────────────────────
--
-- Dropped and recreated rather than replaced: adding OUT columns changes the row type, which
-- CREATE OR REPLACE cannot do. Nothing depends on the old shape except the client, which is
-- deployed alongside this.

drop function if exists public.public_products(text, uuid, text, text, uuid, int);

create or replace function public.public_products(
  p_query       text default null,
  p_store_id    uuid default null,
  p_category    text default null,
  p_after_name  text default null,
  p_after_id    uuid default null,
  p_limit       int  default 24
)
returns table (
  id           uuid,
  name         text,
  category     text,
  store_id     uuid,
  store_name   text,
  store_code   text,
  unit_label   text,
  price        money_amt,
  has_bulk     boolean,
  in_stock     boolean,
  image_path   text,
  media_count  bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (select nullif(trim(coalesce(p_query, '')), '') as term)
  select p.id, p.name, c.name, s.id, s.name, s.code,
         coalesce(su.name, pk.name, p.base_unit),
         coalesce(su.price, pr.price),
         exists (select 1 from public.product_price_tiers t where t.product_id = p.id),
         coalesce((select sum(m.qty_delta) from public.stock_movements m
                    where m.product_id = p.id), 0) > 0,
         (select pm.path from public.product_media pm
           where pm.product_id = p.id and pm.kind = 'image'
           order by pm.sort_order limit 1),
         (select count(*) from public.product_media pm where pm.product_id = p.id)
  from public.products p
  cross join q
  join public.stores s on s.id = p.store_id
  left join public.product_categories c on c.id = p.category_id
  left join public.product_packs pk on pk.id = p.default_display_pack_id
  left join lateral (
    select su2.name, su2.price from public.product_sale_units su2
    where su2.product_id = p.id order by su2.sort_order, su2.base_qty desc limit 1
  ) su on true
  left join lateral (
    select pp.price from public.product_prices pp
    where pp.product_id = p.id order by (pp.pack_id is null) limit 1
  ) pr on true
  where s.is_public
    and s.onboarded_at is not null
    and p.status = 'active'
    and p.confirmed_at is not null
    and (p_store_id is null or p.store_id = p_store_id)
    and (p_category is null or c.name = p_category)
    and (q.term is null
         or p.name ilike '%' || q.term || '%'
         or c.name ilike '%' || q.term || '%'
         or s.name ilike '%' || q.term || '%'
         -- Scanning a barcode on the public site should find the item too.
         or p.barcode = trim(q.term)
         or similarity(p.name, q.term) > 0.25)
    and (p_after_name is null
         or (p.name, p.id) > (p_after_name, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  order by p.name, p.id
  limit greatest(1, least(coalesce(p_limit, 24), 60));
$$;

/** Every picture and clip for one product, for the gallery on its page. */
create or replace function public.public_product_media(p_product_id uuid)
returns table (kind text, path text, alt text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pm.kind, pm.path, pm.alt
  from public.product_media pm
  join public.products p on p.id = pm.product_id
  join public.stores s on s.id = p.store_id
  where pm.product_id = p_product_id
    and (s.is_public or public.is_store_member(s.id))
  order by pm.sort_order;
$$;

create or replace function public.public_store_media(p_store_id uuid)
returns table (kind text, path text, alt text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sm.kind, sm.path, sm.alt
  from public.store_media sm
  join public.stores s on s.id = sm.store_id
  where sm.store_id = p_store_id
    and (s.is_public or public.is_store_member(s.id))
  order by sm.sort_order;
$$;

grant execute on function public.product_by_barcode(uuid, text)                      to authenticated;
grant execute on function public.distance_km(numeric, numeric, numeric, numeric)     to anon, authenticated;
grant execute on function public.public_stores_near(numeric, numeric, text, numeric, int) to anon, authenticated;
grant execute on function public.public_products(text, uuid, text, text, uuid, int)  to anon, authenticated;
grant execute on function public.public_product_media(uuid)                          to anon, authenticated;
grant execute on function public.public_store_media(uuid)                            to anon, authenticated;
