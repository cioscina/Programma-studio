// Strumenti per i test del database.
//
// Due modi di eseguirli:
// * PostgreSQL normale (predefinito): TEST_PG_ADMIN_URL punta a un server
//   (es. postgres://postgres:postgres@127.0.0.1:5432/postgres). Si crea un
//   database temporaneo, si applicano bootstrap-vanilla-postgres.sql e le
//   migrazioni di supabase/migrations, poi lo si elimina.
// * Supabase locale: SUPABASE_DB_URL (es. postgresql://postgres:postgres@127.0.0.1:54322/postgres
//   dopo `supabase start` / `supabase db reset`). Le migrazioni sono già
//   applicate dalla CLI; nessun dato resta perché ogni test lavora in una
//   transazione annullata alla fine.
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

export async function migrationFiles() {
  const dir = join(root, 'supabase', 'migrations');
  return (await readdir(dir)).filter(f => f.endsWith('.sql')).sort().map(f => join(dir, f));
}

export async function setupDatabase() {
  if (process.env.SUPABASE_DB_URL) {
    const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
    await c.connect();
    return { client: c, async teardown() { await c.end(); } };
  }
  const adminUrl = process.env.TEST_PG_ADMIN_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const name = 'ps_test_' + Math.random().toString(36).slice(2, 8);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl); url.pathname = '/' + name;
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  await c.query(await readFile(join(here, 'bootstrap-vanilla-postgres.sql'), 'utf8'));
  for (const f of await migrationFiles()) await c.query(await readFile(f, 'utf8'));
  return {
    client: c, url: url.toString(), name,
    async teardown() { await c.end(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); },
  };
}

// Crea un utente in auth.users (come farebbe Supabase Auth alla registrazione).
export async function createUser(c, email) {
  const { rows } = await c.query(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email]);
  return rows[0].id;
}

// Esegue fn con i permessi di un utente autenticato (uid) o anonimo (null),
// esattamente come PostgREST: ruolo + claims del JWT.
export async function as(c, uid, fn) {
  await c.query('savepoint as_user');
  await c.query(uid ? 'set local role authenticated' : 'set local role anon');
  await c.query(`select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify(uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' })]);
  try {
    const out = await fn();
    await c.query('release savepoint as_user');
    await c.query('reset role');
    await c.query(`select set_config('request.jwt.claims', '', true)`);
    return out;
  } catch (e) {
    await c.query('rollback to savepoint as_user');
    throw e;
  }
}

// La query deve fallire con il codice SQLSTATE indicato.
export async function expectError(c, uid, sql, params, code) {
  let err = null;
  try { await as(c, uid, () => c.query(sql, params)); } catch (e) { err = e; }
  if (!err) throw new Error(`Doveva fallire (${code}) ma è riuscita: ${sql}`);
  if (code && err.code !== code) throw new Error(`Errore atteso ${code}, ricevuto ${err.code}: ${err.message}`);
  return err;
}
