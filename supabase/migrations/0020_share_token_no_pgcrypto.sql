-- =====================================================================================
-- 0020 — Generate share tokens without pgcrypto
--
-- Found by running the share test, not by reading the code: create_share_link() called
-- gen_random_bytes(), which lives in pgcrypto. Supabase installs pgcrypto into the `extensions`
-- schema, and the function pins `search_path = public, pg_temp` — correctly, since an unpinned
-- search_path on a SECURITY DEFINER function is a hijack waiting to happen. So the call could
-- never resolve, and every attempt to share a receipt failed with:
--
--     function gen_random_bytes(integer) does not exist
--
-- Two ways out: widen the search_path to include `extensions`, or stop needing the extension.
-- Widening is the worse trade — it enlarges the surface a definer function trusts, permanently,
-- to save one call.
--
-- gen_random_uuid() is core Postgres (14+), needs no extension, and is CSPRNG-backed. Its hex
-- form gives 32 characters of 122 usable bits, which is well beyond what an unguessable URL
-- token needs and is already the standard this codebase relies on for every primary key.
-- =====================================================================================

create or replace function public.create_share_link(
  p_store_id  uuid,
  p_kind      text,
  p_ref_id    uuid,
  p_expires_in interval default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
begin
  if not public.has_permission(p_store_id, 'sales.record') then
    raise exception 'you do not have permission to share this' using errcode = '42501';
  end if;

  -- Reuse a live link for the same record rather than minting a second: two valid links to one
  -- receipt would mean revoking one leaves the other working, which is not what "revoke" means.
  select token into v_token
    from public.share_links
   where store_id = p_store_id and kind = p_kind and ref_id = p_ref_id
     and revoked_at is null
     and (expires_at is null or expires_at > now())
   limit 1;

  if v_token is not null then
    return v_token;
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');

  insert into public.share_links (store_id, kind, ref_id, token, expires_at)
  values (p_store_id, p_kind, p_ref_id, v_token,
          case when p_expires_in is null then null else now() + p_expires_in end);

  return v_token;
end;
$$;

grant execute on function public.create_share_link(uuid, text, uuid, interval) to authenticated;
