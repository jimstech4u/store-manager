-- 0093 — A product belongs to GROUPS, and a shop can make them
--
-- «product group like NBL and Guiness and all is something that we should be able to add in new or
--  edit product form where new groups is selectable in selectionviewer and new added mid addition
--  just like customerpicker and product picker and then each can even have multiple top groups»
--
-- `product_categories` has held three rows since the shop was seeded — PET, Beer, Can — and every
-- product form has sent `p_category_id: null` since the day it was written. So the column is read
-- (the stock list shows the name) and never written: a category can be displayed and never chosen.
-- There is also no function to make one, so the three that exist are the three there will ever be.
--
-- The other half is the shape of it. One category per product cannot say what a shop actually
-- means: Goldberg is a BEER, it comes in a PET bottle, and NIGERIAN BREWERIES made it.
--
-- The maker is the grouping that earns its keep. The empties belong to the brewery and are
-- interchangeable across everything bought from it — an NBL crate takes any NBL bottle, whether it
-- held Star, Gulder or Goldberg — which is exactly why `empties_categories` names its pools
-- "NBL crate" and "NBL bottle" rather than one per brand. "Who made it" is what the lorry asks when
-- it comes to collect; "what shelf does it sit on" is a different question with a different answer.
--
-- So: many-to-many, a writer for each verb, and groups a shop can name for itself.

-- ─── Retiring one, rather than deleting it ──────────────────────────────────────────
--
-- A group that has ever been used is on products, and products are on receipts. Retired groups stay
-- and stop being offered.

alter table public.product_categories
  add column if not exists status text not null default 'active'
    check (status in ('active', 'archived'));

-- ─── The join ───────────────────────────────────────────────────────────────────────

create table if not exists public.product_category_links (
  product_id  uuid not null references public.products (id) on delete cascade,
  category_id uuid not null references public.product_categories (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (product_id, category_id)
);

comment on table public.product_category_links is
  'Which groups a product belongs to. Many-to-many because a shop means several things at once by '
  '"what is this": Goldberg is a beer, it comes in a PET bottle, and Nigerian Breweries made it. '
  'The maker is the one that earns its keep, because a brewery''s empties come back interchangeably '
  'across everything bought from it. ON DELETE CASCADE both ways — a link is not a fact about '
  'anything once either end is gone, unlike a ledger row.';

create index if not exists product_category_links_by_category
  on public.product_category_links (category_id);

alter table public.product_category_links enable row level security;

drop policy if exists product_category_links_read on public.product_category_links;
create policy product_category_links_read on public.product_category_links
  for select using (
    exists (
      select 1 from public.products p
       where p.id = product_id and public.is_store_member(p.store_id)
    )
  );

/*
 * Written only through the RPC below, which is where the permission is checked.
 *
 * No insert/update/delete policy at all: the writer is SECURITY DEFINER and checks
 * `products.manage`, and a table with a write policy AND a definer writer has two answers to who
 * may write it, which is one more than anybody can keep in step.
 */

-- ─── What a shop already meant ──────────────────────────────────────────────────────
--
-- `products.category_id` has been the single category. Every product that has one gets a link, so
-- nothing is lost and the new reader agrees with the old column on day one.

insert into public.product_category_links (product_id, category_id)
select p.id, p.category_id
  from public.products p
 where p.category_id is not null
on conflict do nothing;

-- ─── Making a group ─────────────────────────────────────────────────────────────────

create or replace function public.create_product_group(p_store_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  if not public.has_permission(p_store_id, 'products.manage') then
    raise exception 'you do not have permission to manage products' using errcode = '42501';
  end if;

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'a group needs a name' using errcode = '22023';
  end if;

  /*
   * An existing group by that name is RETURNED, not refused.
   *
   * This is called from inside a picker, mid-sale, by somebody typing "NBL" who does not know
   * whether it exists — the same gesture the customer and product pickers already support. An
   * error there would be the app telling them off for not remembering their own data.
   */
  select id into v_id
    from public.product_categories
   where store_id = p_store_id
     and lower(btrim(name)) = lower(btrim(p_name));

  if v_id is not null then
    update public.product_categories set status = 'active' where id = v_id;
    return v_id;
  end if;

  insert into public.product_categories (store_id, name)
  values (p_store_id, btrim(p_name))
  returning id into v_id;

  return v_id;
end;
$fn$;

revoke all on function public.create_product_group(uuid, text) from public;
grant execute on function public.create_product_group(uuid, text) to authenticated;

-- ─── Saying which groups a product is in ────────────────────────────────────────────

create or replace function public.set_product_groups(p_product_id uuid, p_group_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
  v_first uuid;
begin
  select store_id into v_store from public.products where id = p_product_id;
  if v_store is null then
    raise exception 'That product does not exist.' using errcode = '22023';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to manage products' using errcode = '42501';
  end if;

  -- A group belonging to another shop would put somebody else's word on this product.
  if exists (
    select 1 from unnest(coalesce(p_group_ids, '{}')) g
     where not exists (
       select 1 from public.product_categories c where c.id = g and c.store_id = v_store
     )
  ) then
    raise exception 'one of those groups is not yours' using errcode = '22023';
  end if;

  delete from public.product_category_links where product_id = p_product_id;

  insert into public.product_category_links (product_id, category_id)
  select p_product_id, g from unnest(coalesce(p_group_ids, '{}')) g
  on conflict do nothing;

  /*
   * `products.category_id` IS KEPT IN STEP, holding the first group.
   *
   * Not because the model needs it — the join is the truth now — but because the stock list, the
   * product page and `list_products` all read that column today, and a migration that leaves them
   * showing nothing while the new reader is wired in would be a regression a shop notices
   * immediately. It is a denormalisation with an owner, which is the only kind worth having.
   */
  select g into v_first from unnest(coalesce(p_group_ids, '{}')) with ordinality t(g, n)
   order by n limit 1;

  update public.products set category_id = v_first where id = p_product_id;
end;
$fn$;

revoke all on function public.set_product_groups(uuid, uuid[]) from public;
grant execute on function public.set_product_groups(uuid, uuid[]) to authenticated;

-- ─── Retiring one ───────────────────────────────────────────────────────────────────

create or replace function public.archive_product_group(p_category_id uuid, p_restore boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_store uuid;
begin
  select store_id into v_store from public.product_categories where id = p_category_id;
  if v_store is null then
    raise exception 'That group does not exist.' using errcode = '22023';
  end if;

  if not public.has_permission(v_store, 'products.manage') then
    raise exception 'you do not have permission to manage products' using errcode = '42501';
  end if;

  -- Products keep the group they are in. Retiring takes it out of the picker, nothing else: a
  -- receipt that says "Beer" should go on saying it.
  update public.product_categories
     set status = case when p_restore then 'active' else 'archived' end
   where id = p_category_id;
end;
$fn$;

revoke all on function public.archive_product_group(uuid, boolean) from public;
grant execute on function public.archive_product_group(uuid, boolean) to authenticated;

-- ─── Reading them ───────────────────────────────────────────────────────────────────

create or replace function public.store_product_groups(p_store_id uuid)
returns table (id uuid, name text, products int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id,
         c.name,
         -- How many products are in it, so a picker can say which groups a shop actually uses and
         -- a settings screen can say what retiring one would affect.
         (select count(*)::int from public.product_category_links l where l.category_id = c.id)
    from public.product_categories c
   where c.store_id = p_store_id
     and c.status = 'active'
     and public.is_store_member(p_store_id)
   order by c.name;
$$;

revoke all on function public.store_product_groups(uuid) from public;
grant execute on function public.store_product_groups(uuid) to authenticated;

create or replace function public.product_groups_for(p_product_id uuid)
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.name
    from public.product_category_links l
    join public.product_categories c on c.id = l.category_id
    join public.products p on p.id = l.product_id
   where l.product_id = p_product_id
     and public.is_store_member(p.store_id)
   order by c.name;
$$;

revoke all on function public.product_groups_for(uuid) from public;
grant execute on function public.product_groups_for(uuid) to authenticated;

do $check$
declare n int;
begin
  for n in
    select count(*) from pg_proc pr join pg_namespace ns on ns.oid = pr.pronamespace
     where ns.nspname = 'public'
       and pr.proname in ('create_product_group', 'set_product_groups', 'archive_product_group',
                          'store_product_groups', 'product_groups_for')
     group by pr.proname
  loop
    if n <> 1 then
      raise exception 'a group function has % overloads', n;
    end if;
  end loop;
end;
$check$;
