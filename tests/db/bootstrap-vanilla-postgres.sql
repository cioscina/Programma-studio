-- SOLO PER I TEST su un PostgreSQL "normale" (non Supabase).
--
-- Ricrea il minimo indispensabile dell'ambiente Supabase perché le migrazioni
-- e le policy RLS si comportino come su Supabase:
--   * ruoli anon e authenticated (senza BYPASSRLS)
--   * schema auth con tabella users e funzione auth.uid() che legge il "sub"
--     del JWT da request.jwt.claims, come fa Supabase
--   * permessi predefiniti uguali a quelli di Supabase (tutto ad anon e
--     authenticated sulle nuove tabelle dello schema public), così i test
--     verificano che le migrazioni li restringano davvero.
-- Su un progetto Supabase questo file NON va eseguito.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique,
  encrypted_password  text,
  email_confirmed_at  timestamptz,
  created_at          timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant execute on function auth.uid() to anon, authenticated;

alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
