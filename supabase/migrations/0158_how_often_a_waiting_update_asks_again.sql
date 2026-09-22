-- 0158 — How often a waiting update asks again
--
-- A new version of the app announces itself and waits to be let in, because taking over the moment
-- it lands swaps the code under a till halfway through a sale. "Not now" is therefore a real answer
-- — and an answer that is never asked again is how a shop ends up running a version from March.
--
-- So it asks again, and the shop says how often. Thirty minutes to start with: long enough not to
-- nag somebody serving a queue, short enough that a fix reaches the counter the same morning. A shop
-- that updates at closing time can set twelve hours instead.
--
-- Minutes rather than a label, so the four choices are data and a fifth is a column value rather
-- than a migration. Bounded because the two ends are both failures: nagging every minute, and a
-- reminder nobody lives long enough to see.

alter table public.store_settings
  add column if not exists update_reminder_minutes integer not null default 30;

alter table public.store_settings
  drop constraint if exists store_settings_update_reminder_minutes_sane;

alter table public.store_settings
  add constraint store_settings_update_reminder_minutes_sane
  check (update_reminder_minutes between 5 and 1440);

comment on column public.store_settings.update_reminder_minutes is
  'How long after "Not now" a waiting app update asks again, in minutes. The app offers 30, 60, '
  '240 and 720; any value in range is honoured.';
