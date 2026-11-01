// Importazione dei dati locali: tutto o niente, niente doppioni, solo nel
// proprio account, nessun collegamento a dati altrui.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupDatabase, createUser, as, expectError } from './helpers.mjs';
import { buildImportPayload } from '../../src/model.js';

let db, c, A, B;
before(async () => { db = await setupDatabase(); c = db.client; });
after(async () => { await db.teardown(); });
beforeEach(async () => {
  await c.query('begin');
  A = await createUser(c, `a-${Math.random()}@test.local`);
  B = await createUser(c, `b-${Math.random()}@test.local`);
});
afterEach(async () => { await c.query('rollback'); });

const q = (uid, sql, params = []) => as(c, uid, () => c.query(sql, params));
const H1 = '1'.repeat(64), H2 = '2'.repeat(64);
const rpc = (uid, hash, payload) => q(uid, 'select public.import_local_data($1, $2::jsonb) as r', [hash, JSON.stringify(payload)]).then(x => x.rows[0].r);
const count = async (uid, t) => (await q(uid, `select count(*)::int n from ${t}`)).rows[0].n;

// Dati come li salvava la vecchia versione dell'app in localStorage (id brevi).
function legacy() {
  return {
    start: '2026-11-02', sess: 40, pausa: 20, maxPerDay: 4, buffer: 15, subtitle: 'Studio', goal: 'arrivare preparata',
    subjects: [{ id: 's0', name: 'Latino', color: '#d9c6f5' }, { id: 's1', name: 'Arte', color: '#f7b6d2' }],
    tasks: [
      { id: 't1', subj: 's0', kind: 'consegna', date: '2026-11-03', mode: 'sessioni', ranges: [['', '']], extras: [], sessions: 1, note: 'Versione', ripasso: false },
      { id: 't5', subj: 's1', kind: 'verifica', date: '2026-11-09', mode: 'pagine', ranges: [[1, 15]], extras: ['Appunti'], sessions: 1, note: '', ripasso: true },
    ],
    week: { 0: [], 1: [['16:00', '18:30']], 2: [], 3: [], 4: [], 5: [['15:30', '19:45']], 6: [] },
    commitments: [{ id: 'c1', name: 'Danza', days: [1], from: '19:00', to: '21:00', relax: true, color: '#f7b6d2' }],
    off: ['2026-11-07'], done: { '2026-11-02|960|t1': true }, pins: { t5: ['2026-11-05'] },
  };
}

test('importazione completa in un account vuoto', async () => {
  const p = buildImportPayload(legacy(), { includeWeekAndSettings: true });
  const r = await rpc(A, H1, p);
  assert.equal(r.status, 'imported');
  assert.equal(await count(A, 'subjects'), 2);
  assert.equal(await count(A, 'tasks'), 2);
  assert.equal(await count(A, 'study_slots'), 2);
  assert.equal(await count(A, 'commitments'), 1);
  assert.equal(await count(A, 'days_off'), 1);
  assert.equal(await count(A, 'session_done'), 1);
  assert.equal(await count(A, 'session_pins'), 1);
  const set = (await q(A, 'select * from user_settings')).rows[0];
  assert.equal(set.session_minutes, 40); assert.equal(set.goal, 'arrivare preparata');
  const t = (await q(A, `select t.note, s.name from tasks t join subjects s on s.id = t.subject_id order by t.position`)).rows;
  assert.deepEqual(t.map(x => x.name), ['Latino', 'Arte'], 'relazioni e ordine mantenuti');
  assert.equal(await count(B, 'subjects'), 0, 'B non vede niente');
});

test('ripetere la stessa importazione non crea doppioni', async () => {
  const p1 = buildImportPayload(legacy(), { includeWeekAndSettings: true });
  assert.equal((await rpc(A, H1, p1)).status, 'imported');
  const p2 = buildImportPayload(legacy(), { includeWeekAndSettings: true }); // id nuovi, stesso contenuto
  assert.equal((await rpc(A, H1, p2)).status, 'already_imported');
  assert.equal(await count(A, 'subjects'), 2);
  assert.equal(await count(A, 'tasks'), 2);
  assert.equal(await count(A, 'local_imports'), 1);
});

test('lo stesso dispositivo può importare in un altro account solo con una chiamata esplicita, e i dati restano separati', async () => {
  await rpc(A, H1, buildImportPayload(legacy(), { includeWeekAndSettings: true }));
  const r = await rpc(B, H1, buildImportPayload(legacy(), { includeWeekAndSettings: true }));
  assert.equal(r.status, 'imported');
  const ia = (await q(A, 'select id from subjects')).rows.map(x => x.id);
  const ib = (await q(B, 'select id from subjects')).rows.map(x => x.id);
  assert.equal(ia.filter(x => ib.includes(x)).length, 0);
});

test('in un account con dati si aggiungono in coda; orari e impostazioni non vengono toccati', async () => {
  await q(A, `insert into subjects (name, position) values ('Esistente', 0)`);
  await q(A, `insert into study_slots (weekday, position, start_time, end_time) values (1, 0, '09:00', '10:00')`);
  await q(A, `insert into user_settings (session_minutes) values (25)`);
  const p = buildImportPayload(legacy(), { includeWeekAndSettings: false });
  assert.equal((await rpc(A, H2, p)).status, 'imported');
  const names = (await q(A, 'select name from subjects order by position')).rows.map(x => x.name);
  assert.deepEqual(names, ['Esistente', 'Latino', 'Arte']);
  assert.equal(await count(A, 'study_slots'), 1);
  assert.equal((await q(A, 'select session_minutes from user_settings')).rows[0].session_minutes, 25);
});

test('tutto o niente: un dato non valido annulla l’intera importazione', async () => {
  const p = buildImportPayload(legacy(), { includeWeekAndSettings: true });
  p.tasks[1].kind = 'non-valido';
  await expectError(c, A, 'select public.import_local_data($1, $2::jsonb)', [H1, JSON.stringify(p)], '23514');
  for (const t of ['subjects', 'tasks', 'commitments', 'study_slots', 'local_imports', 'user_settings']) {
    assert.equal(await count(A, t), 0, t);
  }
  // e dopo l'errore si può riprovare con lo stesso hash
  const ok = buildImportPayload(legacy(), { includeWeekAndSettings: true });
  assert.equal((await rpc(A, H1, ok)).status, 'imported');
});

test('l’importazione non può collegare dati di un altro utente', async () => {
  const sA = (await q(A, `insert into subjects (name) values ('di A') returning id`)).rows[0].id;
  const p = buildImportPayload(legacy(), { includeWeekAndSettings: false });
  p.tasks[0].subject_id = sA; // B prova a mettere un compito nella materia di A
  await expectError(c, B, 'select public.import_local_data($1, $2::jsonb)', [H1, JSON.stringify(p)], '23503');
  const tA = (await q(A, `insert into tasks (subject_id) values ($1) returning id`, [sA])).rows[0].id;
  const p2 = buildImportPayload(legacy(), { includeWeekAndSettings: false });
  p2.session_done = [{ task_id: tA, day: '2026-11-02', start_minute: 900 }];
  await expectError(c, B, 'select public.import_local_data($1, $2::jsonb)', [H2, JSON.stringify(p2)], '23503');
  assert.equal(await count(B, 'subjects'), 0);
});

test('l’importazione scrive sempre nell’account di chi chiama', async () => {
  const p = buildImportPayload(legacy(), { includeWeekAndSettings: true });
  p.subjects[0].user_id = A; // campo ignorato dalla funzione
  await rpc(B, H1, p);
  assert.equal(await count(A, 'subjects'), 0);
  assert.equal(await count(B, 'subjects'), 2);
});

test('un id già usato da un altro utente non permette di sovrascriverne i dati', async () => {
  const sA = (await q(A, `insert into subjects (name) values ('di A') returning id`)).rows[0].id;
  const p = buildImportPayload(legacy(), { includeWeekAndSettings: false });
  p.subjects[0].id = sA;
  p.tasks.forEach(t => { if (t.subject_id === p.subjects[0].id) t.subject_id = sA; });
  await expectError(c, B, 'select public.import_local_data($1, $2::jsonb)', [H1, JSON.stringify(p)], '23505');
  assert.equal((await q(A, 'select name from subjects where id = $1', [sA])).rows[0].name, 'di A');
});
