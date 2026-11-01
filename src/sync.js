// Programma Studio — sincronizzazione con Supabase.
//
// Strategia dichiarata:
// * Supabase è la fonte autorevole. In memoria si tiene "base", cioè l'ultima
//   versione di ogni riga confermata dal server.
// * Dopo ogni modifica (con un breve ritardo) si calcolano le differenze tra
//   lo stato dell'app e "base" e si mandano al server riga per riga.
// * Concorrenza ottimistica: ogni modifica o eliminazione vale solo se la
//   riga sul server ha ancora la versione che conosciamo. Se un altro
//   dispositivo l'ha cambiata (o eliminata) nel frattempo, vince il server:
//   la riga viene ricaricata e l'utente viene avvisato con il nome
//   dell'elemento, così nessuna modifica viene sovrascritta in silenzio.
// * "Salvato" compare solo quando il server ha confermato tutte le modifiche.
// * Senza rete le modifiche restano solo in memoria (non sono salvate): lo
//   stato lo dice chiaramente e si riprova con attese crescenti e appena
//   torna la connessione.
// * Realtime serve da campanello: a ogni evento, alla riconnessione e quando
//   la pagina torna visibile si rileggono i dati e si uniscono con le
//   modifiche locali non ancora salvate.

import { TABLES, TABLE_ORDER, canonical, stateToRows, rowsToState, fromServer, diff, mergeServer, rowsEqual } from './model.js';

const PAGE = 1000;
const LABEL = {
  user_settings: () => 'impostazioni',
  subjects: r => `materia «${r.name || 'senza nome'}»`,
  tasks: () => 'una verifica o un compito',
  study_slots: () => 'tempo per studiare',
  commitments: r => `impegno «${r.name || 'senza nome'}»`,
  days_off: r => `giorno senza studio ${r.day}`,
  session_pins: () => 'uno spostamento di sessione',
  session_done: () => 'una sessione segnata come fatta',
};

export class TransientError extends Error {
  constructor(kind, cause) { super(cause && cause.message || kind); this.kind = kind; this.cause = cause; }
}

export function classify(res) {
  const e = res && res.error;
  if (!e) return null;
  const s = res.status || 0, msg = String(e.message || '');
  if (!s || /failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(msg)) return 'network';
  if (s === 401 || e.code === 'PGRST301' || e.code === 'PGRST303' || /jwt/i.test(msg)) return 'auth';
  if (s >= 500 || s === 408 || s === 429) return 'retry';
  if (e.code === '23505') return 'duplicate';
  return 'fatal';
}

export class SyncEngine {
  constructor({ client, userId, defaults, getState, setState, onStatus, onNotice, onAuthLost, debounceMs = 600 }) {
    Object.assign(this, { client, userId, defaults, getState, setState, onStatus, onNotice, onAuthLost, debounceMs });
    this.base = null;
    this.wantFlush = false; this.wantPull = false; this.running = false; this.stopped = false;
    this.failCount = 0; this.retryTimer = null; this.debounceT = null; this.pullT = null;
    this.state = 'loading'; this.lastError = null; this.idleWaiters = [];
    this.channel = null;
  }

  // ---------- lettura ----------
  async fetchTable(t) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      let q = this.client.from(t).select('*').eq('user_id', this.userId);
      for (const c of (TABLES[t].pk.length ? TABLES[t].pk : ['user_id'])) q = q.order(c, { ascending: true });
      const res = await q.range(from, from + PAGE - 1);
      const kind = classify(res);
      if (kind) throw new TransientError(kind === 'fatal' || kind === 'duplicate' ? 'retry' : kind, res.error);
      out.push(...res.data);
      if (res.data.length < PAGE) return out;
    }
  }
  async fetchAll() {
    const lists = await Promise.all(TABLE_ORDER.map(t => this.fetchTable(t)));
    const o = {}; TABLE_ORDER.forEach((t, i) => { o[t] = lists[i]; });
    return fromServer(o);
  }
  virtualSettings(base) {
    if (!base.user_settings.has('me')) {
      const d = stateToRows(this.defaults()).user_settings.get('me');
      base.user_settings.set('me', { row: d, version: null, virtual: true });
    }
  }

  async load() {
    this.status('loading');
    const server = await this.fetchAll();
    this.base = server.base;
    this.virtualSettings(this.base);
    this.setState(rowsToState(server.rows, this.defaults), { reason: 'load' });
    this.status('saved');
  }

  // ---------- API per l'app ----------
  changed() {
    if (this.stopped || !this.base) return;
    clearTimeout(this.debounceT);
    if (this.getState().example) { this.status(this.state); return; }
    this.status(this.isOffline() ? 'offline' : 'pending');
    this.debounceT = setTimeout(() => { this.wantFlush = true; this.kick(); }, this.debounceMs);
  }
  hasPending() {
    if (!this.base || this.getState().example) return false;
    return this.running || diff(stateToRows(this.getState()), this.base).length > 0;
  }
  pendingCount() { return this.base && !this.getState().example ? diff(stateToRows(this.getState()), this.base).length : 0; }
  schedulePull(ms = 300) {
    if (this.stopped) return;
    clearTimeout(this.pullT);
    this.pullT = setTimeout(() => { this.wantPull = true; this.kick(); }, ms);
  }
  retryNow() { clearTimeout(this.retryTimer); this.retryTimer = null; this.wantPull = true; this.wantFlush = true; this.kick(); }
  async flushNow() { clearTimeout(this.debounceT); this.debounceT = null; this.wantFlush = true; this.kick(); return this.idle(); }
  idle() { return (this.running || this.wantFlush || this.wantPull) ? new Promise(r => this.idleWaiters.push(r)) : Promise.resolve(); }
  stop() {
    this.stopped = true;
    clearTimeout(this.debounceT); clearTimeout(this.retryTimer); clearTimeout(this.pullT);
    if (this.channel) { try { this.client.removeChannel(this.channel); } catch (e) { /* ignora */ } this.channel = null; }
    this.base = null;
    for (const r of this.idleWaiters.splice(0)) r();
  }
  isOffline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }

  status(state, extra = {}) {
    this.state = state;
    if (this.onStatus) this.onStatus({ state, pending: state === 'saved' ? 0 : this.pendingCount(), ...extra });
  }

  // ---------- ciclo di lavoro (una cosa alla volta) ----------
  kick() {
    if (this.running || this.stopped || this.retryTimer) return;
    this.running = true;
    (async () => {
      try {
        while (!this.stopped && (this.wantPull || this.wantFlush)) {
          if (this.wantPull) { this.wantPull = false; await this.pull(); }
          if (this.wantFlush) { this.wantFlush = false; this.debounceT = null; await this.flush(); }
        }
        this.failCount = 0; this.authRetries = 0;
        if (!this.stopped) {
          const left = this.pendingCount();
          if (this.debounceT) this.status('pending');
          else this.status(left ? 'pending' : 'saved');
        }
      } catch (e) {
        if (this.stopped) return;
        await this.handleFailure(e);
      } finally {
        this.running = false;
        if (!this.retryTimer && !this.stopped && (this.wantPull || this.wantFlush)) this.kick();
        else if (!this.running) for (const r of this.idleWaiters.splice(0)) r();
      }
    })();
  }

  async handleFailure(e) {
    const kind = e instanceof TransientError ? e.kind : 'retry';
    this.lastError = e;
    if (kind === 'auth') {
      const { data, error } = await this.client.auth.refreshSession().catch(err => ({ error: err }));
      this.authRetries = (this.authRetries || 0) + 1;
      if (!error && data && data.session && this.authRetries <= 2) { this.wantFlush = true; this.wantPull = true; return; }
      if (classify({ error, status: error && error.status }) !== 'network') {
        this.status('error', { message: 'Sessione scaduta' });
        if (this.onAuthLost) this.onAuthLost();
        return;
      }
    }
    this.failCount++;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(this.failCount, 5));
    this.wantFlush = true;
    this.status(kind === 'network' || this.isOffline() ? 'offline' : 'error', { retryIn: Math.round(wait / 1000), message: e.message });
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.kick(); }, wait);
  }

  async pull() {
    const server = await this.fetchAll();
    if (this.stopped) return;
    const local = stateToRows(this.getState());
    const merged = mergeServer(local, this.base, server);
    this.base = merged.base;
    this.virtualSettings(this.base);
    if (!this.getState().example && !rowsEqual(merged.rows, local)) {
      this.setState(rowsToState(merged.rows, this.defaults), { reason: 'remote' });
    }
  }

  async flush() {
    if (this.getState().example) return;
    const ops = diff(stateToRows(this.getState()), this.base);
    if (!ops.length) return;
    this.status('saving', { pending: ops.length });
    const replaced = []; // { table, key, server|null, why }
    for (const op of ops) {
      if (this.stopped) return;
      const r = await this.exec(op);
      if (r.ok) {
        if (r.server === null) this.base[op.table].delete(op.key);
        else if (r.server) this.base[op.table].set(op.key, r.server);
      } else {
        replaced.push({ table: op.table, key: op.key, op, server: r.server, why: r.why, error: r.error });
        if (r.server) this.base[op.table].set(op.key, r.server); else this.base[op.table].delete(op.key);
      }
    }
    if (replaced.length) this.applyServerVersions(replaced);
  }

  // Aggiorna lo stato locale con la versione del server per le righe in conflitto.
  applyServerVersions(list) {
    const local = stateToRows(this.getState());
    for (const x of list) {
      if (x.server) local[x.table].set(x.key, x.server.row); else local[x.table].delete(x.key);
    }
    this.setState(rowsToState(local, this.defaults), { reason: 'conflict' });
    const conflicts = list.filter(x => x.why === 'conflict'), rejected = list.filter(x => x.why === 'rejected');
    const names = xs => [...new Set(xs.map(x => LABEL[x.table](x.op.row)))].join(', ');
    if (conflicts.length && this.onNotice) {
      this.onNotice({ kind: 'conflict', text: `Nel frattempo è stato modificato su un altro dispositivo: ${names(conflicts)}. La tua ultima modifica non è stata salvata: ora vedi la versione più recente, ricontrolla e se serve rifai la modifica.` });
    }
    if (rejected.length && this.onNotice) {
      this.onNotice({ kind: 'error', text: `Il server non ha accettato una modifica (${names(rejected)}): ho rimesso il valore salvato.` });
    }
  }

  pkFilter(q, table, row) {
    q = q.eq('user_id', this.userId);
    for (const c of TABLES[table].pk) q = q.eq(c, row[c]);
    return q;
  }
  async fetchOne(table, row) {
    const res = await this.pkFilter(this.client.from(table).select('*'), table, row);
    const kind = classify(res);
    if (kind) throw new TransientError(kind === 'fatal' ? 'retry' : kind, res.error);
    const raw = res.data[0];
    return raw ? { row: canonical(table, raw), version: TABLES[table].versioned ? raw.version : null } : null;
  }
  toBase(table, raw) { return { row: canonical(table, raw), version: TABLES[table].versioned ? raw.version : null }; }

  // Esegue una singola operazione. Risultati:
  //   { ok, server }                 confermata (server: nuova base o null se eliminata)
  //   { why: 'conflict', server }    un altro dispositivo è arrivato prima
  //   { why: 'rejected', server }    rifiutata dal database (vincoli/permessi)
  // Gli errori temporanei (rete, sessione, server) lanciano TransientError.
  async exec(op) {
    const { table, row } = op, spec = TABLES[table];
    const data = { ...row };
    let res;
    if (op.op === 'insert') {
      res = await this.client.from(table).insert(data).select();
    } else if (op.op === 'update') {
      for (const c of spec.pk) delete data[c];
      res = await this.pkFilter(this.client.from(table).update(data), table, row).eq('version', op.version).select();
    } else {
      let q = this.pkFilter(this.client.from(table).delete(), table, row);
      if (spec.versioned) q = q.eq('version', op.version);
      res = await q.select();
    }
    const kind = classify(res);
    if (kind === 'network' || kind === 'auth' || kind === 'retry') throw new TransientError(kind, res.error);
    if (kind === 'duplicate') {
      const server = await this.fetchOne(table, row);
      if (!spec.versioned) return { ok: true, server };
      return { why: 'conflict', server };
    }
    if (kind === 'fatal') {
      const server = await this.fetchOne(table, row);
      return { why: 'rejected', server, error: res.error };
    }
    const got = res.data || [];
    if (op.op === 'delete') {
      if (got.length) return { ok: true, server: null };
      const server = await this.fetchOne(table, row);
      return server ? { why: 'conflict', server } : { ok: true, server: null };
    }
    if (got.length) return { ok: true, server: this.toBase(table, got[0]) };
    // update senza righe: versione cambiata o riga eliminata altrove
    const server = await this.fetchOne(table, row);
    return { why: 'conflict', server };
  }

  // ---------- Realtime ----------
  subscribe() {
    if (!this.client.channel) return;
    let lost = false;
    let ch = this.client.channel(`programma-studio-${this.userId}`);
    for (const t of TABLE_ORDER) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `user_id=eq.${this.userId}` }, () => this.schedulePull());
    }
    this.channel = ch.subscribe(status => {
      if (status === 'SUBSCRIBED') { if (lost) this.schedulePull(0); lost = false; }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') lost = true;
    });
  }
}
