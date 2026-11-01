-- Programma Studio: notifiche Realtime.
--
-- L'app usa Realtime solo come "campanello": quando arriva un evento su una
-- delle sue tabelle rilegge i propri dati via API (sempre filtrati dalla RLS).
-- Realtime applica la RLS agli eventi INSERT/UPDATE inviati ai client.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'Pubblicazione supabase_realtime assente: Realtime non configurato (ok per test locali).';
    return;
  end if;
  foreach t in array array[
    'user_settings', 'subjects', 'tasks', 'study_slots', 'commitments',
    'days_off', 'session_done', 'session_pins'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
