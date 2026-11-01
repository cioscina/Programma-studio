// Genera config.js a partire da .env (o dalle variabili d'ambiente).
// Uso: npm run config
// Rifiuta le chiavi segrete: nel frontend va solo la chiave pubblica.
import { readFile, writeFile } from 'node:fs/promises';

const env = { ...process.env };
try {
  for (const line of (await readFile('.env', 'utf8')).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch (e) { /* nessun .env: si usano solo le variabili d'ambiente */ }

const url = env.SUPABASE_URL || '', key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '', site = env.SITE_URL || '';
function isSecret(k) {
  if (/^sb_secret_/i.test(k)) return true;
  const p = k.split('.');
  if (p.length === 3) { try { return JSON.parse(Buffer.from(p[1], 'base64url').toString()).role === 'service_role'; } catch (e) { return false; } }
  return false;
}
if (isSecret(key)) { console.error('ERRORE: è una chiave segreta (secret/service_role). Usa la Publishable key o la anon key.'); process.exit(1); }
if (url && !/^https?:\/\/[^/]+/.test(url)) { console.error('ERRORE: SUPABASE_URL non sembra un indirizzo valido.'); process.exit(1); }
if (!url || !key) console.warn('Attenzione: SUPABASE_URL o SUPABASE_PUBLISHABLE_KEY vuoti: l’app resterà senza account (dati solo nel browser).');

const out = `// Generato da scripts/write-config.mjs (npm run config). Vedi SUPABASE.md.
// Contiene solo valori pubblici: la sicurezza dei dati è garantita dalle policy RLS.
window.PROGRAMMA_STUDIO_CONFIG = ${JSON.stringify({ supabaseUrl: url.replace(/\/+$/, ''), supabasePublishableKey: key, siteUrl: site }, null, 2)};
`;
await writeFile('config.js', out);
console.log('config.js aggiornato' + (url ? ` per ${url}` : ''));
