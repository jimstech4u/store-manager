-- =====================================================================================
-- 0039 — Stop normalise_phone inventing a leading zero
--
-- The ten-digit rule existed for numbers given without their leading zero — someone writes
-- "8087330300" meaning "08087330300" — and it fired on ANY ten-digit string, including ones that
-- already began with a zero. "0808733030" came back as "00808733030".
--
-- This is not cosmetic. The phone number is the anchor of the whole identity graph: it is what
-- decides whether the person at the counter is the customer who already owes ₦200,000 or a
-- stranger with the same name. A number that normalises two different ways is a customer whose
-- debt silently splits across two records, and nobody notices until one of them is written off.
--
-- The fix is narrow: only add the zero when the number plainly lacks one. Anything that does not
-- match a known shape is now left EXACTLY as it was typed, rather than being reshaped into
-- something that looks valid and is not. A number we cannot confidently interpret should stay
-- recognisable to the person who typed it.
-- =====================================================================================

create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
as $fn$
  select case
    -- +234 / 234 international form → local
    when d like '234%' and length(d) = 13 then '0' || right(d, 10)
    -- Already the local eleven-digit form
    when d like '0%'   and length(d) = 11 then d
    -- Ten digits and NOT already starting with a zero: the leading zero was dropped.
    when length(d) = 10 and d not like '0%' then '0' || d
    -- Anything else — including a ten-digit string that already starts with 0, which is simply
    -- short — is left as typed. Guessing here is what created the duplicate identities.
    else d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) s;
$fn$;

grant execute on function public.normalize_phone(text) to authenticated;

-- ─── Repair numbers already mangled ─────────────────────────────────────────────────
--
-- Only the ones this bug could have produced: a leading '00' followed by a '0'-initial
-- ten-digit number. Anything else is left alone rather than guessed at.

do $repair$
declare
  r record;
  v_fixed text;
begin
  for r in
    select id, phone from public.identities
     where phone like '00%' and length(phone) = 11
  loop
    v_fixed := substring(r.phone from 2);

    -- If the corrected number already belongs to somebody else, leave this one as it is: merging
    -- two identities is a decision with money attached and is not something a migration should
    -- make silently. The number stays visible and wrong, which is recoverable; a wrong merge is
    -- not.
    if exists (select 1 from public.identities where phone = v_fixed and id <> r.id) then
      raise notice 'identity % not repaired — % already exists', r.id, v_fixed;
    else
      update public.identities set phone = v_fixed where id = r.id;
      raise notice 'identity %: % -> %', r.id, r.phone, v_fixed;
    end if;
  end loop;
end;
$repair$;
