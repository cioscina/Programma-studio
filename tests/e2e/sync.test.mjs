// Salvataggio, rete assente, conflitti tra dispositivi, sessione scaduta e
// importazione dei dati locali, nel browser con supabase-js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, login, waitSaved, addSubject, subjectNames } from './harness.mjs';

let H;
before(async () => { H = await startHarness({ appPort: 3102, sbPort: 54322 }); });
after(async () => { await H.close(); });

const PW = 'password-sicura-1';
const dbNames = async email => (await H.sb.pool.query(
  'select s.name from subjects s join auth.users u on u.id = s.user_id where u.email = $1 order by s.position', [email])).rows.map(r => r.name);
const syncText = p => p.textContent('#sync');

test('senza rete: le modifiche non risultano salvate finché il server non le conferma', async () => {
  await H.sb.createConfirmedUser('off@test.local', PW);
  const d = await H.device(); const p = d.page;
  await login(p, H.appUrl, 'off@test.local', PW);
  await addSubject(p, 'Prima');
  await waitSaved(p);

  await d.ctx.setOffline(true); H.sb.ctl.offline = true;
  await p.locator('.subj input[type=text]').first().fill('Modificata offline');
  await p.waitForFunction(() => /NON sono salvate/.test(document.querySelector('#sync').textContent), null, { timeout: 10000 });
  assert.ok(!(await syncText(p)).includes('Tutto salvato'));
  assert.deepEqual(await dbNames('off@test.local'), ['Prima'], 'il server non ha la modifica');
  await p.waitForTimeout(1500);
  assert.ok(!(await syncText(p)).includes('Tutto salvato'));

  H.sb.ctl.offline = false; await d.ctx.setOffline(false);
  await waitSaved(p);
  assert.deepEqual(await dbNames('off@test.local'), ['Modificata offline']);
  await d.ctx.close();
});

test('errore temporaneo del server: nuovo tentativo e poi salvato', async () => {
  await H.sb.createConfirmedUser('err@test.local', PW);
  const d = await H.device(); const p = d.page;
  await login(p, H.appUrl, 'err@test.local', PW);
  H.sb.ctl.failNext = 1;
  await addSubject(p, 'Dopo un errore');
  await p.waitForFunction(() => /non riuscito/.test(document.querySelector('#sync').textContent), null, { timeout: 10000 });
  await waitSaved(p);
  assert.deepEqual(await dbNames('err@test.local'), ['Dopo un errore']);
  await d.ctx.close();
});

test('modifiche concorrenti: nessuna sovrascrittura silenziosa', async () => {
  await H.sb.createConfirmedUser('conc@test.local', PW);
  const d1 = await H.device(), d2 = await H.device();
  await login(d1.page, H.appUrl, 'conc@test.local', PW);
  await addSubject(d1.page, 'Inglese');
  await addSubject(d1.page, 'Arte');
  await waitSaved(d1.page);
  await login(d2.page, H.appUrl, 'conc@test.local', PW);
  await d2.page.click('#tab-dati');

  // dispositivo 2 rinomina Inglese e salva; dispositivo 1 (che non ha ancora riletto) rinomina la stessa materia
  await d2.page.locator('.subj input[type=text]').first().fill('Inglese (tablet)');
  await waitSaved(d2.page);
  await d1.page.locator('.subj input[type=text]').first().fill('Inglese (pc)');
  await d1.page.waitForSelector('.notice.conflict');
  assert.match(await d1.page.textContent('.notice.conflict'), /materia «Inglese \(pc\)»|altro dispositivo/);
  await waitSaved(d1.page);
  assert.equal((await subjectNames(d1.page))[0], 'Inglese (tablet)', 'il pc ora mostra la versione salvata');
  assert.deepEqual(await dbNames('conc@test.local'), ['Inglese (tablet)', 'Arte']);

  // modifiche a elementi diversi: si salvano entrambe
  await d2.page.locator('.subj input[type=text]').nth(1).fill('Arte e immagine');
  await waitSaved(d2.page);
  await d1.page.click('#add-subj');
  await d1.page.locator('.subj input[type=text]').last().fill('Musica');
  await waitSaved(d1.page);
  assert.deepEqual(await dbNames('conc@test.local'), ['Inglese (tablet)', 'Arte e immagine', 'Musica']);
  await d1.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await d1.page.waitForFunction(() => [...document.querySelectorAll('.subj input[type=text]')].some(e => e.value === 'Arte e immagine'));

  // eliminazione su un dispositivo mentre l'altro modifica
  await d2.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await d2.page.waitForFunction(() => document.querySelectorAll('.subj input[type=text]').length === 3);
  await d1.page.locator('.subj .x').last().click();
  await waitSaved(d1.page);
  await d2.page.locator('.subj input[type=text]').last().fill('Musica classica');
  await d2.page.waitForSelector('.notice.conflict');
  await waitSaved(d2.page);
  assert.deepEqual(await subjectNames(d2.page), ['Inglese (tablet)', 'Arte e immagine']);
  assert.deepEqual(await dbNames('conc@test.local'), ['Inglese (tablet)', 'Arte e immagine']);
  await d1.ctx.close(); await d2.ctx.close();
});

test('sessione scaduta: torna l’accesso, i dati spariscono dalla pagina, le modifiche non salvate si recuperano con lo stesso account', async () => {
  await H.sb.createConfirmedUser('exp@test.local', PW);
  const d = await H.device(); const p = d.page;
  await login(p, H.appUrl, 'exp@test.local', PW);
  await addSubject(p, 'Salvata');
  await waitSaved(p);
  H.sb.ctl.expired = true;
  await p.locator('.subj input[type=text]').first().fill('Non ancora salvata');
  await p.waitForSelector('#gate[data-mode="login"]', { timeout: 20000 });
  assert.match(await p.textContent('#gate'), /sessione è scaduta/);
  assert.ok(!(await p.content()).includes('Non ancora salvata'));
  H.sb.ctl.expired = false;
  await p.fill('#g-email', 'exp@test.local'); await p.fill('#g-pass', PW);
  await p.click('#g-form button[type=submit]');
  await p.waitForSelector('#acct:not([hidden])');
  await waitSaved(p);
  assert.deepEqual(await dbNames('exp@test.local'), ['Non ancora salvata']);
  await d.ctx.close();
});

const LEGACY = {
  example: false, start: '2026-11-02', sess: 45, pausa: 15, maxPerDay: 4, buffer: 15, subtitle: 'Il mio piano', goal: 'studiare bene',
  subjects: [{ id: 's0', name: 'Latino', color: '#d9c6f5' }, { id: 'ab12cd3', name: 'Scienze', color: '#8fe0e3' }],
  tasks: [{ id: 't1', subj: 's0', kind: 'consegna', date: '2026-11-03', mode: 'sessioni', sessions: 2, note: 'Versione', from: 1, to: 1, pps: 2, ripasso: false },
    { id: 'zz9', subj: 'ab12cd3', kind: 'verifica', date: '2026-11-13', mode: 'pagine', ranges: [[1, 18]], extras: ['Appunti su Classroom'], sessions: 1, note: '', ripasso: true }],
  week: { 0: [], 1: [['16:00', '18:30']], 2: [], 3: [['15:30', '18:30']], 4: [], 5: [], 6: [] },
  commitments: [{ id: 'c1', name: 'Danza', days: [1], from: '19:00', to: '21:00', relax: true, color: '#f7b6d2' }],
  off: ['2026-11-07'], done: { '2026-11-02|960|t1': true }, pins: {},
};

test('dati locali: importazione solo su conferma, senza doppioni, dati locali conservati e marcati', async () => {
  await H.sb.createConfirmedUser('imp@test.local', PW);
  await H.sb.createConfirmedUser('altro@test.local', PW);
  const d = await H.device(); const p = d.page;
  await p.goto(H.appUrl);
  await p.evaluate(v => localStorage.setItem('programma-studio-v1', v), JSON.stringify(LEGACY));
  await login(p, H.appUrl, 'imp@test.local', PW);
  await p.waitForSelector('#import-box');
  assert.match(await p.textContent('#import-box'), /2 materie, 2 verifiche o compiti, 1 impegno fisso, 2 fasce di studio, 1 giorno senza studio/);
  await p.waitForTimeout(1000);
  assert.deepEqual(await dbNames('imp@test.local'), [], 'niente importato senza conferma');

  await p.click('#import-box [data-imp]');           // primo clic: chiede conferma
  assert.match(await p.textContent('#import-box'), /account è vuoto/);
  await p.click('#import-box [data-imp]');           // conferma
  await p.waitForSelector('.notice.ok >> text=Importazione completata');
  assert.deepEqual(await dbNames('imp@test.local'), ['Latino', 'Scienze']);
  const tasks = (await H.sb.pool.query(`select t.note, t.sessions, t.extras, s.name from tasks t join subjects s on s.id = t.subject_id join auth.users u on u.id = t.user_id where u.email = 'imp@test.local' order by t.position`)).rows;
  assert.deepEqual(tasks.map(t => [t.name, t.note]), [['Latino', 'Versione'], ['Scienze', '']]);
  assert.deepEqual(tasks[1].extras, ['Appunti su Classroom']);
  const done = (await H.sb.pool.query(`select count(*)::int n from session_done d join auth.users u on u.id = d.user_id where u.email = 'imp@test.local'`)).rows[0].n;
  assert.equal(done, 1);
  const set = (await H.sb.pool.query(`select s.session_minutes from user_settings s join auth.users u on u.id = s.user_id where u.email = 'imp@test.local'`)).rows[0];
  assert.equal(set.session_minutes, 45);
  await p.click('#tab-dati');
  assert.deepEqual(await subjectNames(p), ['Latino', 'Scienze']);
  assert.equal(await p.inputValue('#set-sess'), '45');

  const ls = await p.evaluate(() => ({ data: localStorage.getItem('programma-studio-v1'), mark: localStorage.getItem('programma-studio-v1-migrated') }));
  assert.equal(ls.data, JSON.stringify(LEGACY), 'dati locali non cancellati né modificati');
  assert.match(JSON.parse(ls.mark).hash, /^[0-9a-f]{64}$/);

  // ricaricando non viene più proposto
  await p.reload(); await p.waitForSelector('#acct:not([hidden])'); await p.waitForTimeout(800);
  assert.equal(await p.locator('#import-box').count(), 0);

  // anche se il segno "migrato" si perde, una seconda importazione non duplica
  await p.evaluate(() => localStorage.removeItem('programma-studio-v1-migrated'));
  await p.reload(); await p.waitForSelector('#import-box');
  await p.click('#import-box [data-imp]'); await p.click('#import-box [data-imp]');
  await p.waitForSelector('.notice.ok >> text=già stati importati');
  assert.deepEqual(await dbNames('imp@test.local'), ['Latino', 'Scienze']);

  // un altro account sullo stesso dispositivo non riceve i dati in automatico
  await p.click('#btn-logout'); await p.waitForSelector('#gate[data-mode="login"]');
  await p.fill('#g-email', 'altro@test.local'); await p.fill('#g-pass', PW);
  await p.click('#g-form button[type=submit]'); await p.waitForSelector('#acct:not([hidden])');
  await p.waitForTimeout(800);
  assert.equal(await p.locator('#import-box').count(), 0, 'già importati: non proposti ad altri');
  assert.deepEqual(await dbNames('altro@test.local'), []);
  await d.ctx.close();
});

test('dati locali in un account che ha già dati: proposta, nessuna importazione automatica', async () => {
  await H.sb.createConfirmedUser('pieno@test.local', PW);
  const d = await H.device(); const p = d.page;
  await login(p, H.appUrl, 'pieno@test.local', PW);
  await addSubject(p, 'Già presente');
  await waitSaved(p);
  await p.evaluate(v => localStorage.setItem('programma-studio-v1', v), JSON.stringify({ ...LEGACY, subtitle: 'altro' }));
  await p.reload(); await p.waitForSelector('#import-box');
  await p.waitForTimeout(800);
  assert.deepEqual(await dbNames('pieno@test.local'), ['Già presente']);
  await p.click('#import-box [data-imp]');
  assert.match(await p.textContent('#import-box'), /restano quelli attuali/);
  await p.click('#import-box [data-imp]');
  await p.waitForSelector('.notice.ok >> text=Importazione completata');
  assert.deepEqual(await dbNames('pieno@test.local'), ['Già presente', 'Latino', 'Scienze']);
  await d.ctx.close();
});
