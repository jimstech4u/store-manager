-- 0212 - Somebody taken off the list can be added back
--
-- "i added a customer (busayo), deleted and then wanted to add the same, but got this error":
--
--     That number already belongs to Busayo stores. Two customers cannot share one number...
--
-- My guard from 0203, and it was right about the collision and wrong about the state. It asks who
-- holds the number and never asks whether they are still on the list. Busayo was ARCHIVED — no
-- sales, no empties, nothing owed — so the shop was told its own number belonged to somebody it
-- had just removed, with no way forward: `store_customers` is unique on (store, identity), so a
-- second row cannot exist either.
--
-- Archiving is not deleting. It takes somebody out of the pickers and the People list and leaves
-- their history where it is, which is the right thing to do with a real account. Adding that
-- number again is the shop saying "they are back", and the only sensible answer is to bring them
-- back — under whatever they are called now, because a shop re-adding a customer types the name
-- it means today.
--
-- `create_product_group` has worked this way since it was written, for the same reason: "An
-- existing group by that name is RETURNED, not refused ... This is called from inside a picker,
-- mid-sale, by somebody typing who does not know whether it exists." A customer is no different.
--
-- The refusal stays exactly as it was for somebody still ON the list. That is the case it was
-- written for — two live customers sharing one number, which is how Kadijat became Dcc.

create or replace function public.upsert_customer(
  p_store_id uuid,
  p_phone text,
  p_display_name text,
  p_business_name text DEFAULT NULL::text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_identity uuid;
  v_id       uuid;
  v_existing text;
  v_status   text;
begin
  if not public.has_permission(p_store_id, 'customers.manage') then
    raise exception 'you do not have permission to add customers' using errcode = '42501';
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'a customer needs a name' using errcode = '22023';
  end if;

  v_identity := public.resolve_identity(p_phone);

  /*
   * WHOSE NUMBER IS THIS ALREADY, AND ARE THEY STILL ON THE LIST?
   *
   * The same name again is the ordinary case and passes straight through. A DIFFERENT name on a
   * number a LIVE customer holds is the case that cost Ashabi a day's books, and it still stops
   * here. A number held by somebody ARCHIVED is neither: it is the shop adding a customer back.
   */
  select display_name, coalesce(status, 'active')
    into v_existing, v_status
    from public.store_customers
   where store_id = p_store_id and identity_id = v_identity;

  if v_existing is not null
     and v_status <> 'archived'
     and lower(btrim(v_existing)) <> lower(btrim(p_display_name)) then
    raise exception
      'That number already belongs to %. Two customers cannot share one number, or their debts '
      'and empties end up on one book. Give % their own number, or pick % from the list if this '
      'is the same person.', v_existing, btrim(p_display_name), v_existing
      using errcode = '23505';
  end if;

  insert into public.store_customers (store_id, identity_id, display_name, business_name)
  values (p_store_id, v_identity, trim(p_display_name), nullif(trim(p_business_name), ''))
  on conflict (store_id, identity_id) do update
    -- Reached when the name is the one already stored, or when they were archived and are being
    -- added back — in which case they come back under what the shop calls them today.
    set display_name  = excluded.display_name,
        business_name = coalesce(excluded.business_name, public.store_customers.business_name),
        status        = 'active'
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.upsert_customer(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
