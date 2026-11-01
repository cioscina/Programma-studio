-- Programma Studio: schema dei dati personali.
--
-- Ogni tabella corrisponde a una parte dello stato che l'app teneva in
-- localStorage (chiave "programma-studio-v1"):
--   S.start / sess / pausa / maxPerDay / buffer / subtitle / goal -> user_settings
--   S.subjects                                                    -> subjects
--   S.tasks (con ranges ed extras)                                -> tasks
--   S.week[giorno] = [[dalle, alle], ...]                         -> study_slots
--   S.commitments                                                 -> commitments
--   S.off                                                         -> days_off
--   S.done["data|minuto|taskId"]                                  -> session_done
--   S.pins[taskId] / S.pins[taskId#r]                             -> session_pins
-- local_imports registra le importazioni dei dati locali (evita i doppioni).
--
-- Ogni riga appartiene a un utente (user_id -> auth.users). I riferimenti tra
-- tabelle usano chiavi esterne composte (id, user_id): un record può puntare
-- solo a record dello stesso proprietario.
--
-- Le tabelle modificabili hanno "version" (incrementata dal database a ogni
-- modifica) per la concorrenza ottimistica: il client aggiorna solo se la
-- versione è quella che conosce, così un dispositivo non sovrascrive in
-- silenzio le modifiche fatte da un altro.

-- ---------------------------------------------------------------------------
-- Funzione trigger comune: versione, timestamp e proprietario immutabile.
-- ---------------------------------------------------------------------------
create or replace function public.ps_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  -- UPDATE: il proprietario non si cambia, created_at non si tocca
  if new.user_id is distinct from old.user_id then
    raise exception 'Il proprietario di un record non può essere cambiato'
      using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

-- Versione gestita solo dal database: 1 alla creazione, +1 a ogni modifica.
create or replace function public.ps_bump_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Impostazioni (una riga per utente)
-- ---------------------------------------------------------------------------
create table public.user_settings (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  start_date       date,
  session_minutes  integer check (session_minutes between 0 and 1440),
  pause_minutes    integer check (pause_minutes between 0 and 1440),
  max_per_day      integer check (max_per_day between 0 and 100),
  buffer_minutes   integer check (buffer_minutes between 0 and 1440),
  subtitle         text not null default '' check (char_length(subtitle) <= 500),
  goal             text not null default '' check (char_length(goal) <= 5000),
  version          integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Materie
-- ---------------------------------------------------------------------------
create table public.subjects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default '' check (char_length(name) <= 200),
  color       text not null default '#8fb4f2' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  position    integer not null default 0 check (position >= 0),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint subjects_id_user_key unique (id, user_id)
);
create index subjects_user_position_idx on public.subjects (user_id, position);

-- ---------------------------------------------------------------------------
-- Verifiche, interrogazioni e compiti
-- ---------------------------------------------------------------------------
create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  subject_id  uuid,
  kind        text not null default 'verifica' check (kind in ('verifica', 'interrogazione', 'consegna')),
  due_date    date,
  mode        text not null default 'pagine' check (mode in ('pagine', 'sessioni')),
  -- gruppi di pagine [[da, a], ...] così come li scrive l'interfaccia
  page_ranges jsonb not null default '[]'::jsonb
              check (jsonb_typeof(page_ranges) = 'array' and jsonb_array_length(page_ranges) <= 200),
  -- "altro materiale": una riga di testo = una sessione
  extras      jsonb not null default '[]'::jsonb
              check (jsonb_typeof(extras) = 'array' and jsonb_array_length(extras) <= 200),
  sessions    integer check (sessions between 0 and 1000),
  note        text not null default '' check (char_length(note) <= 2000),
  review      boolean not null default false,
  position    integer not null default 0 check (position >= 0),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tasks_id_user_key unique (id, user_id),
  -- la materia deve appartenere allo stesso utente; eliminando la materia
  -- si eliminano le sue verifiche (come fa già l'interfaccia)
  constraint tasks_subject_same_owner_fkey foreign key (subject_id, user_id)
    references public.subjects (id, user_id) on delete cascade
);
create index tasks_user_position_idx on public.tasks (user_id, position);
create index tasks_subject_idx on public.tasks (subject_id, user_id);

-- ---------------------------------------------------------------------------
-- Tempo per studiare: fasce orarie settimanali (0 = domenica ... 6 = sabato)
-- ---------------------------------------------------------------------------
create table public.study_slots (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  weekday     smallint not null check (weekday between 0 and 6),
  position    smallint not null check (position between 0 and 99),
  start_time  time,
  end_time    time,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, weekday, position)
);

-- ---------------------------------------------------------------------------
-- Impegni fissi (danza, sport, ...)
-- ---------------------------------------------------------------------------
create table public.commitments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default '' check (char_length(name) <= 200),
  days        smallint[] not null default '{}'
              check (days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[] and cardinality(days) <= 7),
  start_time  time,
  end_time    time,
  relax       boolean not null default false,
  color       text not null default '#f7b6d2' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  position    integer not null default 0 check (position >= 0),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index commitments_user_position_idx on public.commitments (user_id, position);

-- ---------------------------------------------------------------------------
-- Giorni senza studio
-- ---------------------------------------------------------------------------
create table public.days_off (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day         date not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------------
-- Sessioni segnate come fatte (chiave dell'app: "data|minuto di inizio|task")
-- ---------------------------------------------------------------------------
create table public.session_done (
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id       uuid not null,
  day           date not null,
  start_minute  integer not null check (start_minute between 0 and 2880),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, task_id, day, start_minute),
  constraint session_done_task_same_owner_fkey foreign key (task_id, user_id)
    references public.tasks (id, user_id) on delete cascade
);
create index session_done_task_idx on public.session_done (task_id, user_id);

-- ---------------------------------------------------------------------------
-- Sessioni spostate a mano (pulsante "Sposta"): giorni scelti per un compito,
-- is_review = true per il ripasso del giorno prima.
-- ---------------------------------------------------------------------------
create table public.session_pins (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id     uuid not null,
  is_review   boolean not null default false,
  days        date[] not null default '{}' check (cardinality(days) <= 366),
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, task_id, is_review),
  constraint session_pins_task_same_owner_fkey foreign key (task_id, user_id)
    references public.tasks (id, user_id) on delete cascade
);
create index session_pins_task_idx on public.session_pins (task_id, user_id);

-- ---------------------------------------------------------------------------
-- Importazioni dei dati salvati sul dispositivo (prima degli account)
-- ---------------------------------------------------------------------------
create table public.local_imports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_hash  text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  counts       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint local_imports_user_source_key unique (user_id, source_hash)
);

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------
create trigger user_settings_before_write before insert or update on public.user_settings
  for each row execute function public.ps_before_write();
create trigger subjects_before_write before insert or update on public.subjects
  for each row execute function public.ps_before_write();
create trigger tasks_before_write before insert or update on public.tasks
  for each row execute function public.ps_before_write();
create trigger study_slots_before_write before insert or update on public.study_slots
  for each row execute function public.ps_before_write();
create trigger commitments_before_write before insert or update on public.commitments
  for each row execute function public.ps_before_write();
create trigger days_off_before_write before insert or update on public.days_off
  for each row execute function public.ps_before_write();
create trigger session_done_before_write before insert or update on public.session_done
  for each row execute function public.ps_before_write();
create trigger session_pins_before_write before insert or update on public.session_pins
  for each row execute function public.ps_before_write();
create trigger local_imports_before_write before insert or update on public.local_imports
  for each row execute function public.ps_before_write();

create trigger user_settings_version before insert or update on public.user_settings
  for each row execute function public.ps_bump_version();
create trigger subjects_version before insert or update on public.subjects
  for each row execute function public.ps_bump_version();
create trigger tasks_version before insert or update on public.tasks
  for each row execute function public.ps_bump_version();
create trigger study_slots_version before insert or update on public.study_slots
  for each row execute function public.ps_bump_version();
create trigger commitments_version before insert or update on public.commitments
  for each row execute function public.ps_bump_version();
create trigger session_pins_version before insert or update on public.session_pins
  for each row execute function public.ps_bump_version();
