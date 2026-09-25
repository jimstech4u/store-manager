-- =====================================================================================
-- 0167 — An audit row for a shop that has gone
--
-- `tg_audit` copies the changed row's `store_id` into `audit_log.store_id`, which has a foreign key
-- to `stores`. When the shop is gone that insert fails, and because the trigger raises, THE CHANGE
-- ITSELF FAILS. The effect is that rows belonging to a deleted shop can never be touched again:
--
--     ERROR: insert or update on table "audit_log" violates foreign key constraint
--     Key (store_id)=(c9fd05cf-…) is not present in table "stores".
--
-- Found on 645 draft orders left behind by shops deleted during testing. They are unreachable by the
-- app — every read is scoped to a live shop — and they were also undeletable, which is the part
-- worth fixing: a tidy-up that cannot be performed is a tidy-up that never happens.
--
-- THE AUDIT ROW IS STILL WRITTEN. `audit_log.store_id` is nullable, so when the shop no longer
-- exists the entry is written without it and keeps everything that makes it an audit entry: the
-- table, the record id, the operation, the actor, the time and the whole prior value — including
-- that `store_id`, inside `prior_value`. Nothing is suppressed and nothing is silenced; a key that
-- cannot point anywhere is simply not stored as if it could.
--
-- The alternative was to disable the trigger for the length of a delete, which is how the same
-- problem gets solved in a hurry and is exactly what an audit trail exists to prevent.
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

  /*
   * A SHOP THAT NO LONGER EXISTS CANNOT BE REFERENCED, and must not stop the change being audited.
   *
   * `audit_log.store_id` is a foreign key, so a deleted shop made this insert fail — and since the
   * trigger raises, the change failed with it. Rows belonging to a deleted shop became permanently
   * untouchable, which is not a property anybody asked for.
   *
   * The entry is still written. The shop's id is not lost either: it is in `prior_value`, which is
   * the whole row as it stood. Only the FOREIGN KEY is dropped, because it has nothing to point at.
   */
  if v_store_id is not null and not exists (select 1 from public.stores s where s.id = v_store_id) then
    v_store_id := null;
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

comment on function public.tg_audit() is
  'Writes an audit_log entry for every change. When the row''s shop no longer exists the entry is written with a null store_id — the id itself is still in prior_value — because a foreign key that cannot point anywhere must not make a row permanently untouchable.';
