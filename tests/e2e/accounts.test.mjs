// Prove nel browser con la vera libreria supabase-js, contro il finto
// Supabase su PostgreSQL reale (vedi fake-supabase.mjs).
// Esecuzione: npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, login, waitSaved, addSubject, subjectNames } from './harness.mjs';

let H;
before(async () => { H = await startHarness(); });
after(async () => { await H.close(); });

const PW = 'password-sicura-1';

test('registrazione con conferma email, ambiente vuoto, dati ritrovati su un secondo dispositivo', async () => {
  const email = 'anna@test.local';
  const d1 = await H.device();
  const p = d1.page;
  await p.goto(H.appUrl);
  await p.waitForSelector('#gate[data-mode="login"]');
  assert.equal(await p.isVisible('#view-dati'), false, 'senza accesso i dati non si vedono');
  await p.click('[data-go="signup"]');
  await p.fill('#g-email', email); await p.fill('#g-pass', PW); await p.fill('#g-pass2', PW);
  await p.click('#g-form button[type=submit]');
  await p.waitForSelector('#gate[data-mode="sent"]');

  // prima della conferma non si entra
  await p.click('[data-go="login"]');
  await p.fill('#g-email', email); await p.fill('#g-pass', PW);
  await p.click('#g-form button[type=submit]');
  await p.waitForSelector('#g-err:not([hidden])');
  assert.match(await p.textContent('#g-err'), /confermare/);

  // link dell'email
  const link = H.sb.lastLink(email, 'signup');
  assert.ok(link, 'email di conferma inviata');
  await p.goto(link);
  await p.waitForSelector('#acct:not([hidden])');
  assert.match(await p.textContent('#notices'), /confermato/);
  assert.equal(new URL(p.url()).hash, '', 'token tolti dall’indirizzo');

  // ambiente vuoto
  await p.click('#tab-dati');
  assert.deepEqual(await subjectNames(p), []);
  assert.match(await p.textContent('#editor'), /Il piano è vuoto/);

  // crea e modifica
  await addSubject(p, 'Matematica');
  await waitSaved(p);
  await addSubject(p, 'Storia');
  await p.click('#add-task');
  await p.locator('.task input[type=date]').first().fill('2026-11-20');
  await p.locator('.task input[aria-label="Da pagina"]').first().fill('1');
  await p.locator('.task input[aria-label="A pagina"]').first().fill('12');
  await p.click('#add-w-1');
  await p.fill('#set-sess', '35');
  await waitSaved(p);
  await p.locator('.subj input[type=text]').first().fill('Matematica e geometria');
  await waitSaved(p);

  // secondo dispositivo
  const d2 = await H.device();
  await login(d2.page, H.appUrl, email, PW);
  await d2.page.click('#tab-dati');
  assert.deepEqual(await subjectNames(d2.page), ['Matematica e geometria', 'Storia']);
  assert.equal(await d2.page.inputValue('#set-sess'), '35');
  assert.equal(await d2.page.locator('.task input[aria-label="A pagina"]').first().inputValue(), '12');
  assert.equal(await d2.page.locator('.wday').first().locator('input[type=time]').count(), 2, 'fascia del lunedì');

  // modifica dal secondo dispositivo, il primo la vede dopo aver riletto i dati
  await d2.page.locator('.subj input[type=text]').nth(1).fill('Storia moderna');
  await waitSaved(d2.page);
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForFunction(() => [...document.querySelectorAll('.subj input[type=text]')].some(e => e.value === 'Storia moderna'));

  assert.deepEqual(p.errors, []); assert.deepEqual(d2.page.errors, []);
  await d1.ctx.close(); await d2.ctx.close();
});

test('un secondo utente ha un ambiente distinto e non accede ai dati del primo nemmeno via API', async () => {
  const a = await H.sb.createConfirmedUser('a2@test.local', PW);
  const b = await H.sb.createConfirmedUser('b2@test.local', PW);
  const dA = await H.device();
  await login(dA.page, H.appUrl, 'a2@test.local', PW);
  await addSubject(dA.page, 'Segreta di A');
  await waitSaved(dA.page);

  const dB = await H.device();
  await login(dB.page, H.appUrl, 'b2@test.local', PW);
  await dB.page.click('#tab-dati');
  assert.deepEqual(await subjectNames(dB.page), []);

  // chiamate dirette alle API REST con il token di B
  const tok = H.sb.tokenFor(b);
  const hdr = { apikey: H.sb.publishableKey, authorization: `Bearer ${tok}`, 'content-type': 'application/json', prefer: 'return=representation' };
  const subjA = (await H.sb.pool.query('select id from subjects where user_id = $1', [a.id])).rows[0].id;
  let r = await fetch(`${H.sb.url}/rest/v1/subjects?select=*`, { headers: hdr });
  assert.deepEqual(await r.json(), []);
  r = await fetch(`${H.sb.url}/rest/v1/subjects?id=eq.${subjA}&select=*`, { method: 'PATCH', headers: hdr, body: JSON.stringify({ name: 'rubata' }) });
  assert.deepEqual(await r.json(), [], 'nessuna riga modificata');
  r = await fetch(`${H.sb.url}/rest/v1/subjects?id=eq.${subjA}&select=*`, { method: 'DELETE', headers: hdr });
  assert.deepEqual(await r.json(), [], 'nessuna riga eliminata');
  r = await fetch(`${H.sb.url}/rest/v1/subjects?select=*`, { method: 'POST', headers: hdr, body: JSON.stringify({ user_id: a.id, name: 'intrusa' }) });
  assert.equal(r.status, 403, 'non può inserire a nome di A');
  r = await fetch(`${H.sb.url}/rest/v1/tasks?select=*`, { method: 'POST', headers: hdr, body: JSON.stringify({ subject_id: subjA }) });
  assert.equal(r.status, 409, 'non può collegarsi alla materia di A');
  // senza token (solo chiave pubblica)
  r = await fetch(`${H.sb.url}/rest/v1/subjects?select=*`, { headers: { apikey: H.sb.publishableKey, authorization: `Bearer ${H.sb.publishableKey}` } });
  assert.equal(r.status, 401);
  const still = (await H.sb.pool.query('select name from subjects where id = $1', [subjA])).rows[0].name;
  assert.equal(still, 'Segreta di A');
  await dA.ctx.close(); await dB.ctx.close();
});

test('logout e cambio account non lasciano dati del precedente', async () => {
  await H.sb.createConfirmedUser('c3@test.local', PW);
  await H.sb.createConfirmedUser('d3@test.local', PW);
  const d = await H.device(); const p = d.page;
  await login(p, H.appUrl, 'c3@test.local', PW);
  await addSubject(p, 'Materia di C');
  await waitSaved(p);
  await p.click('#btn-logout');
  await p.waitForSelector('#gate[data-mode="login"]');
  const html = await p.content();
  assert.ok(!html.includes('Materia di C'), 'niente dati di C nella pagina');
  const ls = await p.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!ls.includes('Materia di C'), 'niente dati di C nel browser');
  assert.ok(!/sb-.*-auth-token/.test(ls), 'sessione rimossa');
  await p.fill('#g-email', 'd3@test.local'); await p.fill('#g-pass', PW);
  await p.click('#g-form button[type=submit]');
  await p.waitForSelector('#acct:not([hidden])');
  await p.click('#tab-dati');
  assert.deepEqual(await subjectNames(p), []);
  assert.equal(await p.textContent('#acct-email'), 'd3@test.local');
  await d.ctx.close();
});

test('recupero e reimpostazione della password', async () => {
  await H.sb.createConfirmedUser('e4@test.local', 'vecchia-password-1');
  const d = await H.device(); const p = d.page;
  await p.goto(H.appUrl);
  await p.waitForSelector('#gate[data-mode="login"]');
  await p.click('[data-go="forgot"]');
  await p.fill('#g-email', 'e4@test.local');
  await p.click('#g-form button[type=submit]');
  await p.waitForSelector('#gate[data-mode="sent"]');
  const link = H.sb.lastLink('e4@test.local', 'recovery');
  await p.goto(link);
  await p.waitForSelector('#gate[data-mode="reset"]');
  assert.equal(await p.isVisible('#view-dati'), false, 'prima della nuova password i dati non si vedono');
  await p.fill('#g-pass', 'nuova-password-2'); await p.fill('#g-pass2', 'nuova-password-3');
  await p.click('#g-form button[type=submit]');
  assert.match(await p.textContent('#g-err'), /non coincidono/);
  await p.fill('#g-pass2', 'nuova-password-2');
  await p.click('#g-form button[type=submit]');
  await p.waitForSelector('#acct:not([hidden])');
  // link già usato -> errore chiaro
  const d2 = await H.device();
  await d2.page.goto(link);
  await d2.page.waitForSelector('#gate[data-mode="login"]');
  assert.match(await d2.page.textContent('#gate'), /scaduto o è già stato usato/);
  // accesso con la nuova password
  await d2.page.fill('#g-email', 'e4@test.local'); await d2.page.fill('#g-pass', 'vecchia-password-1');
  await d2.page.click('#g-form button[type=submit]');
  await d2.page.waitForSelector('#g-err:not([hidden])');
  assert.match(await d2.page.textContent('#g-err'), /non corrette/);
  await d2.page.fill('#g-pass', 'nuova-password-2');
  await d2.page.click('#g-form button[type=submit]');
  await d2.page.waitForSelector('#acct:not([hidden])');
  await d.ctx.close(); await d2.ctx.close();
});
