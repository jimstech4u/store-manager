-- EVERY ROW WHOSE PARENT IS GONE, removed — the cascade that `session_replication_role = replica`
-- switches off.
--
-- The benchmark deletes its throwaway shop in replica mode, because the audit and append-only
-- triggers would otherwise refuse or re-log the delete. Replica mode also stands down the foreign
-- keys' own cascade (they are triggers too), so every child row survived its shop: 88 stock periods,
-- 484 movements, 360 drafts, 6,675 audit rows by 29 Sep. The old comment said the keys "do the
-- cascade" in replica mode; they do not.
--
-- So this does it by hand: for every single-column foreign key in `public`, rows pointing at a
-- parent that does not exist are deleted (or their key nulled, where the key says SET NULL), and
-- the pass repeats until nothing is left — a sale's lines go on the pass after the sale.
--
-- Safe on a live database: with foreign keys enforced, a live row cannot point at nothing. The only
-- rows this can reach are ones orphaned while the keys were stood down.
--
-- Set `:dry` to true to count instead of delete.

do $purge$
declare
  r      record;
  n      bigint;
  total  bigint;
  pass   int := 0;
  dry    boolean := __DRY__;
begin
  set local session_replication_role = replica;
  loop
    total := 0;
    pass := pass + 1;
    for r in
      select c.conrelid::regclass  as child,
             a.attname             as col,
             c.confrelid::regclass as parent,
             af.attname            as pcol,
             c.confdeltype         as on_delete
        from pg_constraint c
        join pg_attribute a  on a.attrelid  = c.conrelid  and a.attnum  = c.conkey[1]
        join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
       where c.contype = 'f'
         and c.connamespace = 'public'::regnamespace
         and c.confrelid::regclass::text not like 'auth.%'
         and array_length(c.conkey, 1) = 1
    loop
      if dry then
        execute format(
          'select count(*) from %s x where x.%I is not null and not exists (select 1 from %s p where p.%I = x.%I)',
          r.child, r.col, r.parent, r.pcol, r.col) into n;
      elsif r.on_delete = 'n' then
        execute format(
          'update %s x set %I = null where x.%I is not null and not exists (select 1 from %s p where p.%I = x.%I)',
          r.child, r.col, r.col, r.parent, r.pcol, r.col);
        get diagnostics n = row_count;
      else
        execute format(
          'delete from %s x where x.%I is not null and not exists (select 1 from %s p where p.%I = x.%I)',
          r.child, r.col, r.parent, r.pcol, r.col);
        get diagnostics n = row_count;
      end if;
      if n > 0 then
        raise notice '% %.% -> %: %', case when dry then 'would touch' else 'removed' end,
          r.child, r.col, r.parent, n;
        total := total + n;
      end if;
    end loop;
    exit when total = 0 or dry or pass >= 25;
  end loop;
end;
$purge$;
