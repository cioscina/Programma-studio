-- Programma Studio: importazione dei dati salvati sul dispositivo.
--
-- Il client prepara i dati locali (con id nuovi, generati per l'account) e
-- chiama questa funzione dopo la conferma esplicita dell'utente.
--
-- * Tutto in un'unica transazione: o si importa tutto o niente.
-- * SECURITY INVOKER: valgono le stesse policy RLS delle chiamate dirette,
--   ogni riga viene scritta con user_id = auth.uid() e le chiavi esterne
--   composte impediscono collegamenti a dati di altri utenti.
-- * p_source_hash (SHA-256 dei dati locali) è unico per utente: ripetere la
--   stessa importazione non crea doppioni e restituisce "already_imported".
-- * Le materie, le verifiche e gli impegni importati vengono aggiunti in coda
--   a quelli già presenti. Orari settimanali e impostazioni vengono importati
--   solo se nel payload (il client li manda solo se l'account è vuoto) e non
--   sovrascrivono mai valori già presenti nell'account.

create or replace function public.import_local_data(p_source_hash text, p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_import_id uuid;
  v_subj_off integer;
  v_task_off integer;
  v_com_off integer;
  v_counts jsonb;
begin
  if v_uid is null then
    raise exception 'Accesso richiesto' using errcode = '42501';
  end if;
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Hash di importazione non valido' using errcode = '22023';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Dati da importare non validi' using errcode = '22023';
  end if;

  v_counts := jsonb_build_object(
    'subjects',     jsonb_array_length(coalesce(p_payload -> 'subjects', '[]')),
    'tasks',        jsonb_array_length(coalesce(p_payload -> 'tasks', '[]')),
    'commitments',  jsonb_array_length(coalesce(p_payload -> 'commitments', '[]')),
    'study_slots',  jsonb_array_length(coalesce(p_payload -> 'study_slots', '[]')),
    'days_off',     jsonb_array_length(coalesce(p_payload -> 'days_off', '[]')),
    'session_done', jsonb_array_length(coalesce(p_payload -> 'session_done', '[]')),
    'session_pins', jsonb_array_length(coalesce(p_payload -> 'session_pins', '[]'))
  );

  insert into public.local_imports (user_id, source_hash, counts)
  values (v_uid, p_source_hash, v_counts)
  on conflict (user_id, source_hash) do nothing
  returning id into v_import_id;

  if v_import_id is null then
    return jsonb_build_object('status', 'already_imported');
  end if;

  select coalesce(max(position) + 1, 0) into v_subj_off from public.subjects where user_id = v_uid;
  select coalesce(max(position) + 1, 0) into v_task_off from public.tasks where user_id = v_uid;
  select coalesce(max(position) + 1, 0) into v_com_off from public.commitments where user_id = v_uid;

  insert into public.subjects (id, user_id, name, color, position)
  select x.id, v_uid, coalesce(x.name, ''), coalesce(x.color, '#8fb4f2'), v_subj_off + coalesce(x.position, 0)
  from jsonb_to_recordset(coalesce(p_payload -> 'subjects', '[]'))
       as x(id uuid, name text, color text, position integer);

  insert into public.tasks (id, user_id, subject_id, kind, due_date, mode, page_ranges, extras,
                            sessions, note, review, position)
  select x.id, v_uid, x.subject_id, coalesce(x.kind, 'verifica'), x.due_date, coalesce(x.mode, 'pagine'),
         coalesce(x.page_ranges, '[]'), coalesce(x.extras, '[]'), x.sessions, coalesce(x.note, ''),
         coalesce(x.review, false), v_task_off + coalesce(x.position, 0)
  from jsonb_to_recordset(coalesce(p_payload -> 'tasks', '[]'))
       as x(id uuid, subject_id uuid, kind text, due_date date, mode text, page_ranges jsonb,
            extras jsonb, sessions integer, note text, review boolean, position integer);

  insert into public.commitments (id, user_id, name, days, start_time, end_time, relax, color, position)
  select x.id, v_uid, coalesce(x.name, ''), coalesce(x.days, '{}'), x.start_time, x.end_time,
         coalesce(x.relax, false), coalesce(x.color, '#f7b6d2'), v_com_off + coalesce(x.position, 0)
  from jsonb_to_recordset(coalesce(p_payload -> 'commitments', '[]'))
       as x(id uuid, name text, days smallint[], start_time time, end_time time, relax boolean,
            color text, position integer);

  insert into public.study_slots (user_id, weekday, position, start_time, end_time)
  select v_uid, x.weekday, x.position, x.start_time, x.end_time
  from jsonb_to_recordset(coalesce(p_payload -> 'study_slots', '[]'))
       as x(weekday smallint, position smallint, start_time time, end_time time)
  on conflict (user_id, weekday, position) do nothing;

  if jsonb_typeof(p_payload -> 'user_settings') = 'object' then
    insert into public.user_settings (user_id, start_date, session_minutes, pause_minutes, max_per_day,
                                      buffer_minutes, subtitle, goal)
    select v_uid, x.start_date, x.session_minutes, x.pause_minutes, x.max_per_day, x.buffer_minutes,
           coalesce(x.subtitle, ''), coalesce(x.goal, '')
    from jsonb_to_record(p_payload -> 'user_settings')
         as x(start_date date, session_minutes integer, pause_minutes integer, max_per_day integer,
              buffer_minutes integer, subtitle text, goal text)
    on conflict (user_id) do nothing;
  end if;

  insert into public.days_off (user_id, day)
  select v_uid, x.day
  from jsonb_to_recordset(coalesce(p_payload -> 'days_off', '[]')) as x(day date)
  on conflict (user_id, day) do nothing;

  insert into public.session_pins (user_id, task_id, is_review, days)
  select v_uid, x.task_id, coalesce(x.is_review, false), coalesce(x.days, '{}')
  from jsonb_to_recordset(coalesce(p_payload -> 'session_pins', '[]'))
       as x(task_id uuid, is_review boolean, days date[])
  on conflict (user_id, task_id, is_review) do nothing;

  insert into public.session_done (user_id, task_id, day, start_minute)
  select v_uid, x.task_id, x.day, x.start_minute
  from jsonb_to_recordset(coalesce(p_payload -> 'session_done', '[]'))
       as x(task_id uuid, day date, start_minute integer)
  on conflict (user_id, task_id, day, start_minute) do nothing;

  return jsonb_build_object('status', 'imported', 'import_id', v_import_id, 'counts', v_counts);
end;
$$;

revoke all on function public.import_local_data(text, jsonb) from public, anon;
grant execute on function public.import_local_data(text, jsonb) to authenticated;
