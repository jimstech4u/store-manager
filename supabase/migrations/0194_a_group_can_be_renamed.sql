-- 0194 — A group can be renamed
--
-- A shop invents groups from the picker, mid-sale, while somebody is waiting — which means it
-- invents typos too. `create_product_group` and `archive_product_group` have existed since the
-- groups work; renaming has not, so a group named "Bear" could only ever be retired and replaced,
-- which orphans every product in it from the name they were filed under.
--
-- The same shape as `rename_store_unit`, and for the same reason: every product points at the
-- group rather than holding a copy of its name, so correcting it here corrects it everywhere at
-- once. Renaming is safe; retiring is the one that needs the warning.

create or replace function public.rename_product_group(p_category_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  if coalesce(btrim(p_name), '') = '' then
    raise exception 'a group needs a name' using errcode = '22023';
  end if;

  /*
   * A name another live group already has is refused.
   *
   * `create_product_group` RETURNS the existing one instead of refusing, because it is called
   * from a picker by somebody who does not know whether it exists. Renaming is the opposite
   * gesture — deliberate, from a settings screen — and silently merging two groups because their
   * names collided would move every product in one of them without being asked.
   */
  if exists (
    select 1 from public.product_categories c
     where c.store_id = v_store
       and c.id <> p_category_id
       and c.status = 'active'
       and lower(btrim(c.name)) = lower(btrim(p_name))
  ) then
    raise exception 'You already have a group called that.' using errcode = '23505';
  end if;

  update public.product_categories
     set name = btrim(p_name)
   where id = p_category_id;
end;
$$;

grant execute on function public.rename_product_group(uuid, text) to authenticated;
