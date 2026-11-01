-- Programma Studio: isolamento degli account.
--
-- * RLS attiva su tutte le tabelle con dati personali.
-- * Policy separate per SELECT, INSERT, UPDATE e DELETE, solo per il ruolo
--   "authenticated" e solo sulle righe con user_id = auth.uid().
-- * WITH CHECK su INSERT e UPDATE: non si può creare un record per un altro
--   utente né trasferire un record cambiandone user_id (il trigger
--   ps_before_write lo blocca anche esplicitamente).
-- * I collegamenti tra record (task -> materia, sessioni -> task) passano da
--   chiavi esterne composte (id, user_id), quindi non possono puntare a dati
--   di un altro utente anche conoscendone l'id.
-- * Il ruolo "anon" (utenti non autenticati) non ha alcun permesso; a
--   "authenticated" restano solo SELECT/INSERT/UPDATE/DELETE (niente TRUNCATE,
--   che ignorerebbe la RLS).

do $$
declare
  t text;
begin
  foreach t in array array[
    'user_settings', 'subjects', 'tasks', 'study_slots', 'commitments',
    'days_off', 'session_done', 'session_pins'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);

    execute format($p$create policy %I on public.%I for select to authenticated
                     using ((select auth.uid()) = user_id)$p$, t || '_select_own', t);
    execute format($p$create policy %I on public.%I for insert to authenticated
                     with check ((select auth.uid()) = user_id)$p$, t || '_insert_own', t);
    execute format($p$create policy %I on public.%I for update to authenticated
                     using ((select auth.uid()) = user_id)
                     with check ((select auth.uid()) = user_id)$p$, t || '_update_own', t);
    execute format($p$create policy %I on public.%I for delete to authenticated
                     using ((select auth.uid()) = user_id)$p$, t || '_delete_own', t);
  end loop;
end
$$;

-- Registro delle importazioni: si legge e si crea solo il proprio; non si
-- modifica né si cancella (UPDATE e DELETE non hanno policy permissive e il
-- permesso non viene concesso), così la protezione dai doppioni non si aggira.
alter table public.local_imports enable row level security;
revoke all on table public.local_imports from anon, authenticated, public;
grant select, insert on table public.local_imports to authenticated;

create policy local_imports_select_own on public.local_imports
  for select to authenticated using ((select auth.uid()) = user_id);
create policy local_imports_insert_own on public.local_imports
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy local_imports_update_none on public.local_imports
  as restrictive for update to authenticated using (false) with check (false);
create policy local_imports_delete_none on public.local_imports
  as restrictive for delete to authenticated using (false);

-- Le funzioni trigger non devono essere chiamabili via API.
revoke all on function public.ps_before_write() from public, anon, authenticated;
revoke all on function public.ps_bump_version() from public, anon, authenticated;
