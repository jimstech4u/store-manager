-- 0279 - The shop has its own switch on what the agent may do
--
-- "Switch everything on, and have two controls: one from us, the switch on the registry, and the
-- store's own control under it." Uber's gateway has the same two: the platform decides what is
-- offered at all (`agent_tools.enabled`, set by the reviewed crawl), and each team decides what its
-- own agents may use. Here the team is the shop.
--
-- So: OURS — a function is in the registry and switched on, or it is not (the review file and the
-- crawler, a diff we approve). THEIRS — of what is on, the shop may switch any capability off for
-- itself (`store_agent_tools`), and only somebody with `store.settings` may. Everything starts on. The
-- person's own permissions still apply under both, and every change still waits for their YES.

create table if not exists public.store_agent_tools (
  store_id   uuid not null references public.stores (id) on delete cascade,
  name       text not null,              -- the registry's name; no key, a function can go and come back
  enabled    boolean not null,
  changed_by uuid default auth.uid(),
  changed_at timestamptz not null default now(),
  primary key (store_id, name)
);

alter table public.store_agent_tools enable row level security;

drop policy if exists store_agent_tools_read on public.store_agent_tools;
create policy store_agent_tools_read on public.store_agent_tools
  for select to authenticated using (public.is_store_member(store_id));
-- Written only through agent_set_capabilities, which checks the permission.

/** What the agent can do in this shop: everything we switched on, each with the shop's own answer. */
create or replace function public.agent_capabilities(p_store_id uuid)
returns table (name text, title text, description text, effect text, permission text, enabled boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.name, t.title, t.description, t.effect, t.permission, coalesce(s.enabled, true)
    from public.agent_tools t
    left join public.store_agent_tools s on s.store_id = p_store_id and s.name = t.name
   where t.enabled
     and public.is_store_member(p_store_id)
   order by t.title nulls last, t.name;
$$;

revoke all on function public.agent_capabilities(uuid) from public, anon;
grant execute on function public.agent_capabilities(uuid) to authenticated;

/** Switch some of them on or off for this shop. Returns how many changed. */
create or replace function public.agent_set_capabilities(p_store_id uuid, p_names text[], p_on boolean)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if not public.has_permission(p_store_id, 'store.settings') then
    raise exception 'only the owner or a manager can change what the agent may do' using errcode = '42501';
  end if;

  insert into public.store_agent_tools (store_id, name, enabled, changed_by, changed_at)
  select p_store_id, t.name, p_on, auth.uid(), now()
    from public.agent_tools t
   where t.name = any(coalesce(p_names, '{}')) and t.enabled
  on conflict (store_id, name) do update
     set enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = excluded.changed_at
   where store_agent_tools.enabled is distinct from excluded.enabled;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.agent_set_capabilities(uuid, text[], boolean) from public, anon;
grant execute on function public.agent_set_capabilities(uuid, text[], boolean) to authenticated;

/*
 * WHAT AN ID IS CALLED, for every kind of record a capability can now be handed. A proposal names
 * each one ("Void payment of ₦12,000 from Valuemart?"), and an id this cannot name is refused as not
 * this shop's — which, with the whole registry on, would have refused every payment, expense, count
 * period, unit, container kind and member.
 */
CREATE OR REPLACE FUNCTION public.agent_names(p_store_id uuid, p_ids uuid[])
 RETURNS TABLE(id uuid, label text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select x.id, x.label from (
    select p.id, p.name as label from public.products p where p.store_id = p_store_id and p.id = any(p_ids)
    union all
    select c.id, c.display_name from public.store_customers c where c.store_id = p_store_id and c.id = any(p_ids)
    union all
    select s.id, s.name from public.suppliers s where s.store_id = p_store_id and s.id = any(p_ids)
    union all
    select g.id, g.name from public.product_categories g where g.store_id = p_store_id and g.id = any(p_ids)
    union all
    select b.id, b.bank_name || ' ' || coalesce(b.account_name, '') from public.store_bank_accounts b
     where b.store_id = p_store_id and b.id = any(p_ids)
    union all
    select u.id, pr.name || ', by the ' || lower(su.name) from public.product_units u
      join public.products pr on pr.id = u.product_id
      join public.store_units su on su.id = u.store_unit_id
     where pr.store_id = p_store_id and u.id = any(p_ids)
    union all
    select s.id, 'receipt #' || upper(left(s.id::text, 8)) from public.sales s where s.store_id = p_store_id and s.id = any(p_ids)
    union all
    select o.id, 'order ' || o.code || coalesce(' for ' || o.label, '') from public.draft_orders o
     where o.store_id = p_store_id and o.id = any(p_ids)
    union all
    select l.id, pr.name || ' batch' || coalesce(', expires ' || to_char(l.expires_on, 'DD Mon YYYY'), '')
      from public.stock_layers l join public.products pr on pr.id = l.product_id
     where l.store_id = p_store_id and l.id = any(p_ids)
    -- 0279: everything else a capability can be handed.
    union all
    select pa.id, 'payment of ₦' || to_char(pa.amount, 'FM999,999,999,990.00') || coalesce(' from ' || c.display_name, '')
      from public.payments pa left join public.store_customers c on c.id = pa.store_customer_id
     where pa.store_id = p_store_id and pa.id = any(p_ids)
    union all
    select e.id, 'expense of ₦' || to_char(e.amount, 'FM999,999,999,990.00') || coalesce(', ' || e.note, '')
      from public.expenses e where e.store_id = p_store_id and e.id = any(p_ids)
    union all
    select sp.id, 'supplier payment of ₦' || to_char(sp.amount, 'FM999,999,999,990.00') || coalesce(' to ' || su.name, '')
      from public.supplier_payments sp left join public.suppliers su on su.id = sp.supplier_id
     where sp.store_id = p_store_id and sp.id = any(p_ids)
    union all
    select pe.id, pr.name || ' count of ' || to_char(pe.period_start, 'DD Mon YYYY')
      from public.stock_periods pe join public.products pr on pr.id = pe.product_id
     where pe.store_id = p_store_id and pe.id = any(p_ids)
    union all
    select m.id, pr.name || ' ' || m.kind || ' of ' || to_char(m.occurred_at, 'DD Mon YYYY')
      from public.stock_movements m join public.products pr on pr.id = m.product_id
     where m.store_id = p_store_id and m.id = any(p_ids)
    union all
    select su.id, 'the ' || su.name from public.store_units su where su.store_id = p_store_id and su.id = any(p_ids)
    union all
    select ec.id, ec.name from public.empties_categories ec where ec.store_id = p_store_id and ec.id = any(p_ids)
    union all
    select mb.user_id, public.member_label(p_store_id, mb.user_id) from public.store_members mb
     where mb.store_id = p_store_id and mb.user_id = any(p_ids)
    union all
    select iv.id, 'invitation for ' || iv.email from public.store_invitations iv where iv.store_id = p_store_id and iv.id = any(p_ids)
    union all
    select pm.id, 'a picture of ' || pr.name from public.product_media pm join public.products pr on pr.id = pm.product_id
     where pr.store_id = p_store_id and pm.id = any(p_ids)
    union all
    select ca.id, ca.name from public.expense_categories ca where ca.store_id = p_store_id and ca.id = any(p_ids)
  ) x
  where public.is_store_member(p_store_id);
$function$;

notify pgrst, 'reload schema';
