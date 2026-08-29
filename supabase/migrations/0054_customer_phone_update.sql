-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Recording a customer's number when you reach them on a new one
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- A shop sends a receipt on WhatsApp, discovers the number on file is old, types the new one and
-- gets through. That new number is the useful one, and asking somebody to go and record it
-- separately is asking for it never to be recorded.
--
-- The phone lives on the IDENTITY, not the store's own row: one person may be a customer of
-- several shops here, and a number is a fact about the person. Which is exactly why this is
-- guarded — a shop may correct the number of somebody it trades with, and nothing else.

create or replace function public.update_customer_phone(p_customer_id uuid, p_phone text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store    uuid;
  v_identity uuid;
begin
  select sc.store_id, sc.identity_id
    into v_store, v_identity
    from public.store_customers sc
   where sc.id = p_customer_id;

  if v_store is null then
    raise exception 'no such customer' using errcode = 'P0002';
  end if;

  if not public.has_permission(v_store, 'customers.manage') then
    raise exception 'you do not have permission to change customer details' using errcode = '42501';
  end if;

  -- Blank is not a correction. Clearing a number is a deliberate act and does not belong on the
  -- path where somebody is trying to send a receipt.
  if nullif(trim(coalesce(p_phone, '')), '') is null then
    return;
  end if;

  update public.identities
     set phone = trim(p_phone)
   where id = v_identity;
end;
$$;

grant execute on function public.update_customer_phone(uuid, text) to authenticated;
