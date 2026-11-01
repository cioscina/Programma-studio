// Test del modello dati: conversione stato <-> righe, differenze, unione con
// il server, preparazione dell'importazione dei dati locali.
// Esecuzione: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stateToRows, rowsToState, diff, fromServer, mergeServer, remapIds, buildImportPayload,
  localSummary, rowsAreEmpty, isUuid, canonical, TABLE_ORDER, emptyRows,
} from '../src/model.js';

const U = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const emptyData = () => ({
  example: false, start: '2026-11-02', sess: 40, pausa: 20, maxPerDay: 4, buffer: 15, subtitle: 'sub', goal: 'goal',
  subjects: [], tasks: [], week: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, commitments: [], off: [], done: {}, pins: {},
});
function sampleState() {
  const S = emptyData();
  S.subjects = [{ id: U(1), name: 'Matematica', color: '#8fb4f2' }, { id: U(2), name: 'Storia', color: '#a6e3b5' }];
  S.tasks = [
    { id: U(10), subj: U(1), kind: 'verifica', date: '2026-11-10', mode: 'pagine', ranges: [[1, 20], ['35', '40']], extras: ['Appunti'], sessions: 1, note: '', ripasso: true },
    { id: U(11), subj: U(2), kind: 'consegna', date: '2026-11-05', mode: 'sessioni', ranges: [['', '']], extras: [], sessions: 2, note: 'Esercizi', ripasso: false },
  ];
  S.week[1] = [['16:00', '18:30']]; S.week[6] = [['10:00', '12:00'], ['16:00', '17:00']];
  S.commitments = [{ id: U(20), name: 'Danza', days: [1, 3], from: '19:00', to: '21:00', relax: true, color: '#f7b6d2' }];
  S.off = ['2026-11-08'];
  S.done = { [`2026-11-03|960|${U(10)}`]: true };
  S.pins = { [U(10)]: ['2026-11-04'], [U(10) + '#r']: ['2026-11-09'] };
  return S;
}
// Simula ciò che restituirebbe il server per queste righe.
function asServer(rows, version = 1) {
  const o = {};
  for (const t of TABLE_ORDER) o[t] = [...rows[t].values()].map(r => ({ ...r, version, user_id: 'u',
    ...(r.start_time ? { start_time: r.start_time + ':00' } : {}), ...(r.end_time ? { end_time: r.end_time + ':00' } : {}) }));
  return o;
}

test('stato -> righe -> stato conserva tutti i dati e gli ordinamenti', () => {
  const S = sampleState();
  const back = rowsToState(stateToRows(S), emptyData);
  assert.deepEqual(back.subjects, S.subjects);
  assert.deepEqual(back.tasks.map(t => t.id), [U(10), U(11)]);
  assert.deepEqual(back.tasks[0].ranges, [[1, 20], ['35', '40']]);
  assert.deepEqual(back.tasks[0].extras, ['Appunti']);
  assert.equal(back.tasks[0].subj, U(1));
  assert.deepEqual(back.week[6], [['10:00', '12:00'], ['16:00', '17:00']]);
  assert.deepEqual(back.commitments, S.commitments);
  assert.deepEqual(back.off, S.off);
  assert.deepEqual(back.done, S.done);
  assert.deepEqual(back.pins, S.pins);
  assert.equal(back.sess, 40); assert.equal(back.goal, 'goal');
});

test('i valori restituiti dal server (orari HH:MM:SS) non generano modifiche fantasma', () => {
  const S = sampleState();
  const server = fromServer(asServer(stateToRows(S)));
  assert.equal(diff(stateToRows(S), server.base).length, 0);
});

test('diff: inserimenti prima dei figli, eliminazioni dopo e in ordine inverso', () => {
  const S = sampleState();
  const base = fromServer(asServer(stateToRows(S))).base;
  // nuova materia con un compito nuovo; eliminata Storia con il suo compito
  S.subjects = [S.subjects[0], { id: U(3), name: 'Inglese', color: '#f9c48a' }];
  S.tasks = [S.tasks[0], { ...S.tasks[1], id: U(12), subj: U(3) }];
  const ops = diff(stateToRows(S), base);
  const idx = (op, key) => ops.findIndex(o => o.op === op && o.key === key);
  assert.ok(idx('insert', U(3)) < idx('insert', U(12)), 'materia prima del compito');
  assert.ok(idx('delete', U(11)) < idx('delete', U(2)), 'compito eliminato prima della materia');
  assert.ok(idx('insert', U(12)) < idx('delete', U(2)), 'prima si inserisce, poi si elimina');
  const upd = ops.filter(o => o.op === 'update');
  assert.ok(upd.every(o => o.version === 1));
});

test('le modifiche portano la versione conosciuta (concorrenza ottimistica)', () => {
  const S = sampleState();
  const base = fromServer(asServer(stateToRows(S), 7)).base;
  S.subjects[0].name = 'Mate';
  const ops = diff(stateToRows(S), base);
  assert.equal(ops.length, 1);
  assert.deepEqual([ops[0].op, ops[0].table, ops[0].version, ops[0].row.name], ['update', 'subjects', 7, 'Mate']);
});

test('merge: le righe non toccate prendono il valore del server, quelle modificate restano locali con la vecchia versione', () => {
  const S = sampleState();
  const oldBase = fromServer(asServer(stateToRows(S), 1)).base;
  // localmente: rinomino Matematica (non ancora salvato)
  S.subjects[0].name = 'Mate (locale)';
  // sul server: un altro dispositivo ha rinominato Storia e Matematica, e aggiunto un giorno libero
  const srvRows = stateToRows(sampleState());
  srvRows.subjects.get(U(2)).name = 'Storia (remoto)';
  srvRows.subjects.get(U(1)).name = 'Mate (remoto)';
  srvRows.days_off.set('2026-11-20', { day: '2026-11-20' });
  const server = fromServer(asServer(srvRows, 2));
  const m = mergeServer(stateToRows(S), oldBase, server);
  assert.equal(m.rows.subjects.get(U(2)).name, 'Storia (remoto)');
  assert.equal(m.rows.subjects.get(U(1)).name, 'Mate (locale)');
  assert.equal(m.base.subjects.get(U(1)).version, 1, 'la vecchia versione resta: il salvataggio rileverà il conflitto');
  assert.equal(m.base.subjects.get(U(2)).version, 2);
  assert.ok(m.rows.days_off.has('2026-11-20'));
  const ops = diff(m.rows, m.base);
  assert.equal(ops.length, 1); assert.equal(ops[0].version, 1);
});

test('merge: una riga eliminata altrove sparisce se non era stata toccata', () => {
  const S = sampleState();
  const oldBase = fromServer(asServer(stateToRows(S))).base;
  const srv = stateToRows(S); srv.commitments.delete(U(20));
  const m = mergeServer(stateToRows(S), oldBase, fromServer(asServer(srv)));
  assert.ok(!m.rows.commitments.has(U(20)));
  assert.equal(diff(m.rows, m.base).length, 0);
});

test('remapIds sostituisce gli id brevi delle vecchie versioni e aggiorna i riferimenti', () => {
  const S = emptyData();
  S.subjects = [{ id: 's0', name: 'A', color: '#000000' }];
  S.tasks = [{ id: 't1', subj: 's0', kind: 'verifica', date: '2026-11-10', mode: 'pagine', ranges: [[1, 2]], extras: [], sessions: 1, note: '', ripasso: false },
    { id: 't2', subj: 'zz', kind: 'verifica', date: '', mode: 'pagine', ranges: [['', '']], extras: [], sessions: 1, note: '', ripasso: false }];
  S.commitments = [{ id: 'c1', name: 'Danza', days: [1], from: '17:00', to: '18:00', relax: false, color: '#f7b6d2' }];
  S.done = { '2026-11-03|960|t1': true, '2026-11-03|960|nope': true };
  S.pins = { t1: ['2026-11-04'], 't1#r': ['2026-11-09'], ghost: ['2026-11-01'] };
  const R = remapIds(S);
  assert.ok(isUuid(R.subjects[0].id) && isUuid(R.tasks[0].id) && isUuid(R.commitments[0].id));
  assert.equal(R.tasks[0].subj, R.subjects[0].id);
  assert.equal(R.tasks[1].subj, '', 'materia inesistente -> nessuna materia');
  assert.deepEqual(Object.keys(R.done), [`2026-11-03|960|${R.tasks[0].id}`]);
  assert.deepEqual(Object.keys(R.pins).sort(), [R.tasks[0].id, R.tasks[0].id + '#r'].sort());
  assert.equal(S.subjects[0].id, 's0', 'i dati originali non vengono modificati');
});

test('payload di importazione: orari e impostazioni solo se l’account è vuoto', () => {
  const S = sampleState();
  const full = buildImportPayload(S, { includeWeekAndSettings: true });
  assert.equal(full.subjects.length, 2); assert.equal(full.tasks.length, 2);
  assert.equal(full.study_slots.length, 3); assert.equal(full.user_settings.session_minutes, 40);
  assert.equal(full.session_done.length, 1); assert.equal(full.session_pins.length, 2);
  const ids = new Set(full.subjects.map(s => s.id));
  assert.ok(full.tasks.every(t => ids.has(t.subject_id)));
  assert.ok(!ids.has(U(1)), 'id nuovi, mai quelli originali');
  const part = buildImportPayload(S, { includeWeekAndSettings: false });
  assert.equal(part.study_slots, undefined); assert.equal(part.user_settings, undefined);
});

test('localSummary ignora l’esempio e i dati vuoti', () => {
  assert.equal(localSummary(null), null);
  assert.equal(localSummary(emptyData()), null);
  assert.equal(localSummary({ ...sampleState(), example: true }), null);
  assert.deepEqual(localSummary(sampleState()), { subjects: 2, tasks: 2, commitments: 1, slots: 3, off: 1 });
});

test('canonical: valori non validi diventano null o valori predefiniti', () => {
  const c = canonical('tasks', { id: U(1), kind: 'boh', mode: 'x', due_date: '10/11', sessions: '3.6', page_ranges: 'no', extras: null });
  assert.deepEqual([c.kind, c.mode, c.due_date, c.sessions, c.page_ranges, c.extras], ['verifica', 'pagine', null, 4, [], []]);
  assert.equal(canonical('commitments', { id: U(1), days: [1, 1, 9, '3'], color: 'red', start_time: '25:00' }).days.join(), '1,3');
  assert.equal(canonical('commitments', { id: U(1), color: 'red' }).color, '#f7b6d2');
  assert.ok(rowsAreEmpty(emptyRows()));
});
