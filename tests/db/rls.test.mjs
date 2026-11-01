// Isolamento dei dati tra account, verificato direttamente nel database
// (come farebbe una chiamata diretta alle API con il token di un utente).
// Esecuzione: npm run test:db   (vedi tests/db/helpers.mjs per la connessione)
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDatabase, createUser, as, expectError } from './helpers.mjs';

let db, c, A, B;
const TABLES = ['user_settings', 'subjects', 'tasks', 'study_slots', 'commitments', 'days_off', 'session_done', 'session_pins', 'local_imports'];
const HASH = 'a'.repeat(64);

before(async () => { db = await setupDatabase(); c = db.client; });
after(async () => { await db.teardown(); });
beforeEach(async () => {
  await c.query('begin');
  A = await createUser(c, `a-${Math.random()}@test.local`);
  B = await createUser(c, `b-${Math.random()}@test.local`);
});
afterEach(async () => { await c.query('rollback'); });

const q = (uid, sql, params = []) => as(c, uid, () => c.query(sql, params));

// Dati di A: materia, compito, fascia oraria, impegno, giorno libero, sessione fatta, spostamento, impostazioni.
async function seedA() {
  const s = (await q(A, `insert into subjects (name, color, position) values ('Matematica', '#8fb4f2', 0) returning *`)).rows[0];
  const t = (await q(A, `insert into tasks (subject_id, kind, due_date, mode, page_ranges, position)
                         values ($1, 'verifica', '2026-11-10', 'pagine', '[[1,20]]', 0) returning *`, [s.id])).rows[0];
  await q(A, `insert into study_slots (weekday, position, start_time, end_time) values (1, 0, '16:00', '18:00')`);
  const cm = (await q(A, `insert into commitments (name, days, start_time, end_time) values ('Danza', '{1,3}', '19:00', '21:00') returning *`)).rows[0];
  await q(A, `insert into days_off (day) values ('2026-11-08')`);
  await q(A, `insert into session_done (task_id, day, start_minute) values ($1, '2026-11-03', 960)`, [t.id]);
  await q(A, `insert into session_pins (task_id, is_review, days) values ($1, false, '{2026-11-04}')`, [t.id]);
  await q(A, `insert into user_settings (session_minutes, pause_minutes) values (40, 20)`);
  return { s, t, cm };
}

test('un nuovo account trova un ambiente vuoto', async () => {
  await seedA();
  for (const t of TABLES) {
    const { rows } = await q(B, `select * from ${t}`);
    assert.equal(rows.length, 0, `B non deve vedere righe in ${t}`);
  }
});

test('A vede i propri dati, B no (lettura)', async () => {
  const { s } = await seedA();
  assert.equal((await q(A, 'select * from subjects')).rows.length, 1);
  assert.equal((await q(A, 'select * from tasks')).rows.length, 1);
  assert.equal((await q(B, 'select * from subjects where id = $1', [s.id])).rows.length, 0);
  assert.equal((await q(B, 'select * from session_done')).rows.length, 0);
  assert.equal((await q(B, 'select * from user_settings')).rows.length, 0);
});

test('B non può modificare né eliminare i dati di A', async () => {
  const { s, t, cm } = await seedA();
  for (const [sql, p] of [
    [`update subjects set name = 'hack' where id = $1`, [s.id]],
    [`update tasks set note = 'hack' where id = $1`, [t.id]],
    [`update commitments set name = 'hack' where id = $1`, [cm.id]],
    [`update user_settings set goal = 'hack' where user_id = $1`, [A]],
    [`update study_slots set start_time = '01:00' where user_id = $1`, [A]],
    [`update session_pins set days = '{}' where user_id = $1`, [A]],
    [`delete from subjects where id = $1`, [s.id]],
    [`delete from tasks where id = $1`, [t.id]],
    [`delete from days_off where user_id = $1`, [A]],
    [`delete from session_done where user_id = $1`, [A]],
    [`delete from session_pins where user_id = $1`, [A]],
    [`delete from user_settings where user_id = $1`, [A]],
  ]) {
    const r = await q(B, sql, p);
    assert.equal(r.rowCount, 0, `nessuna riga toccata da B: ${sql}`);
  }
  const still = (await q(A, 'select name from subjects where id = $1', [s.id])).rows[0];
  assert.equal(still.name, 'Matematica');
  assert.equal((await q(A, 'select count(*)::int n from session_done')).rows[0].n, 1);
});

test('non si possono creare record per un altro utente', async () => {
  for (const [sql, p] of [
    [`insert into subjects (user_id, name) values ($1, 'x')`, [A]],
    [`insert into user_settings (user_id) values ($1)`, [A]],
    [`insert into study_slots (user_id, weekday, position) values ($1, 1, 0)`, [A]],
    [`insert into commitments (user_id, name) values ($1, 'x')`, [A]],
    [`insert into days_off (user_id, day) values ($1, '2026-01-01')`, [A]],
    [`insert into local_imports (user_id, source_hash) values ($1, '${HASH}')`, [A]],
  ]) await expectError(c, B, sql, p, '42501');
  assert.equal((await q(A, 'select count(*)::int n from subjects')).rows[0].n, 0);
});

test('non si può trasferire un proprio record a un altro utente', async () => {
  const { s, t } = await seedA();
  await expectError(c, A, `update subjects set user_id = $1 where id = $2`, [B, s.id], '42501');
  await expectError(c, A, `update tasks set user_id = $1 where id = $2`, [B, t.id], '42501');
  await expectError(c, A, `update user_settings set user_id = $1`, [B], '42501');
});

test('non si possono collegare record di utenti diversi', async () => {
  const { s, t } = await seedA();
  // B prova a creare un compito nella materia di A, o a spostare il proprio compito lì
  await expectError(c, B, `insert into tasks (subject_id, kind, mode) values ($1, 'verifica', 'pagine')`, [s.id], '23503');
  const sb = (await q(B, `insert into subjects (name) values ('mia') returning id`)).rows[0];
  const tb = (await q(B, `insert into tasks (subject_id) values ($1) returning id`, [sb.id])).rows[0];
  await expectError(c, B, `update tasks set subject_id = $1 where id = $2`, [s.id, tb.id], '23503');
  // B prova a segnare come fatta o a spostare una sessione del compito di A
  await expectError(c, B, `insert into session_done (task_id, day, start_minute) values ($1, '2026-11-03', 900)`, [t.id], '23503');
  await expectError(c, B, `insert into session_pins (task_id, days) values ($1, '{2026-11-04}')`, [t.id], '23503');
  // e A non può collegare un proprio compito alla materia di B
  const ta = (await q(A, 'select id from tasks')).rows[0];
  await expectError(c, A, `update tasks set subject_id = $1 where id = $2`, [sb.id, ta.id], '23503');
});

test('gli utenti non autenticati non accedono ai dati personali', async () => {
  await seedA();
  for (const t of TABLES) {
    await expectError(c, null, `select * from ${t}`, [], '42501');
  }
  await expectError(c, null, `insert into subjects (user_id, name) values ($1, 'x')`, [A], '42501');
  await expectError(c, null, `select public.import_local_data($1, '{}'::jsonb)`, [HASH], '42501');
});

test('niente TRUNCATE per gli utenti (ignorerebbe la RLS)', async () => {
  await seedA();
  await expectError(c, B, 'truncate subjects cascade', [], '42501');
});

test('versione e date gestite dal database', async () => {
  const { s } = await seedA();
  assert.equal(s.version, 1);
  const u = (await q(A, `update subjects set name = 'Mate', version = 99, created_at = '2000-01-01' where id = $1 returning *`, [s.id])).rows[0];
  assert.equal(u.version, 2);
  assert.equal(u.created_at.toISOString(), s.created_at.toISOString());
  assert.ok(u.updated_at >= s.updated_at);
  // modifica condizionata alla versione: con una versione vecchia non tocca niente
  const stale = await q(A, `update subjects set name = 'vecchia' where id = $1 and version = 1`, [s.id]);
  assert.equal(stale.rowCount, 0);
});

test('vincoli sui valori', async () => {
  await expectError(c, A, `insert into subjects (name, color) values ('x', 'red')`, [], '23514');
  await expectError(c, A, `insert into tasks (kind) values ('altro')`, [], '23514');
  await expectError(c, A, `insert into commitments (days) values ('{7}')`, [], '23514');
  await expectError(c, A, `insert into study_slots (weekday, position) values (9, 0)`, [], '23514');
  await expectError(c, A, `insert into tasks (page_ranges) values ('{"a":1}')`, [], '23514');
});

test('eliminando una materia si eliminano le sue verifiche, sessioni fatte e spostamenti', async () => {
  const { s } = await seedA();
  await q(A, 'delete from subjects where id = $1', [s.id]);
  for (const t of ['tasks', 'session_done', 'session_pins']) {
    assert.equal((await q(A, `select count(*)::int n from ${t}`)).rows[0].n, 0, t);
  }
});

test('registro importazioni: non modificabile né cancellabile', async () => {
  await q(A, `insert into local_imports (source_hash) values ('${HASH}')`);
  await expectError(c, A, `update local_imports set source_hash = '${'b'.repeat(64)}'`, [], '42501');
  await expectError(c, A, `delete from local_imports`, [], '42501');
});
