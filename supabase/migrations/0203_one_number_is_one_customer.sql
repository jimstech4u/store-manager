-- 0203 - One number is one customer, and a second name does not take the first one's place
--
-- Reported from the shop, and it had already cost them a day's books: Kadijat was added, sold to
-- three times, and then Dcc was added ON THE SAME PHONE NUMBER. Kadijat's record was RENAMED to
-- Dcc, her id was handed back, and Dcc's sale was recorded against it. One record, two customers,
-- four sales, and no way to tell from the screen which crates belonged to whom.
--
-- `upsert_customer` resolves the number to a shared identity - which is the right design, and is
-- how one person known to two shops stays one person - and then:
--
--     on conflict (store_id, identity_id) do update
--       set display_name = excluded.display_name
--
-- The comment above that line reads "An existing customer keeps their name unless a new one is
-- actually supplied: re-selecting someone during a sale must not blank the label this store
-- already recorded for them." That is the right rule. The line does not implement it: the name is
-- never null - the function raises when it is blank - so `excluded.display_name` always wins and
-- the rename is unconditional. The comment described an intention nobody had written down in SQL.
--
-- The fix is not to quietly keep the old name either, because that is the same wrong attribution
-- with the evidence removed: the seller would have typed "Dcc", seen a customer saved, and had the
-- sale land on Kadijat with nothing on screen to show it. A collision is a REAL QUESTION about the
-- world - are these two people, or one person typed twice? - and only the shop can answer it. So
-- it is put to them, by name.
--
-- Nothing else changes. The insert, the business-name coalesce and the permission check are as they
-- were.

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
begin
  if not public.has_permission(p_store_id, 'customers.manage') then
    raise exception 'you do not have permission to add customers' using errcode = '42501';
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'a customer needs a name' using errcode = '22023';
  end if;

  v_identity := public.resolve_identity(p_phone);

  /*
   * WHOSE NUMBER IS THIS ALREADY?
   *
   * Asked before anything is written. The same name again is the ordinary case - somebody
   * re-entered a customer this shop already has - and it passes straight through to the upsert,
   * which leaves the row as it stands. A DIFFERENT name on a number this shop has already given to
   * somebody is the case that cost Ashabi their day, and it stops here.
   *
   * Compared case-insensitively and trimmed, because "kadijat" and "Kadijat " are not two people,
   * and refusing over a capital letter would teach the shop to work around this message.
   */
  select display_name into v_existing
    from public.store_customers
   where store_id = p_store_id and identity_id = v_identity;

  if v_existing is not null
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
    -- Reached only when the name is the same one already stored, so this no longer renames anybody.
    set display_name  = excluded.display_name,
        business_name = coalesce(excluded.business_name, public.store_customers.business_name)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.upsert_customer(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
