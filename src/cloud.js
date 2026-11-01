// Programma Studio — account (Supabase Auth), caricamento e salvataggio dei
// dati su Supabase, importazione dei dati salvati sul dispositivo.
//
// Attivo solo se config.js contiene supabaseUrl e supabasePublishableKey.
// Altrimenti l'app funziona come prima, con i dati nel browser.

import { SyncEngine } from './sync.js';
import { remapIds, buildImportPayload, localSummary, sha256Hex, rowsAreEmpty, stateToRows } from './model.js';

const App = window.App;
const CFG = window.PROGRAMMA_STUDIO_CONFIG || {};
const MIGRATED_KEY = 'programma-studio-v1-migrated';
const SUPABASE_JS = 'vendor/supabase-js-2.118.0.umd.js';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));


// ---------------------------------------------------------------------------
let client = null, engine = null, currentUser = null, suspended = null;
let recovery = false, loggingOut = false, gateMsg = null;

function looksSecret(key) {
  if (/^sb_secret_/i.test(key)) return true;
  const parts = String(key).split('.');
  if (parts.length === 3) {
    try { return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'; } catch (e) { return false; }
  }
  return false;
}

function loadScript(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => ko(new Error('Impossibile caricare ' + src));
    document.head.appendChild(s);
  });
}

function redirectUrl() {
  return CFG.siteUrl || (location.origin + location.pathname);
}

// Legge dall'indirizzo gli esiti dei link ricevuti per email.
function readAuthUrl() {
  const h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search);
  const get = k => h.get(k) || q.get(k);
  return {
    type: get('type'), tokenHash: q.get('token_hash'),
    error: get('error_description') || get('error'), errorCode: get('error_code'),
    hasAuthParams: ['access_token', 'error', 'error_description', 'token_hash', 'type', 'code'].some(k => h.has(k) || q.has(k)),
  };
}
function cleanUrl() { try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignora */ } }

async function boot() {
  App.showGate(true);
  gate('loading', { text: 'Avvio…' });
  if (looksSecret(CFG.supabasePublishableKey)) {
    return gate('fatal', { text: 'Configurazione non sicura: in config.js c’è una chiave segreta (service role). Usa solo la chiave pubblica “publishable” (o “anon”).' });
  }
  try { await loadScript(SUPABASE_JS); }
  catch (e) { return gate('fatal', { text: 'Non riesco a caricare i componenti per l’accesso. Controlla la connessione e ricarica la pagina.', retry: true }); }

  const info = readAuthUrl();
  client = window.supabase.createClient(CFG.supabaseUrl, CFG.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
  });

  if (info.error) {
    gateMsg = { kind: 'error', text: info.errorCode === 'otp_expired'
      ? 'Il link dell’email è scaduto o è già stato usato. Chiedine uno nuovo.'
      : 'Il link non è valido: ' + info.error };
  }
  if (info.type === 'recovery') recovery = true;
  if (info.type === 'signup' && !info.error) gateMsg = { kind: 'ok', text: 'Indirizzo email confermato.' };

  client.auth.onAuthStateChange((event, session) => {
    // Le chiamate a Supabase non vanno fatte dentro questo callback.
    setTimeout(() => onAuth(event, session), 0);
  });

  if (info.tokenHash && info.type) {
    const { error } = await client.auth.verifyOtp({ token_hash: info.tokenHash, type: info.type });
    if (error) gateMsg = { kind: 'error', text: authError(error) };
    else if (info.type === 'recovery') recovery = true;
    else gateMsg = { kind: 'ok', text: 'Indirizzo email confermato.' };
  }
  if (info.hasAuthParams) cleanUrl();

  window.addEventListener('online', () => { if (engine) engine.retryNow(); });
  window.addEventListener('offline', () => { if (engine) engine.status('offline'); });
  document.addEventListener('visibilitychange', () => { if (engine && document.visibilityState === 'visible') engine.schedulePull(0); });
  setInterval(() => { if (engine && document.visibilityState === 'visible') engine.schedulePull(0); }, 60000);
  window.addEventListener('beforeunload', e => { if (engine && engine.hasPending()) { e.preventDefault(); e.returnValue = ''; } });
  $('#btn-logout').addEventListener('click', logout);
}

async function onAuth(event, session) {
  const user = session && session.user;
  if (event === 'PASSWORD_RECOVERY') { recovery = true; currentUser = user; stopEngine(); App.clear(); return gate('reset'); }
  if (event === 'INITIAL_SESSION') {
    if (!user) return gate('login');
    if (recovery) { currentUser = user; return gate('reset'); }
    return startUser(user);
  }
  if (event === 'SIGNED_IN') {
    if (recovery) { currentUser = user; return gate('reset'); }
    if (!currentUser || currentUser.id !== user.id || !engine) return startUser(user);
    return;
  }
  if (event === 'SIGNED_OUT') {
    if (loggingOut) return;
    return sessionLost();
  }
}

// ---------------------------------------------------------------------------
// Dati dell'utente
// ---------------------------------------------------------------------------
async function startUser(user) {
  if (currentUser && currentUser.id !== user.id) wipe();
  stopEngine();
  currentUser = user;
  $('#acct-email').textContent = user.email || '';
  gate('loading', { text: 'Carico i tuoi dati…' });
  const e = new SyncEngine({
    client, userId: user.id, defaults: App.emptyData,
    getState: () => App.state,
    setState: (S, o) => App.setState(S, o),
    onStatus: renderStatus, onNotice: n => notice(n.kind, n.text), onAuthLost: () => sessionLost(),
  });
  engine = e;
  try {
    await e.load();
  } catch (err) {
    if (engine !== e) return;
    engine = null;
    return gate('loaderror', { text: err && err.kind === 'network'
      ? 'Non c’è connessione: non posso caricare i tuoi dati. Riprova quando torna la rete.'
      : 'Non riesco a caricare i tuoi dati (' + esc(err && err.message || 'errore') + ').' });
  }
  if (engine !== e) return;
  // Modifiche non salvate prima che la sessione scadesse: solo se si rientra con lo stesso account.
  if (suspended && suspended.userId === user.id) {
    App.setState(suspended.state, { reason: 'load' });
    e.base = suspended.base; e.virtualSettings(e.base);
    e.status('pending');
    e.wantPull = true; e.wantFlush = true; e.kick();
  }
  suspended = null;
  App.showGate(false);
  App.startTab();
  e.subscribe();
  if (gateMsg && gateMsg.kind === 'ok') notice('ok', gateMsg.text);
  gateMsg = null;
  offerLocalImport();
}

function stopEngine() { if (engine) { engine.stop(); engine = null; } }

// Toglie dalla pagina e dalla memoria i dati dell'utente precedente.
function wipe() {
  stopEngine();
  App.clear();
  $('#notices').innerHTML = '';
  $('#acct-email').textContent = '';
  try { sessionStorage.removeItem(App.KEY + '-tab'); } catch (e) { /* ignora */ }
}

async function sessionLost() {
  if (!currentUser) return; // già uscita/o: niente da fare
  if (engine && engine.hasPending()) {
    suspended = { userId: currentUser.id, state: JSON.parse(JSON.stringify(App.state)), base: engine.base, n: engine.pendingCount() };
  }
  const n = suspended ? suspended.n : 0;
  wipe();
  currentUser = null;
  gateMsg = { kind: 'error', text: 'La sessione è scaduta: accedi di nuovo.' + (n ? ` Le modifiche non ancora salvate verranno salvate se rientri con lo stesso account.` : '') };
  gate('login');
}

async function logout() {
  if (engine && engine.hasPending()) {
    renderStatus({ state: 'saving' });
    await Promise.race([engine.flushNow(), new Promise(r => setTimeout(r, 4000))]);
    if (engine && engine.hasPending() && !confirm('Alcune modifiche non sono ancora state salvate e andranno perse. Vuoi uscire comunque?')) return;
  }
  loggingOut = true;
  suspended = null;
  wipe();
  currentUser = null;
  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
  } catch (e) {
    // Senza rete Supabase non riesce a chiudere la sessione: la togliamo comunque da questo dispositivo.
    try { localStorage.removeItem(client.auth.storageKey); } catch (x) { /* ignora */ }
  }
  loggingOut = false;
  gateMsg = { kind: 'ok', text: 'Sei uscita/o dall’account.' };
  gate('login');
}

// ---------------------------------------------------------------------------
// Stato del salvataggio e avvisi
// ---------------------------------------------------------------------------
function renderStatus(s) {
  const el = $('#sync'); if (!el) return;
  const M = {
    loading: ['Caricamento…', ''],
    saved: ['✓ Tutto salvato', 'ok'],
    pending: ['Modifiche da salvare…', 'busy'],
    saving: ['Salvataggio in corso…', 'busy'],
    offline: ['Senza connessione: le modifiche NON sono salvate', 'bad'],
    error: [`Salvataggio non riuscito${s.retryIn ? `, riprovo tra ${s.retryIn} s` : ''}`, 'bad'],
  };
  const [txt, cls] = M[s.state] || ['', ''];
  el.className = 'sync ' + cls;
  el.innerHTML = esc(txt) + (s.state === 'error' || s.state === 'offline' ? ' <button class="btn mini" id="btn-retry">Riprova ora</button>' : '');
  el.title = s.message || '';
  const b = $('#btn-retry'); if (b) b.onclick = () => engine && engine.retryNow();
  document.body.classList.toggle('unsaved', s.state === 'offline' || s.state === 'error');
}

function notice(kind, html, actions) {
  const box = document.createElement('div');
  box.className = 'notice ' + kind;
  box.innerHTML = `<span>${kind === 'local' ? html : esc(html)}</span><span class="nact">${actions || ''}<button class="x" data-close title="Chiudi">×</button></span>`;
  box.addEventListener('click', e => { if (e.target.closest('[data-close]')) box.remove(); });
  $('#notices').appendChild(box);
  return box;
}

// ---------------------------------------------------------------------------
// Importazione dei dati salvati su questo dispositivo
// ---------------------------------------------------------------------------
function readLocal() {
  let raw = null;
  try { raw = localStorage.getItem(App.KEY); } catch (e) { return null; }
  if (!raw) return null;
  let data; try { data = JSON.parse(raw); } catch (e) { return null; }
  const sum = localSummary(data);
  return sum ? { raw, data, sum } : null;
}
function migratedHash() { try { return (JSON.parse(localStorage.getItem(MIGRATED_KEY)) || {}).hash || null; } catch (e) { return null; } }

async function offerLocalImport() {
  const loc = readLocal(); if (!loc) return;
  const hash = await sha256Hex(loc.raw);
  if (migratedHash() === hash) return;
  const s = loc.sum, parts = [];
  if (s.subjects) parts.push(`${s.subjects} materi${s.subjects > 1 ? 'e' : 'a'}`);
  if (s.tasks) parts.push(`${s.tasks} verifich${s.tasks > 1 ? 'e' : 'a'} o compiti`);
  if (s.commitments) parts.push(`${s.commitments} impegn${s.commitments > 1 ? 'i' : 'o'} fiss${s.commitments > 1 ? 'i' : 'o'}`);
  if (s.slots) parts.push(`${s.slots} fasc${s.slots > 1 ? 'e' : 'ia'} di studio`);
  if (s.off) parts.push(`${s.off} giorn${s.off > 1 ? 'i' : 'o'} senza studio`);
  const box = notice('local',
    `Su questo dispositivo ci sono dati salvati prima degli account (${esc(parts.join(', '))}). Vuoi copiarli nel tuo account <b>${esc(currentUser.email)}</b>? Non vengono copiati senza la tua conferma e restano anche su questo dispositivo.`,
    `<button class="btn primary" data-imp>Importa nel mio account</button>`);
  box.id = 'import-box';
  box.querySelector('[data-imp]').addEventListener('click', async ev => {
    const b = ev.target;
    if (!b.dataset.armed) {
      const empty = engine && rowsAreEmpty(stateToRows(App.state));
      b.dataset.armed = '1';
      b.textContent = 'Confermi l’importazione?';
      box.querySelector('span').insertAdjacentHTML('beforeend', `<br><small>${empty
        ? 'Il tuo account è vuoto: verranno copiati tutti i dati, compresi orari e impostazioni.'
        : 'Il tuo account ha già dei dati: materie, verifiche, impegni e giorni senza studio verranno aggiunti; orari settimanali e impostazioni dell’account restano quelli attuali.'}</small>`);
      return;
    }
    b.disabled = true; b.textContent = 'Importazione in corso…';
    try {
      const res = await importLocal(loc, hash);
      box.remove();
      notice('ok', res === 'already_imported'
        ? 'Questi dati erano già stati importati in questo account: non li ho copiati una seconda volta.'
        : 'Importazione completata: i dati di questo dispositivo ora sono nel tuo account.');
    } catch (e) {
      b.disabled = false; delete b.dataset.armed; b.textContent = 'Riprova l’importazione';
      notice('error', 'Importazione non riuscita: ' + (e.message || 'errore') + '. Nessun dato è stato perso: i dati restano su questo dispositivo e puoi riprovare.');
    }
  });
}

async function importLocal(loc, hash) {
  if (!engine) throw new Error('non sei collegata/o');
  await engine.flushNow();
  if (engine.hasPending()) throw new Error('ci sono modifiche non ancora salvate, riprova tra poco');
  const data = JSON.parse(loc.raw);
  App.normalize(data);
  const empty = rowsAreEmpty(stateToRows(App.state));
  const payload = buildImportPayload(data, { includeWeekAndSettings: empty });
  const { data: out, error, status } = await client.rpc('import_local_data', { p_source_hash: hash, p_payload: payload });
  if (error) throw new Error(status === 0 ? 'nessuna connessione' : (error.message || 'errore del server'));
  // Verifica: rileggo dal server e controllo che ci sia tutto quello che ho mandato.
  engine.wantPull = true; engine.kick(); await engine.idle();
  if (out && out.status === 'imported') {
    const rows = stateToRows(App.state);
    const missing = ['subjects', 'tasks', 'commitments'].some(t => payload[t].some(r => !rows[t].has(r.id)));
    if (missing) throw new Error('dopo l’importazione non ritrovo tutti i dati sul server');
  }
  try { localStorage.setItem(MIGRATED_KEY, JSON.stringify({ hash, at: new Date().toISOString() })); } catch (e) { /* ignora */ }
  return out && out.status;
}

// usata dall'app per "Carica dati da file" con gli account attivi
window.Cloud = {
  changed: () => { if (engine) engine.changed(); },
  remapIds: S => remapIds(S),
};

// ---------------------------------------------------------------------------
// Schermate di accesso
// ---------------------------------------------------------------------------
const AUTH_ERR = {
  invalid_credentials: 'Email o password non corrette.',
  email_not_confirmed: 'Devi prima confermare l’indirizzo email: apri il link che ti abbiamo mandato.',
  user_already_exists: 'Esiste già un account con questa email.',
  email_exists: 'Esiste già un account con questa email.',
  weak_password: 'Password troppo debole: usa almeno 8 caratteri, con lettere e numeri.',
  same_password: 'La nuova password deve essere diversa da quella vecchia.',
  over_email_send_rate_limit: 'Troppe email inviate: aspetta qualche minuto e riprova.',
  over_request_rate_limit: 'Troppi tentativi: aspetta qualche minuto e riprova.',
  email_address_invalid: 'Indirizzo email non valido.',
  signup_disabled: 'La registrazione di nuovi account è disattivata.',
  otp_expired: 'Il link è scaduto o è già stato usato. Chiedine uno nuovo.',
  session_not_found: 'La sessione è scaduta: accedi di nuovo.',
};
function authError(e) {
  if (!e) return 'Errore sconosciuto.';
  if (e.name === 'AuthRetryableFetchError' || e.status === 0 || /fetch|network/i.test(e.message)) return 'Nessuna connessione: controlla la rete e riprova.';
  return AUTH_ERR[e.code] || ('Errore: ' + (e.message || e.code));
}

function gate(mode, o = {}) {
  App.showGate(true);
  const el = $('#gate');
  const msg = gateMsg ? `<p class="gmsg ${gateMsg.kind}" role="alert">${esc(gateMsg.text)}</p>` : '';
  const field = (id, label, type, ac, extra = '') => `<label class="f">${label}<input id="${id}" type="${type}" autocomplete="${ac}" required ${extra}></label>`;
  let h = '';
  if (mode === 'loading') h = `<div class="gcard"><p class="gload" role="status">${esc(o.text)}</p></div>`;
  else if (mode === 'fatal') h = `<div class="gcard"><h2>Qualcosa non va</h2><p class="gmsg error">${esc(o.text)}</p>${o.retry ? '<button class="btn primary" id="g-reload">Ricarica</button>' : ''}</div>`;
  else if (mode === 'loaderror') h = `<div class="gcard"><h2>Dati non caricati</h2><p class="gmsg error">${o.text}</p><div class="gact"><button class="btn primary" id="g-retry">Riprova</button><button class="btn" id="g-out">Esci</button></div></div>`;
  else if (mode === 'login') h = `<form class="gcard" id="g-form" novalidate><h2>Accedi</h2><p class="hint">Accedi per ritrovare il tuo programma su computer, tablet e telefono.</p>${msg}
      ${field('g-email', 'Email', 'email', 'email')}${field('g-pass', 'Password', 'password', 'current-password')}
      <p class="gmsg error" id="g-err" role="alert" hidden></p>
      <button class="btn primary" type="submit">Accedi</button>
      <div class="glinks"><button type="button" class="linkbtn" data-go="signup">Crea un account</button><button type="button" class="linkbtn" data-go="forgot">Password dimenticata?</button></div></form>`;
  else if (mode === 'signup') h = `<form class="gcard" id="g-form" novalidate><h2>Crea un account</h2><p class="hint">Ogni account ha il suo programma, che nessun altro può vedere.</p>
      ${field('g-email', 'Email', 'email', 'email')}${field('g-pass', 'Password (almeno 8 caratteri)', 'password', 'new-password', 'minlength="8"')}${field('g-pass2', 'Ripeti la password', 'password', 'new-password', 'minlength="8"')}
      <p class="gmsg error" id="g-err" role="alert" hidden></p>
      <button class="btn primary" type="submit">Crea account</button>
      <div class="glinks"><button type="button" class="linkbtn" data-go="login">Ho già un account</button></div></form>`;
  else if (mode === 'forgot') h = `<form class="gcard" id="g-form" novalidate><h2>Password dimenticata</h2><p class="hint">Ti mandiamo un link per sceglierne una nuova.</p>
      ${field('g-email', 'Email', 'email', 'email')}<p class="gmsg error" id="g-err" role="alert" hidden></p>
      <button class="btn primary" type="submit">Mandami il link</button>
      <div class="glinks"><button type="button" class="linkbtn" data-go="login">Torna all’accesso</button></div></form>`;
  else if (mode === 'sent') h = `<div class="gcard"><h2>Controlla la posta</h2><p>${o.text}</p><p class="hint">Non la trovi? Guarda anche nella cartella spam.</p>
      ${o.resend ? '<button class="btn" id="g-resend">Invia di nuovo l’email</button>' : ''}<p class="gmsg" id="g-err" role="alert" hidden></p>
      <div class="glinks"><button type="button" class="linkbtn" data-go="login">Torna all’accesso</button></div></div>`;
  else if (mode === 'reset') h = `<form class="gcard" id="g-form" novalidate><h2>Nuova password</h2><p class="hint">Scegli la nuova password per ${esc(currentUser && currentUser.email || 'il tuo account')}.</p>
      ${field('g-pass', 'Nuova password (almeno 8 caratteri)', 'password', 'new-password', 'minlength="8"')}${field('g-pass2', 'Ripeti la password', 'password', 'new-password', 'minlength="8"')}
      <p class="gmsg error" id="g-err" role="alert" hidden></p><button class="btn primary" type="submit">Salva la nuova password</button></form>`;
  el.innerHTML = h;
  el.dataset.mode = mode;
  if (mode !== 'loading') gateMsg = null;
  const go = el.querySelectorAll('[data-go]');
  go.forEach(b => b.addEventListener('click', () => gate(b.dataset.go)));
  const rl = $('#g-reload'); if (rl) rl.onclick = () => location.reload();
  const rt = $('#g-retry'); if (rt) rt.onclick = () => currentUser && startUser(currentUser);
  const out = $('#g-out'); if (out) out.onclick = logout;
  const rs = $('#g-resend'); if (rs) rs.onclick = async () => {
    rs.disabled = true;
    const { error } = await client.auth.resend({ type: 'signup', email: o.email, options: { emailRedirectTo: redirectUrl() } });
    showErr(error ? authError(error) : 'Email inviata di nuovo.', !error); rs.disabled = false;
  };
  const form = $('#g-form');
  if (form) {
    form.addEventListener('submit', ev => { ev.preventDefault(); submit(mode, form); });
    const first = form.querySelector('input'); if (first) first.focus();
  }
}
function showErr(text, ok) { const e = $('#g-err'); if (!e) return; e.hidden = !text; e.textContent = text || ''; e.className = 'gmsg ' + (ok ? 'ok' : 'error'); }

async function submit(mode, form) {
  const email = (form.querySelector('#g-email') || {}).value?.trim();
  const pass = (form.querySelector('#g-pass') || {}).value;
  const pass2 = (form.querySelector('#g-pass2') || {}).value;
  const btn = form.querySelector('button[type=submit]');
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return showErr('Scrivi un indirizzo email valido.');
  if ((mode === 'signup' || mode === 'reset') && (pass || '').length < 8) return showErr('La password deve avere almeno 8 caratteri.');
  if ((mode === 'signup' || mode === 'reset') && pass !== pass2) return showErr('Le due password non coincidono.');
  if (mode === 'login' && !pass) return showErr('Scrivi la password.');
  showErr('');
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'Attendi…';
  try {
    if (mode === 'login') {
      const { error } = await client.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
      gate('loading', { text: 'Carico i tuoi dati…' }); // il resto lo fa onAuthStateChange
    } else if (mode === 'signup') {
      const { data, error } = await client.auth.signUp({ email, password: pass, options: { emailRedirectTo: redirectUrl() } });
      if (error) throw error;
      if (data.session) return; // conferma email disattivata nel progetto: si entra subito
      gate('sent', { text: `Ti abbiamo mandato un’email a <b>${esc(email)}</b>. Apri il link per confermare l’indirizzo: poi potrai accedere.`, resend: true, email });
    } else if (mode === 'forgot') {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
      if (error) throw error;
      gate('sent', { text: `Se esiste un account con <b>${esc(email)}</b>, riceverai un’email con il link per scegliere una nuova password.` });
    } else if (mode === 'reset') {
      const { data, error } = await client.auth.updateUser({ password: pass });
      if (error) throw error;
      recovery = false;
      gateMsg = { kind: 'ok', text: 'Password aggiornata.' };
      await startUser(data.user || currentUser);
    }
  } catch (e) {
    showErr(authError(e));
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = label; }
  }
}

if (App && App.CLOUD) boot();
