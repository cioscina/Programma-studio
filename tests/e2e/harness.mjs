// Avvia per i test: database temporaneo con le migrazioni, finto Supabase
// (fake-supabase.mjs), l'app servita in locale con un config.js che punta lì
// e Chromium (Playwright).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setupDatabase } from '../db/helpers.mjs';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startServer } from '../../scripts/serve.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function loadPlaywright() {
  try { return await import('playwright'); } catch (e) { return createRequire(import.meta.url)('playwright'); }
}

export async function startHarness({ appPort = 3100, sbPort = 54321 } = {}) {
  const db = await setupDatabase();
  const sb = await startFakeSupabase({ databaseUrl: db.url, port: sbPort });
  const appUrl = `http://localhost:${appPort}/`;
  const config = `window.PROGRAMMA_STUDIO_CONFIG = ${JSON.stringify({ supabaseUrl: sb.url, supabasePublishableKey: sb.publishableKey, siteUrl: appUrl })};`;
  const web = await startServer({ dir: root, listen: appPort, overrides: { '/config.js': config } });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  return {
    db, sb, appUrl, browser,
    // un "dispositivo": contesto del browser separato (storage separato)
    async device() {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', e => page.errors.push(e.message));
      return { ctx, page };
    },
    async close() { await browser.close(); await new Promise(ok => web.close(ok)); await sb.close(); await db.teardown(); },
  };
}

// --- azioni ricorrenti nell'interfaccia ---
export async function login(page, appUrl, email, password) {
  await page.goto(appUrl);
  await page.waitForSelector('#gate[data-mode="login"]');
  await page.fill('#g-email', email);
  await page.fill('#g-pass', password);
  await page.click('#g-form button[type=submit]');
  await page.waitForSelector('#acct:not([hidden])');
}
export async function waitSaved(page) {
  await page.waitForFunction(() => document.querySelector('#sync')?.textContent.includes('Tutto salvato'), null, { timeout: 15000 });
}
export async function addSubject(page, name) {
  await page.click('#tab-dati');
  await page.click('#add-subj');
  const input = page.locator('.subj input[type=text]').last();
  await input.fill(name);
}
export const subjectNames = page => page.$$eval('.subj input[type=text]', els => els.map(e => e.value));
