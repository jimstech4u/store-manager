-- =====================================================================================
-- 0014 — Fix tg_audit() for tables whose primary key is not called "id"
--
-- Found by the settle-sale verification suite, not by review.
--
-- tg_audit() read `(new_row ->> 'id')::uuid` and wrote it to audit_log.record_id, which is NOT
-- NULL. store_settings is keyed by `store_id` and has no `id` column at all, so every insert or
-- update to it raised:
--
--     null value in column "record_id" of relation "audit_log" violates not-null constraint
--
-- The effect was total: attaching an audit trigger to that table made the table unwritable. The
-- first person to open Settings would have hit it, and the error names audit_log rather than
-- store_settings, so it would have read as a logging fault rather than a schema one.
--
-- record_id stays NOT NULL deliberately. A nullable one would have let this pass silently and
-- produced audit rows that point at nothing — worse than the error, because a history you cannot
-- trace back to a row is not a history.
-- =====================================================================================

create or replace function public.tg_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store_id  uuid;
  v_reason    text;
  v_rec       jsonb;
  v_record_id uuid;
begin
  v_rec := to_jsonb(coalesce(new, old));
  v_store_id := nullif(v_rec ->> 'store_id', '')::uuid;
  v_reason   := v_rec ->> 'amend_reason';

  -- Prefer a surrogate `id`; fall back to the store id for tables keyed by it (store_settings),
  -- which keeps every audit row traceable to the record it describes.
  v_record_id := coalesce(
    nullif(v_rec ->> 'id', '')::uuid,
    v_store_id
  );

  if v_record_id is null then
    -- Nothing identifies this row, so an audit entry would be untraceable. Fail loudly here
    -- rather than writing a useless record: a new table reaching this line is a schema mistake
    -- that should be found while adding it, not months later during a dispute.
    raise exception
      'tg_audit: cannot identify the row being changed on %. It needs an "id" or "store_id" column.',
      tg_table_name
      using errcode = '23502';
  end if;

  insert into public.audit_log (store_id, table_name, record_id, op, prior_value, new_value, reason)
  values (
    v_store_id,
    tg_table_name,
    v_record_id,
    lower(tg_op),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    v_reason
  );

  return coalesce(new, old);
end;
$$;
