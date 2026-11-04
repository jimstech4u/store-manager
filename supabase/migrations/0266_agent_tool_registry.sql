-- 0266 - The agent's tool registry
--
-- "Everything Store Manager can do, designed to be exposed across permissions to the AI agent."
-- The shape is Uber's MCP gateway: a crawler reads the interfaces the app already calls and drafts a
-- tool for each; the REGISTRY is the system of record, and everything in it starts switched off; an
-- owner reviews and enables it, every change is a recorded diff; and a GATEWAY in the agent routes
-- calls to the real functions, as the person asking, with policy checked per tool.
--
-- Here the interfaces are this database's functions. They already check permission and membership
-- inside themselves (`has_permission`, `is_store_member`), so the gateway adds no rule of its own that
-- the database does not already enforce: it only hides what a person could not use, fills in the
-- shop from the session rather than from the model, and puts every write behind YES.

create table public.agent_tools (
  name        text primary key,                       -- the function
  effect      text not null check (effect in ('read', 'write')),
  enabled     boolean not null default false,         -- discovered is not granted
  permission  text,                                   -- hidden from anybody without it
  title       text,
  description text,
  args        jsonb not null default '[]'::jsonb,     -- [{name, type, required, injected, hidden, label, description}]
  signature   text not null,                          -- the arguments as reviewed
  stale       boolean not null default false,         -- the function changed since review
  reviewed_at timestamptz,
  discovered_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.agent_tool_changes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  before     jsonb,
  after      jsonb not null,
  note       text,
  changed_at timestamptz not null default now()
);

-- The agent's own tables, like the WhatsApp ones: the server reads them, no member does.
alter table public.agent_tools enable row level security;
alter table public.agent_tool_changes enable row level security;

/*
 * THE CRAWLER'S VIEW of what the app can call: every function a member may execute, with its
 * arguments, whether it changes anything, and the permissions it checks for itself.
 */
create function public.agent_catalogue()
 returns table(name text, identity_args text, args text, effect text, permissions text[], result text, note text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select p.proname::text,
         pg_get_function_identity_arguments(p.oid),
         pg_get_function_arguments(p.oid),
         case when p.provolatile in ('s', 'i') then 'read' else 'write' end,
         array(select distinct m[1] from regexp_matches(pg_get_functiondef(p.oid),
                 'has_permission\([^,]+,\s*''([a-z_.]+)''\)', 'g') as m),
         pg_get_function_result(p.oid),
         obj_description(p.oid, 'pg_proc')
    from pg_proc p
    join pg_language l on l.oid = p.prolang
   where p.pronamespace = 'public'::regnamespace
     and p.prokind = 'f'
     and l.lanname in ('sql', 'plpgsql')
     and pg_get_function_result(p.oid) <> 'trigger'
     and p.proname !~ '^(plpgsql_|tg_|assert_|agent_)'
     and has_function_privilege('authenticated', p.oid, 'execute');
$function$;

revoke all on function public.agent_catalogue() from public, anon, authenticated;
grant execute on function public.agent_catalogue() to service_role;

/*
 * WHAT AN ID IS CALLED, so a proposal is read in names: "Rename Guinness Big Stout to …", never a
 * uuid. Only this shop's records, and only for a member of it.
 */
create function public.agent_names(p_store_id uuid, p_ids uuid[])
 returns table(id uuid, label text)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
  ) x
  where public.is_store_member(p_store_id);
$function$;

grant execute on function public.agent_names(uuid, uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';
