// Programma Studio — conversione tra lo stato dell'app e le righe del database.
//
// Modulo "puro" (nessun accesso a rete, DOM o storage): si usa nel browser e
// nei test con Node. Lo stato dell'app (oggetto S) resta quello di sempre;
// qui lo si trasforma in righe per tabella e viceversa, si calcolano le
// differenze da salvare e si uniscono le modifiche arrivate da altri dispositivi.

export const TABLES = {
  user_settings: { pk: [], versioned: true, key: () => 'me' },
  subjects:      { pk: ['id'], versioned: true, key: r => r.id },
  tasks:         { pk: ['id'], versioned: true, key: r => r.id },
  study_slots:   { pk: ['weekday', 'position'], versioned: true, key: r => `${r.weekday}:${r.position}` },
  commitments:   { pk: ['id'], versioned: true, key: r => r.id },
  days_off:      { pk: ['day'], versioned: false, key: r => r.day },
  session_pins:  { pk: ['task_id', 'is_review'], versioned: true, key: r => `${r.task_id}|${r.is_review ? 1 : 0}` },
  session_done:  { pk: ['task_id', 'day', 'start_minute'], versioned: false, key: r => `${r.task_id}|${r.day}|${r.start_minute}` },
};
// Ordine per inserimenti e modifiche (prima i "genitori"); le eliminazioni
// vanno nell'ordine inverso.
export const TABLE_ORDER = ['user_settings', 'subjects', 'tasks', 'study_slots', 'commitments', 'days_off', 'session_pins', 'session_done'];

const KINDS = ['verifica', 'interrogazione', 'consegna'];
const MODES = ['pagine', 'sessioni'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

export function newUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- normalizzazione dei singoli valori ----------
const toInt = v => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};
const clampInt = (v, lo, hi) => { const n = toInt(v); return n === null ? null : Math.min(hi, Math.max(lo, n)); };
const toDate = v => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
const toTime = v => {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{2}):(\d{2})/);
  return m && +m[1] < 24 && +m[2] < 60 ? `${m[1]}:${m[2]}` : null;
};
const toText = (v, max) => String(v ?? '').slice(0, max);
const toColor = (v, d) => (typeof v === 'string' && COLOR_RE.test(v) ? v : d);
// valori di pagina così come li scrive l'interfaccia ('' / numero / stringa)
const pageVal = v => (typeof v === 'number' && Number.isFinite(v)) ? v : (typeof v === 'string' ? v.slice(0, 12) : '');

// ---------- canonico: la forma con cui si confrontano locale e server ----------
export function canonical(table, r) {
  switch (table) {
    case 'user_settings': return {
      start_date: toDate(r.start_date), session_minutes: clampInt(r.session_minutes, 0, 1440),
      pause_minutes: clampInt(r.pause_minutes, 0, 1440), max_per_day: clampInt(r.max_per_day, 0, 100),
      buffer_minutes: clampInt(r.buffer_minutes, 0, 1440), subtitle: toText(r.subtitle, 500), goal: toText(r.goal, 5000),
    };
    case 'subjects': return { id: r.id, name: toText(r.name, 200), color: toColor(r.color, '#8fb4f2'), position: toInt(r.position) ?? 0 };
    case 'tasks': return {
      id: r.id, subject_id: r.subject_id ?? null, kind: KINDS.includes(r.kind) ? r.kind : 'verifica',
      due_date: toDate(r.due_date), mode: MODES.includes(r.mode) ? r.mode : 'pagine',
      page_ranges: (Array.isArray(r.page_ranges) ? r.page_ranges : []).slice(0, 200)
        .map(p => (Array.isArray(p) ? [pageVal(p[0]), pageVal(p[1])] : ['', ''])),
      extras: (Array.isArray(r.extras) ? r.extras : []).slice(0, 200).map(x => toText(x, 500)),
      sessions: clampInt(r.sessions, 0, 1000), note: toText(r.note, 2000), review: !!r.review, position: toInt(r.position) ?? 0,
    };
    case 'study_slots': return { weekday: +r.weekday, position: +r.position, start_time: toTime(r.start_time), end_time: toTime(r.end_time) };
    case 'commitments': return {
      id: r.id, name: toText(r.name, 200),
      days: [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b),
      start_time: toTime(r.start_time), end_time: toTime(r.end_time), relax: !!r.relax,
      color: toColor(r.color, '#f7b6d2'), position: toInt(r.position) ?? 0,
    };
    case 'days_off': return { day: r.day };
    case 'session_pins': return { task_id: r.task_id, is_review: !!r.is_review, days: (r.days || []).filter(d => DATE_RE.test(d)).slice(0, 366) };
    case 'session_done': return { task_id: r.task_id, day: r.day, start_minute: +r.start_minute };
  }
  throw new Error('Tabella sconosciuta: ' + table);
}
export const sameRow = (table, a, b) => JSON.stringify(canonical(table, a)) === JSON.stringify(canonical(table, b));

// ---------- stato dell'app -> righe ----------
export function emptyRows() { const o = {}; for (const t of TABLE_ORDER) o[t] = new Map(); return o; }

export function stateToRows(S) {
  const out = emptyRows();
  const put = (t, r) => { const c = canonical(t, r); out[t].set(TABLES[t].key(c), c); };
  put('user_settings', {
    start_date: S.start, session_minutes: S.sess, pause_minutes: S.pausa, max_per_day: S.maxPerDay,
    buffer_minutes: S.buffer, subtitle: S.subtitle, goal: S.goal,
  });
  const subjIds = new Set();
  (S.subjects || []).forEach((s, i) => { if (!isUuid(s.id)) return; subjIds.add(s.id); put('subjects', { id: s.id, name: s.name, color: s.color, position: i }); });
  const taskIds = new Set();
  (S.tasks || []).forEach((t, i) => {
    if (!isUuid(t.id)) return;
    taskIds.add(t.id);
    put('tasks', {
      id: t.id, subject_id: subjIds.has(t.subj) ? t.subj : null, kind: t.kind, due_date: t.date, mode: t.mode,
      page_ranges: t.ranges, extras: t.extras, sessions: t.sessions, note: t.note, review: t.ripasso, position: i,
    });
  });
  for (let w = 0; w < 7; w++) {
    ((S.week || {})[w] || []).forEach((sl, i) => put('study_slots', { weekday: w, position: i, start_time: sl[0], end_time: sl[1] }));
  }
  (S.commitments || []).forEach((c, i) => {
    if (!isUuid(c.id)) return;
    put('commitments', { id: c.id, name: c.name, days: c.days, start_time: c.from, end_time: c.to, relax: c.relax, color: c.color, position: i });
  });
  for (const d of S.off || []) if (DATE_RE.test(d)) put('days_off', { day: d });
  for (const [k, v] of Object.entries(S.pins || {})) {
    const review = k.endsWith('#r'), tid = review ? k.slice(0, -2) : k;
    if (!taskIds.has(tid) || !Array.isArray(v) || !v.length) continue;
    put('session_pins', { task_id: tid, is_review: review, days: v });
  }
  for (const [k, v] of Object.entries(S.done || {})) {
    if (!v) continue;
    const [day, a, tid] = String(k).split('|');
    if (!taskIds.has(tid) || !DATE_RE.test(day) || !/^\d+$/.test(a)) continue;
    put('session_done', { task_id: tid, day, start_minute: +a });
  }
  return out;
}

// ---------- righe -> stato dell'app ----------
// defaults: funzione che restituisce lo stato vuoto dell'app (emptyData).
export function rowsToState(rows, defaults) {
  const S = defaults();
  const set = rows.user_settings.get('me');
  if (set) {
    const v = x => (x === null || x === undefined ? '' : x);
    S.start = v(set.start_date); S.sess = v(set.session_minutes); S.pausa = v(set.pause_minutes);
    S.maxPerDay = v(set.max_per_day); S.buffer = v(set.buffer_minutes); S.subtitle = set.subtitle; S.goal = set.goal;
  }
  const byPos = m => [...m.values()].sort((a, b) => a.position - b.position || String(a.id).localeCompare(String(b.id)));
  S.subjects = byPos(rows.subjects).map(r => ({ id: r.id, name: r.name, color: r.color }));
  S.tasks = byPos(rows.tasks).map(r => ({
    id: r.id, subj: r.subject_id || '', kind: r.kind, date: r.due_date || '', mode: r.mode,
    ranges: r.page_ranges.length ? r.page_ranges.map(p => [...p]) : [['', '']], extras: [...r.extras],
    sessions: r.sessions === null ? '' : r.sessions, note: r.note, ripasso: r.review,
  }));
  S.week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const r of [...rows.study_slots.values()].sort((a, b) => a.weekday - b.weekday || a.position - b.position)) {
    S.week[r.weekday].push([r.start_time || '', r.end_time || '']);
  }
  S.commitments = byPos(rows.commitments).map(r => ({
    id: r.id, name: r.name, days: [...r.days], from: r.start_time || '', to: r.end_time || '', relax: r.relax, color: r.color,
  }));
  S.off = [...rows.days_off.keys()].sort();
  S.pins = {};
  for (const r of rows.session_pins.values()) S.pins[r.task_id + (r.is_review ? '#r' : '')] = [...r.days];
  S.done = {};
  for (const r of rows.session_done.values()) S.done[`${r.day}|${r.start_minute}|${r.task_id}`] = true;
  S.example = false;
  return S;
}

// Righe del server (come arrivano dall'API) -> { rows, base }.
// base[t] = Map(chiave -> { row, version })
export function fromServer(serverTables) {
  const rows = emptyRows(), base = emptyRows();
  for (const t of TABLE_ORDER) {
    for (const raw of serverTables[t] || []) {
      const c = canonical(t, raw), k = TABLES[t].key(c);
      rows[t].set(k, c);
      base[t].set(k, { row: c, version: TABLES[t].versioned ? raw.version : null });
    }
  }
  return { rows, base };
}

// ---------- differenze da salvare ----------
// Restituisce le operazioni per portare il server (base) allo stato locale.
export function diff(local, base) {
  const upserts = [], deletes = [];
  for (const t of TABLE_ORDER) {
    for (const [k, row] of local[t]) {
      const b = base[t].get(k);
      if (!b || b.virtual) { if (!b || !sameRow(t, row, b.row)) upserts.push({ op: 'insert', table: t, key: k, row }); }
      else if (!sameRow(t, row, b.row)) upserts.push({ op: 'update', table: t, key: k, row, version: b.version });
    }
  }
  for (const t of [...TABLE_ORDER].reverse()) {
    for (const [k, b] of base[t]) {
      if (b.virtual) continue;
      if (!local[t].has(k)) deletes.push({ op: 'delete', table: t, key: k, row: b.row, version: b.version });
    }
  }
  return [...upserts, ...deletes];
}

// ---------- unione con i dati più recenti del server ----------
// Le righe che l'utente non ha toccato prendono il valore del server; quelle
// con modifiche locali non ancora salvate restano locali e mantengono la
// vecchia versione di base, così il salvataggio successivo rileva l'eventuale
// conflitto invece di sovrascrivere.
export function mergeServer(local, oldBase, server) {
  const rows = emptyRows(), base = emptyRows();
  for (const t of TABLE_ORDER) {
    const keys = new Set([...local[t].keys(), ...oldBase[t].keys(), ...server.base[t].keys()]);
    for (const k of keys) {
      const l = local[t].get(k), ob = oldBase[t].get(k), sb = server.base[t].get(k);
      const clean = ob ? (l ? sameRow(t, l, ob.row) : false) : !l;
      if (clean || (ob && ob.virtual && l && sameRow(t, l, ob.row))) {
        if (sb) { rows[t].set(k, sb.row); base[t].set(k, sb); }
        else if (ob && ob.virtual) { rows[t].set(k, l); base[t].set(k, ob); }
      } else {
        if (l) rows[t].set(k, l);
        if (ob) base[t].set(k, ob);
      }
    }
  }
  return { rows, base };
}

export function rowsEqual(a, b) {
  for (const t of TABLE_ORDER) {
    if (a[t].size !== b[t].size) return false;
    for (const [k, r] of a[t]) { const o = b[t].get(k); if (!o || !sameRow(t, r, o)) return false; }
  }
  return true;
}

// ---------- dati locali da importare ----------
// Sostituisce tutti gli id (anche quelli brevi delle vecchie versioni) con
// UUID nuovi e aggiorna i riferimenti (materia del compito, sessioni fatte,
// spostamenti).
export function remapIds(S, makeId = newUuid) {
  const m = new Map();
  const id = old => { if (!m.has(old)) m.set(old, makeId()); return m.get(old); };
  const subjects = (S.subjects || []).map(s => ({ ...s, id: id('s:' + s.id) }));
  const subjMap = new Map((S.subjects || []).map((s, i) => [s.id, subjects[i].id]));
  const tasks = (S.tasks || []).map(t => ({ ...t, id: id('t:' + t.id), subj: subjMap.get(t.subj) || '' }));
  const taskMap = new Map((S.tasks || []).map((t, i) => [t.id, tasks[i].id]));
  const commitments = (S.commitments || []).map(c => ({ ...c, id: id('c:' + c.id) }));
  const pins = {};
  for (const [k, v] of Object.entries(S.pins || {})) {
    const review = k.endsWith('#r'), tid = taskMap.get(review ? k.slice(0, -2) : k);
    if (tid) pins[tid + (review ? '#r' : '')] = v;
  }
  const done = {};
  for (const [k, v] of Object.entries(S.done || {})) {
    const [day, a, tid] = String(k).split('|');
    if (v && taskMap.has(tid)) done[`${day}|${a}|${taskMap.get(tid)}`] = true;
  }
  return { ...S, subjects, tasks, commitments, pins, done };
}

// Prepara il contenuto per la funzione import_local_data.
// includeWeekAndSettings: true solo se l'account è ancora vuoto.
export function buildImportPayload(S, { includeWeekAndSettings, makeId } = {}) {
  const rows = stateToRows(remapIds(S, makeId));
  const arr = t => [...rows[t].values()];
  const payload = {
    subjects: arr('subjects'), tasks: arr('tasks'), commitments: arr('commitments'),
    days_off: arr('days_off'), session_pins: arr('session_pins'), session_done: arr('session_done'),
  };
  if (includeWeekAndSettings) { payload.study_slots = arr('study_slots'); payload.user_settings = rows.user_settings.get('me'); }
  return payload;
}

// I dati locali contengono qualcosa che valga la pena importare?
export function localSummary(S) {
  if (!S || typeof S !== 'object' || S.example) return null;
  const n = k => (Array.isArray(S[k]) ? S[k].length : 0);
  const slots = Object.values(S.week || {}).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0);
  const sum = { subjects: n('subjects'), tasks: n('tasks'), commitments: n('commitments'), slots, off: n('off') };
  return sum.subjects + sum.tasks + sum.commitments + sum.slots + sum.off ? sum : null;
}

export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Il server è vuoto? (nessun dato inserito dall'utente)
export function rowsAreEmpty(rows) {
  return !rows.subjects.size && !rows.tasks.size && !rows.commitments.size && !rows.study_slots.size && !rows.days_off.size;
}
