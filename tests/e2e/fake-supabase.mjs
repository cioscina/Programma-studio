// SOLO PER I TEST. Un sostituto minimo di Supabase (Auth + REST) che gira in
// Node sopra un vero PostgreSQL con le migrazioni del progetto.
//
// Non è Supabase: implementa solo le chiamate che l'app usa, con lo stesso
// formato di richieste e risposte di GoTrue e PostgREST, abbastanza per far
// funzionare la vera libreria supabase-js nel browser. Il punto importante è
// che ogni richiesta ai dati viene eseguita nel database con il ruolo
// "authenticated" (o "anon") e il "sub" del JWT, come fa PostgREST: quindi
// la RLS e i vincoli che si provano sono quelli veri delle migrazioni.
// Realtime non è simulato.
import { createServer } from 'node:http';
import { createHmac, createHash, randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';

const TABLES = new Set(['user_settings', 'subjects', 'tasks', 'study_slots', 'commitments', 'days_off', 'session_done', 'session_pins', 'local_imports']);
const FUNCS = new Set(['import_local_data']);
const IDENT = /^[a-z_][a-z0-9_]*$/;

const b64u = b => Buffer.from(b).toString('base64url');
function signJwt(payload, secret) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}
function verifyJwt(tok, secret) {
  const [h, p, s] = String(tok).split('.');
  if (!s || createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url') !== s) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch (e) { return null; }
}
const hashPw = p => createHash('sha256').update('ps-test:' + p).digest('hex');

export async function startFakeSupabase({ databaseUrl, port = 54321, publishableKey = 'sb_publishable_test', accessTtl = 3600 }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const secret = randomBytes(32).toString('hex');
  const outbox = [];            // email "inviate"
  const tokens = new Map();     // token email -> { userId, type }
  const refresh = new Map();    // refresh token -> userId
  const ctl = { offline: false, failNext: 0, ttl: accessTtl, expired: false };

  const userJson = u => ({
    id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
    email_confirmed_at: u.email_confirmed_at, confirmed_at: u.email_confirmed_at, created_at: u.created_at, updated_at: u.created_at,
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [{ id: u.id, provider: 'email' }],
  });
  const session = u => {
    const now = Math.floor(Date.now() / 1000), rt = randomBytes(16).toString('hex');
    refresh.set(rt, u.id);
    return {
      access_token: signJwt({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, exp: now + ctl.ttl, iat: now }, secret),
      token_type: 'bearer', expires_in: ctl.ttl, expires_at: now + ctl.ttl, refresh_token: rt, user: userJson(u),
    };
  };
  const getUser = async id => (await pool.query('select * from auth.users where id = $1', [id])).rows[0];
  const getUserByEmail = async e => (await pool.query('select * from auth.users where lower(email) = lower($1)', [e])).rows[0];
  const mail = (email, type, redirect, userId) => {
    const token = randomBytes(12).toString('hex');
    tokens.set(token, { userId, type });
    outbox.push({ email, type, link: `http://localhost:${port}/auth/v1/verify?token=${token}&type=${type}&redirect_to=${encodeURIComponent(redirect)}` });
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  }
  const authErr = (res, status, code, msg) => send(res, status, { code: status, error_code: code, msg });

  function pgErr(res, e, authed) {
    const map = { '42501': authed ? 403 : 401, '23505': 409, '23503': 409, '23514': 400, '22P02': 400, '22023': 400, '42P01': 404, '42703': 400 };
    send(res, map[e.code] || 400, { code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null });
  }

  async function asRole(claims, fn) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(claims ? 'set local role authenticated' : 'set local role anon');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims || { role: 'anon' })]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; }
    finally { c.release(); }
  }

  async function rest(req, res, url, body) {
    const authz = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let claims = null;
    if (authz && authz !== publishableKey) {
      claims = verifyJwt(authz, secret);
      if (!claims) return send(res, 401, { code: 'PGRST301', message: 'JWT invalid' });
      if (ctl.expired || claims.exp < Date.now() / 1000) return send(res, 401, { code: 'PGRST303', message: 'JWT expired' });
    } else if (req.headers.apikey !== publishableKey) return send(res, 401, { message: 'Invalid API key' });

    const parts = url.pathname.split('/').filter(Boolean); // rest v1 table | rest v1 rpc fn
    try {
      if (parts[2] === 'rpc') {
        const fn = parts[3];
        if (!FUNCS.has(fn)) return send(res, 404, { code: 'PGRST202', message: 'Function not found' });
        const keys = Object.keys(body || {}).filter(k => IDENT.test(k));
        const args = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
        const vals = keys.map(k => (typeof body[k] === 'object' && body[k] !== null ? JSON.stringify(body[k]) : body[k]));
        const out = await asRole(claims, c => c.query(`select to_json(public."${fn}"(${args})) as r`, vals));
        return send(res, 200, out.rows[0].r);
      }
      const table = parts[2];
      if (!TABLES.has(table)) return send(res, 404, { code: '42P01', message: `relation "public.${table}" does not exist` });
      const where = [], vals = [];
      let order = '', limit = '', offset = '';
      for (const [k, v] of url.searchParams) {
        if (k === 'select' || k === 'columns' || k === 'on_conflict') continue;
        if (k === 'order') { order = ' order by ' + v.split(',').map(x => { const [c, d] = x.split('.'); if (!IDENT.test(c)) throw new Error('bad order'); return `"${c}" ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', '); continue; }
        if (k === 'limit') { limit = ` limit ${parseInt(v, 10)}`; continue; }
        if (k === 'offset') { offset = ` offset ${parseInt(v, 10)}`; continue; }
        if (!IDENT.test(k)) return send(res, 400, { message: 'bad column' });
        const m = v.match(/^eq\.(.*)$/s);
        if (!m) return send(res, 400, { message: 'only eq supported in fake' });
        vals.push(m[1]); where.push(`"${k}" = $${vals.length}`);
      }
      const W = where.length ? ' where ' + where.join(' and ') : '';
      const wrap = inner => `with r as (${inner}) select coalesce(json_agg(r), '[]'::json) as j from r`;
      let sql, status = 200;
      if (req.method === 'GET') sql = `select coalesce(json_agg(r), '[]'::json) as j from (select * from public."${table}"${W}${order}${limit}${offset}) r`;
      else if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const cols = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => IDENT.test(k));
        vals.push(JSON.stringify(rows));
        const cl = cols.map(c => `"${c}"`).join(', ');
        sql = wrap(`insert into public."${table}" (${cl}) select ${cl} from json_populate_recordset(null::public."${table}", $${vals.length}::json) returning *`);
        status = 201;
      } else if (req.method === 'PATCH') {
        const cols = Object.keys(body || {}).filter(k => IDENT.test(k));
        vals.push(JSON.stringify(body));
        sql = wrap(`update public."${table}" t set ${cols.map(c => `"${c}" = x."${c}"`).join(', ')} from json_populate_record(null::public."${table}", $${vals.length}::json) x${W.replace(/"(\w+)" =/g, 't."$1" =')} returning t.*`);
      } else if (req.method === 'DELETE') sql = wrap(`delete from public."${table}"${W} returning *`);
      else return send(res, 405, { message: 'method' });
      const out = await asRole(claims, c => c.query(sql, vals));
      return send(res, status, out.rows[0].j, { 'content-range': '*/*' });
    } catch (e) { return pgErr(res, e, !!claims); }
  }

  async function auth(req, res, url, body) {
    const path = url.pathname.replace('/auth/v1', '');
    const redirect = url.searchParams.get('redirect_to') || 'http://localhost/';
    const bearerUser = () => { const c = verifyJwt((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), secret); return c && c.exp > Date.now() / 1000 ? c.sub : null; };
    if (path === '/signup' && req.method === 'POST') {
      if (!body.email || !body.password) return authErr(res, 400, 'validation_failed', 'missing');
      if (body.password.length < 6) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'weak', weak_password: { reasons: ['length'] } });
      const ex = await getUserByEmail(body.email);
      if (ex) { // come Supabase con la conferma email attiva: nessun errore, nessuna sessione
        return send(res, 200, { ...userJson(ex), identities: [] });
      }
      const u = (await pool.query(`insert into auth.users (email, encrypted_password) values ($1, $2) returning *`, [body.email.toLowerCase(), hashPw(body.password)])).rows[0];
      mail(u.email, 'signup', redirect, u.id);
      return send(res, 200, userJson(u));
    }
    if (path === '/verify' && req.method === 'GET') {
      const t = tokens.get(url.searchParams.get('token'));
      const to = url.searchParams.get('redirect_to') || 'http://localhost/';
      if (!t) { res.writeHead(303, { location: `${to}#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired` }); return res.end(); }
      tokens.delete(url.searchParams.get('token'));
      await pool.query('update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1', [t.userId]);
      const s = session(await getUser(t.userId));
      const h = new URLSearchParams({ access_token: s.access_token, expires_at: s.expires_at, expires_in: s.expires_in, refresh_token: s.refresh_token, token_type: 'bearer', type: t.type });
      res.writeHead(303, { location: `${to}#${h}` }); return res.end();
    }
    if (path === '/token' && req.method === 'POST') {
      const gt = url.searchParams.get('grant_type');
      if (gt === 'password') {
        const u = await getUserByEmail(body.email || '');
        if (!u || u.encrypted_password !== hashPw(body.password || '')) return authErr(res, 400, 'invalid_credentials', 'Invalid login credentials');
        if (!u.email_confirmed_at) return authErr(res, 400, 'email_not_confirmed', 'Email not confirmed');
        return send(res, 200, session(u));
      }
      if (gt === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        if (!id || ctl.expired) return authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token');
        refresh.delete(body.refresh_token);
        return send(res, 200, session(await getUser(id)));
      }
      return authErr(res, 400, 'unsupported_grant_type', 'unsupported');
    }
    if (path === '/user' && req.method === 'GET') {
      const id = bearerUser(); if (!id) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
      return send(res, 200, userJson(await getUser(id)));
    }
    if (path === '/user' && req.method === 'PUT') {
      const id = bearerUser(); if (!id) return authErr(res, 401, 'bad_jwt', 'invalid JWT');
      const u = await getUser(id);
      if (body.password) {
        if (u.encrypted_password === hashPw(body.password)) return authErr(res, 422, 'same_password', 'same');
        await pool.query('update auth.users set encrypted_password = $2 where id = $1', [id, hashPw(body.password)]);
      }
      return send(res, 200, userJson(await getUser(id)));
    }
    if (path === '/logout' && req.method === 'POST') {
      const id = bearerUser();
      for (const [k, v] of refresh) if (v === id) refresh.delete(k);
      res.writeHead(204); return res.end();
    }
    if (path === '/recover' && req.method === 'POST') {
      const u = await getUserByEmail(body.email || '');
      if (u) mail(u.email, 'recovery', redirect, u.id);
      return send(res, 200, {});
    }
    if (path === '/resend' && req.method === 'POST') {
      const u = await getUserByEmail(body.email || '');
      if (u && !u.email_confirmed_at) mail(u.email, 'signup', body.options?.email_redirect_to || redirect, u.id);
      return send(res, 200, {});
    }
    return send(res, 404, { msg: 'not found in fake' });
  }

  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', req.headers.origin || '*');
    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] || '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-expose-headers', 'content-range');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/__test/outbox') return send(res, 200, outbox.filter(m => !url.searchParams.get('email') || m.email === url.searchParams.get('email')));
    if (ctl.offline && !url.pathname.startsWith('/__test')) { req.socket.destroy(); return; }
    if (ctl.failNext > 0 && url.pathname.startsWith('/rest/')) { ctl.failNext--; return send(res, 503, { message: 'temporaneamente non disponibile' }); }
    let raw = '';
    for await (const ch of req) raw += ch;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return send(res, 400, { message: 'bad json' }); }
    try {
      if (url.pathname.startsWith('/rest/v1/')) return await rest(req, res, url, body);
      if (url.pathname.startsWith('/auth/v1/')) return await auth(req, res, url, body);
      return send(res, 404, { message: 'not found' });
    } catch (e) { return send(res, 500, { message: e.message }); }
  });
  server.on('upgrade', (req, socket) => socket.destroy()); // niente Realtime
  await new Promise(ok => server.listen(port, ok));
  return {
    url: `http://localhost:${port}`, publishableKey, outbox, ctl, pool,
    lastLink(email, type) { const m = outbox.filter(x => x.email === email && (!type || x.type === type)).pop(); return m && m.link; },
    // crea direttamente un utente già confermato
    async createConfirmedUser(email, password) {
      const u = (await pool.query(`insert into auth.users (email, encrypted_password, email_confirmed_at) values ($1, $2, now()) returning *`, [email, hashPw(password)])).rows[0];
      return u;
    },
    // token valido per chiamare le API "a mano", come farebbe un client esterno
    tokenFor(u) { return session(u).access_token; },
    async close() { await new Promise(ok => server.close(ok)); await pool.end(); },
  };
}
export { randomUUID };
