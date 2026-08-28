-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Staff are people, and permissions are a checklist
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- Two changes that go together.
--
-- STAFF HAVE DETAILS. A member was a user_id and a role. A shop knows its people by name and
-- reaches them by phone, and when a seller is short at the end of a shift the person asking has a
-- name in mind, not a UUID. First name, last name, phone and address live here.
--
-- STAFF HAVE A LOGIN THIS SHOP CONTROLS. Somebody selling behind a counter should not need a
-- personal email account to be given a till. Each business gets a namespace derived from its own
-- name — `john.ajibewa@ashabiglobal.sm` — and the admin sets the first password. Those addresses
-- are DELIBERATELY NOT DELIVERABLE: nothing is ever sent to them, and a staff member who forgets
-- their password is told to ask the admin, because the admin is the only person who can change it.
-- Anything that genuinely has to arrive by email goes to the admin's own address.
--
-- PERMISSIONS ARE PER PERSON. Roles stay, as presets: a shop that just wants "a seller" should not
-- have to reason about sixteen checkboxes. But the boxes are there, and a member's own set wins
-- over the role's where they differ. Every real shop has somebody who is a seller EXCEPT that they
-- also count stock, and encoding that as a new role for each shop is how a role list becomes
-- unreadable.
--
-- The permission check keeps its single entry point. `has_permission` is called from RLS policies
-- and from every RPC; it now consults the override table first and falls back to the role. Nothing
-- that calls it needs to change, which is the point of having had one function all along.

-- ─── A namespace per business ───────────────────────────────────────────────────────
--
-- Derived from the NAME, not from `stores.code`. The code is six random letters chosen to be read
-- aloud over a phone (`K7M2PQ`), which makes a fine share link and a hostile email address.
-- `ashabiglobal` is recognisable to the people who work there, and that is the whole job of this
-- string.

alter table public.stores
  add column if not exists login_domain text unique;

comment on column public.stores.login_domain is
  'Namespace for staff logins, e.g. ashabiglobal -> john.doe@ashabiglobal.sm. Not a real domain: '
  'nothing is delivered to these addresses.';

-- `unaccent` is an extension that may not be installed, and this is not worth a hard dependency:
-- fold the accented Latin letters that actually occur in Nigerian business names and leave the
-- rest to the character filter above.
create or replace function public.unaccent_fallback(p_text text)
returns text
language sql
immutable
as $$
  select translate(
    p_text,
    'àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ',
    'aaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC'
  );
$$;

/**
 * A business name as a login namespace.
 *
 * "ASHABI GLOBAL RESOURCES" -> "ashabiglobal", not "ashabiglobalresources". The generic tail of a
 * Nigerian business name — RESOURCES, VENTURES, ENTERPRISES, NIG LTD — is what distinguishes it on
 * a certificate and not what anybody calls it. Staff type this address; every extra syllable is a
 * syllable to get wrong.
 *
 * Accents are folded rather than dropped, so "Sègun" becomes "segun" and not "gun".
 */
create or replace function public.slugify_business(p_name text)
returns text
language sql
immutable
as $$
  with words as (
    select w, ord
      from unnest(
        regexp_split_to_array(
          regexp_replace(lower(unaccent_fallback(coalesce(p_name, ''))), '[^a-z0-9 ]', ' ', 'g'),
          ' +'
        )
      ) with ordinality as t(w, ord)
     where w <> ''
  ),
  kept as (
    select w, ord from words
     where w not in (
       -- Only the words that appear on a certificate and never in conversation. NOT 'global' or
       -- 'stores': "Ashabi Global" and "Mama Nkechi Stores" are what people actually say, and the
       -- namespace should be what people say.
       'resources','resource','ventures','venture','enterprises','enterprise','ltd','limited',
       'plc','company','co','nig','nigeria','and','sons','son'
     )
  ),
  -- Everything generic removed can leave nothing at all ("Global Ventures Ltd"), in which case the
  -- original words are better than no name.
  chosen as (
    select w, ord from kept
    union all
    select w, ord from words where not exists (select 1 from kept)
  )
  select nullif(string_agg(w, '' order by ord), '')
    from (select w, ord from chosen order by ord limit 3) s;
$$;

/**
 * The business's login namespace, assigned on first use and never changed afterwards.
 *
 * Never changed because staff sign in with it. Renaming the shop must not lock out everybody who
 * works there, so the namespace is a decision made once — the same reasoning that makes a username
 * permanent everywhere else.
 */
create or replace function public.ensure_login_domain(p_store_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_domain text;
  v_base   text;
  v_try    int := 0;
begin
  if not public.has_permission(p_store_id, 'staff.manage') then
    raise exception 'you do not have permission to manage staff here' using errcode = '42501';
  end if;

  select login_domain into v_domain from public.stores where id = p_store_id;
  if v_domain is not null then
    return v_domain;
  end if;

  select public.slugify_business(name) into v_base from public.stores where id = p_store_id;
  if v_base is null then
    -- A shop with a name made entirely of punctuation. Rare, and not a reason to fail.
    v_base := 'shop';
  end if;
  v_base := left(v_base, 24);

  loop
    v_domain := case when v_try = 0 then v_base else v_base || v_try::text end;
    begin
      update public.stores set login_domain = v_domain where id = p_store_id;
      return v_domain;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 50 then
        raise exception 'could not assign a login namespace' using errcode = '23505';
      end if;
    end;
  end loop;
end;
$$;

grant execute on function public.slugify_business(text)   to authenticated;
grant execute on function public.unaccent_fallback(text)  to authenticated;
grant execute on function public.ensure_login_domain(uuid) to authenticated;

-- ─── Staff are people ───────────────────────────────────────────────────────────────

alter table public.store_members
  add column if not exists first_name           text,
  add column if not exists last_name            text,
  add column if not exists phone                text,
  add column if not exists address              text,
  -- The address they sign in with. Kept here as well as on auth.users because this is the copy the
  -- shop's own screens read, and reading auth.users from application queries needs elevation.
  add column if not exists login_email          text,
  -- Set when an admin creates or resets an account. The app makes them choose their own before it
  -- lets them do anything else: a password the admin knows is a password two people know.
  add column if not exists must_change_password boolean not null default false;

comment on column public.store_members.must_change_password is
  'Admin set this password. The staff member must replace it before using the app.';

-- ─── Permissions, per person ────────────────────────────────────────────────────────

create table if not exists public.store_member_permissions (
  store_id        uuid not null,
  user_id         uuid not null,
  permission_code text not null references public.permissions (code) on delete cascade,
  -- TRUE grants something the role does not give; FALSE takes away something it does. Both
  -- directions are needed: "a seller who also counts stock" and "a manager who cannot see the
  -- takings" are both things a real shop asks for.
  granted         boolean not null,
  set_by          uuid references auth.users (id),
  set_at          timestamptz not null default now(),
  primary key (store_id, user_id, permission_code),
  foreign key (store_id, user_id)
    references public.store_members (store_id, user_id) on delete cascade
);

create index if not exists store_member_permissions_member_idx
  on public.store_member_permissions (store_id, user_id);

alter table public.store_member_permissions enable row level security;

-- Dropped first so this migration can be re-applied: `create policy` has no `if not exists`.
drop policy if exists read_smp on public.store_member_permissions;
drop policy if exists no_direct_write_smp on public.store_member_permissions;

-- Readable by anybody who can manage staff here, and by the member themselves — a person is
-- entitled to know what they are allowed to do.
create policy read_smp on public.store_member_permissions
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_permission(store_id, 'staff.manage')
  );

-- Written only through `set_member_permissions`, which enforces the rank rule. No direct writes.
create policy no_direct_write_smp on public.store_member_permissions
  for all to authenticated
  using (false)
  with check (false);

-- ─── One check, now with overrides ──────────────────────────────────────────────────
--
-- Replaces the body only. Every RLS policy and RPC that calls this keeps calling it.

create or replace function public.has_permission(p_store_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    -- The member's own answer, if they have one for this permission.
    (
      select smp.granted
        from public.store_member_permissions smp
        join public.store_members m
          on m.store_id = smp.store_id and m.user_id = smp.user_id
       where smp.store_id        = p_store_id
         and smp.user_id         = auth.uid()
         and smp.permission_code = p_permission
         and m.status            = 'active'
    ),
    -- Otherwise what their role says.
    exists (
      select 1
        from public.store_members m
        join public.role_permissions rp on rp.role_code = m.role_code
       where m.store_id         = p_store_id
         and m.user_id          = auth.uid()
         and m.status           = 'active'
         and rp.permission_code = p_permission
    )
  );
$$;

/** Every permission there is, with what each one means. The checklist an admin ticks. */
create or replace function public.list_permissions()
returns table (code text, description text)
language sql
stable
as $$
  select code, description from public.permissions order by code;
$$;

/**
 * What one member is actually allowed to do, and where each answer came from.
 *
 * `source` matters to whoever is reading the checklist: a box ticked because the role ticks it
 * reads differently from one ticked for this person specifically, and an admin about to change
 * somebody's role needs to know which of their permissions will move with it.
 */
create or replace function public.member_permissions(p_store_id uuid, p_user_id uuid)
returns table (code text, description text, allowed boolean, source text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    p.code,
    p.description,
    coalesce(smp.granted, rp.permission_code is not null) as allowed,
    case when smp.permission_code is not null then 'member' else 'role' end as source
  from public.permissions p
  cross join (select role_code from public.store_members
               where store_id = p_store_id and user_id = p_user_id) m
  left join public.role_permissions rp
    on rp.role_code = m.role_code and rp.permission_code = p.code
  left join public.store_member_permissions smp
    on smp.store_id = p_store_id and smp.user_id = p_user_id and smp.permission_code = p.code
  where public.has_permission(p_store_id, 'staff.manage') or p_user_id = auth.uid()
  order by p.code;
$$;

/**
 * Set one member's permissions from a checklist.
 *
 * Takes the FULL set of codes that should be allowed, not a delta — a checklist is a statement of
 * how things should be, and diffing it on the client is how two admins editing at once produce a
 * set neither of them chose.
 *
 * Anything matching the role is stored as no override at all, so a later role change still moves
 * the permissions that were never touched. That is the difference between "this person is a seller"
 * and "this person happens to have a seller's boxes ticked".
 */
create or replace function public.set_member_permissions(
  p_store_id uuid,
  p_user_id  uuid,
  p_allowed  text[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_rank  int;
  v_target_rank int;
  v_role        text;
begin
  if not public.has_permission(p_store_id, 'staff.manage') then
    raise exception 'you do not have permission to manage staff here' using errcode = '42501';
  end if;

  select r.rank into v_actor_rank
    from public.store_members m join public.roles r on r.code = m.role_code
   where m.store_id = p_store_id and m.user_id = auth.uid();

  select r.rank, m.role_code into v_target_rank, v_role
    from public.store_members m join public.roles r on r.code = m.role_code
   where m.store_id = p_store_id and m.user_id = p_user_id;

  if v_target_rank is null then
    raise exception 'that person does not work here' using errcode = 'P0002';
  end if;

  -- Nobody edits their equal or their senior. Without this, a manager could grant themselves
  -- `store.settings` and the rank system would be decoration.
  if v_actor_rank is null or v_actor_rank <= v_target_rank then
    raise exception 'you cannot change what this person is allowed to do' using errcode = '42501';
  end if;

  delete from public.store_member_permissions
   where store_id = p_store_id and user_id = p_user_id;

  insert into public.store_member_permissions (store_id, user_id, permission_code, granted, set_by)
  select p_store_id, p_user_id, p.code, (p.code = any(coalesce(p_allowed, '{}'))), auth.uid()
    from public.permissions p
    -- Only where the member's answer DIFFERS from the role's, so an untouched permission keeps
    -- following the role.
   where (p.code = any(coalesce(p_allowed, '{}')))
         is distinct from
         exists (select 1 from public.role_permissions rp
                  where rp.role_code = v_role and rp.permission_code = p.code);
end;
$$;

grant execute on function public.list_permissions()                          to authenticated;
grant execute on function public.member_permissions(uuid, uuid)              to authenticated;
grant execute on function public.set_member_permissions(uuid, uuid, text[])  to authenticated;

-- ─── The team list carries the person ───────────────────────────────────────────────

-- The shape changed, and Postgres will not replace a function whose OUT columns differ.
drop function if exists public.list_staff(uuid, boolean);

create or replace function public.list_staff(p_store_id uuid, p_include_removed boolean default false)
returns table (
  user_id    uuid,
  email      text,
  login_email text,
  first_name text,
  last_name  text,
  phone      text,
  address    text,
  role_code  text,
  role_name  text,
  role_rank  int,
  joined_at  timestamptz,
  is_you     boolean,
  status     text,
  removed_at timestamptz,
  must_change_password boolean,
  custom_permissions int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select m.user_id, u.email::text, m.login_email,
         m.first_name, m.last_name, m.phone, m.address,
         m.role_code, r.name, r.rank, m.joined_at,
         m.user_id = auth.uid(), m.status, m.removed_at,
         m.must_change_password,
         (select count(*)::int from public.store_member_permissions smp
           where smp.store_id = m.store_id and smp.user_id = m.user_id)
    from public.store_members m
    join public.roles r on r.code = m.role_code
    join auth.users u on u.id = m.user_id
   where m.store_id = p_store_id
     and (p_include_removed or m.status = 'active')
     and public.has_permission(p_store_id, 'staff.manage')
   order by (m.status = 'active') desc, r.rank desc,
            coalesce(m.first_name, u.email::text);
$fn$;
