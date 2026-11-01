// Senza configurazione Supabase l'app deve funzionare esattamente come prima:
// niente schermata di accesso, dati nel browser, nessuna richiesta a Supabase.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer } from '../../scripts/serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let web, browser;
const URL0 = 'http://localhost:3104/';
before(async () => {
  web = await startServer({ dir: root, listen: 3104, overrides: { '/config.js': 'window.PROGRAMMA_STUDIO_CONFIG = { supabaseUrl: "", supabasePublishableKey: "" };' } });
  let pw; try { pw = await import('playwright'); } catch (e) { pw = createRequire(import.meta.url)('playwright'); }
  browser = await pw.chromium.launch();
});
after(async () => { await browser.close(); await new Promise(ok => web.close(ok)); });

test('modalità locale: come prima, con i dati nel browser', async () => {
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  const errors = [], requests = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('request', r => requests.push(r.url()));
  await p.goto(URL0);
  assert.equal(await p.isVisible('#gate'), false);
  assert.equal(await p.isVisible('#acct'), false);
  await p.click('#btn-example');
  await p.click('#tab-piano');
  assert.match(await p.textContent('#planmsg'), /sessioni in \d+ giorni/);
  await p.click('#tab-dati');
  await p.click('#add-subj');
  await p.locator('.subj input[type=text]').last().fill('Musica');
  // orario di un impegno: deve restare un orario (prima diventava NaN)
  const t = p.locator('.commit input[type=time]').first();
  await t.fill('18:15');
  await p.waitForTimeout(500);
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('programma-studio-v1')));
  assert.ok(saved.subjects.some(s => s.name === 'Musica'));
  assert.equal(saved.commitments[0].from, '18:15');
  await p.reload();
  await p.click('#tab-dati');
  const names = await p.$$eval('.subj input[type=text]', els => els.map(e => e.value));
  assert.ok(names.includes('Musica'), 'ritrovata dopo il ricaricamento');
  assert.ok(!requests.some(u => /supabase/.test(u)), 'nessun caricamento di Supabase in modalità locale');
  assert.deepEqual(errors, []);
  await ctx.close();
});
