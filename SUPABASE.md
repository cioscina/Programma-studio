# Programma Studio con account (Supabase)

Questa versione permette a ogni persona di creare un account, accedere da
computer, tablet o telefono e ritrovare il proprio programma. Ogni account ha
un ambiente separato: nessuno vede o modifica i dati degli altri, e questo è
garantito dal database (Row Level Security), non solo dall'interfaccia.

Finché `config.js` è vuoto l'app funziona **esattamente come prima** (dati nel
browser, nessun account). Gli account si attivano solo quando inserisci i dati
del tuo progetto Supabase.

---

## 1. Creare il progetto Supabase

1. Vai su <https://supabase.com/dashboard> e accedi (puoi usare l'account GitHub).
2. **New project**: scegli un nome (es. `programma-studio`), una password del
   database (salvala in un posto sicuro, all'app non serve) e la regione
   **Central EU (Frankfurt)** o un'altra in Europa.
3. Aspetta che il progetto sia pronto (1-2 minuti).

## 2. Creare tabelle e regole di sicurezza (migrazioni)

Le migrazioni sono in `supabase/migrations/` e vanno applicate **in ordine**:

| File | Cosa fa |
|---|---|
| `20261101120000_schema.sql` | tabelle, vincoli, indici, versione e date automatiche |
| `20261101120100_rls.sql` | Row Level Security e policy SELECT/INSERT/UPDATE/DELETE |
| `20261101120200_import_local_data.sql` | funzione per importare i dati salvati sul dispositivo |
| `20261101120300_realtime.sql` | aggiorna in tempo reale le altre pagine aperte |

**Modo semplice (dalla dashboard):** *SQL Editor* → *New query* → incolla il
contenuto del primo file → *Run*. Ripeti con gli altri tre, nell'ordine.

**Con la Supabase CLI** (se la usi):

```bash
supabase login
supabase link --project-ref <REF-DEL-PROGETTO>
supabase db push
```

Controllo: in *Table Editor* devono comparire 9 tabelle (`subjects`, `tasks`,
`study_slots`, `commitments`, `days_off`, `session_done`, `session_pins`,
`user_settings`, `local_imports`), tutte con il lucchetto "RLS enabled".
In *Database → Publications → supabase_realtime* devono esserci le prime 8.

## 3. Impostazioni di Authentication

Nella dashboard, sezione **Authentication**:

1. **Sign In / Providers → Email**
   - *Enable Email provider*: attivo
   - *Confirm email*: **attivo** (chi si registra deve confermare l'indirizzo)
   - *Minimum password length*: **8**
   - *Secure email change*: attivo
2. **URL Configuration**
   - *Site URL*: `https://cioscina.github.io/Programma-studio/`
   - *Redirect URLs*, aggiungi:
     - `https://cioscina.github.io/Programma-studio/` (produzione)
     - `http://localhost:3000/` (sviluppo, `npm run dev`)
     - `http://127.0.0.1:3000/` (sviluppo)

   I link delle email (conferma e nuova password) riportano all'indirizzo da
   cui la persona ha fatto la richiesta; deve essere in questo elenco,
   altrimenti Supabase usa la *Site URL*.
3. **Emails / SMTP Settings** — passaggio importante: il servizio email
   incluso in Supabase serve solo per le prove (manda email solo agli
   indirizzi del team del progetto e pochissime all'ora). Per far registrare
   altre persone (es. tua nipote) configura un SMTP esterno, per esempio
   Brevo, Resend o il server SMTP della tua casella: *Authentication → Emails →
   SMTP Settings → Enable custom SMTP*, con host, porta, utente e password
   forniti dal servizio.
4. (Facoltativo) **Emails → Templates**: puoi tradurre in italiano i testi di
   *Confirm signup* e *Reset password*. Lascia il link `{{ .ConfirmationURL }}`
   così com'è.
5. **Sessions**: le impostazioni predefinite vanno bene (token di accesso di 1
   ora rinnovato automaticamente dall'app, refresh token con rotazione).

## 4. Collegare l'app al progetto

Nella dashboard: **Project Settings → API Keys** (e *Data API* per l'URL).
Ti servono due valori:

- **Project URL**, es. `https://abcdefghijklmnop.supabase.co`
- **Publishable key** (`sb_publishable_...`). Va bene anche la vecchia
  **anon public** key.

> ⚠️ Non usare mai la **Secret key** (`sb_secret_...`) né la **service_role**:
> darebbero accesso a tutti i dati saltando le regole di sicurezza. L'app si
> rifiuta di partire se ne trova una in `config.js`.

Poi in `config.js` (nel repository) inserisci i valori:

```js
window.PROGRAMMA_STUDIO_CONFIG = {
  supabaseUrl: "https://abcdefghijklmnop.supabase.co",
  supabasePublishableKey: "sb_publishable_...",
  siteUrl: ""
};
```

La chiave publishable è pubblica per definizione: può stare nel repository.
La protezione dei dati sta nelle policy RLS.

In alternativa: copia `.env.example` in `.env`, compilalo ed esegui
`npm run config`, che scrive `config.js` (e blocca le chiavi segrete).

Fatto il merge su `main`, GitHub Pages pubblica la nuova versione e
all'apertura compare la schermata di accesso.

## 5. Sviluppo in locale

Serve Node.js 20 o più recente.

```bash
npm install          # solo per i test (pg)
cp .env.example .env # inserisci URL e chiave publishable, SITE_URL=http://localhost:3000/
npm run config       # scrive config.js
npm run dev          # http://localhost:3000
```

Con la Supabase CLI puoi usare anche un Supabase locale: `supabase start`
(legge `supabase/config.toml` e applica le migrazioni), poi usa l'URL e la
chiave che stampa. Le email di prova si leggono su <http://localhost:54324>.

## 6. Test

```bash
npm test             # modello dati: conversioni, differenze, unione, importazione
npm run test:db      # isolamento tra account e importazione, nel database
npm run test:e2e     # nel browser (Chromium/Playwright) con supabase-js
```

- `test:db` crea un database temporaneo su un PostgreSQL (variabile
  `TEST_PG_ADMIN_URL`, predefinito `postgres://postgres:postgres@127.0.0.1:5432/postgres`),
  ricrea il minimo dell'ambiente Supabase (`tests/db/bootstrap-vanilla-postgres.sql`:
  ruoli `anon`/`authenticated`, `auth.uid()`, permessi predefiniti) e applica le
  migrazioni. Con un Supabase locale usa invece `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`.
- `test:e2e` usa la vera libreria supabase-js nel browser contro
  `tests/e2e/fake-supabase.mjs`: un **sostituto di prova** di Auth e REST che
  esegue ogni richiesta nel PostgreSQL con il ruolo e l'utente del token, come
  fa Supabase, quindi RLS e vincoli sono quelli veri. Non simula Realtime né
  l'invio reale delle email. Richiede Playwright con Chromium.

## Come funziona

### Dati

| Nell'app | Tabella | Note |
|---|---|---|
| Inizio piano, durata sessione, pausa, margine, sottotitolo, obiettivo | `user_settings` | una riga per utente |
| Materie (ordine e colore) | `subjects` | `position` = ordine |
| Verifiche e compiti, pagine, altro materiale | `tasks` | `subject_id` → materia dello **stesso** utente; eliminando la materia si eliminano le sue verifiche |
| Tempo per studiare (fasce per giorno) | `study_slots` | chiave (utente, giorno, posizione) |
| Impegni fissi | `commitments` | giorni 0 = domenica … 6 = sabato |
| Giorni senza studio | `days_off` | |
| Sessioni segnate come fatte | `session_done` | → compito dello stesso utente |
| Sessioni spostate con "Sposta" | `session_pins` | → compito dello stesso utente |
| Importazioni dal dispositivo | `local_imports` | impedisce i doppioni |

Ogni riga ha `user_id` (→ `auth.users`, cancellando l'account si cancellano i
suoi dati), `created_at`, `updated_at` e, dove si modifica, `version`.

### Sicurezza

- RLS attiva su tutte le tabelle; policy per SELECT, INSERT, UPDATE e DELETE
  solo per utenti autenticati e solo sulle righe con `user_id = auth.uid()`.
- `WITH CHECK` e un trigger impediscono di creare righe per altri o di
  cambiare il proprietario.
- I collegamenti tra tabelle usano chiavi esterne composte `(id, user_id)`:
  non si può collegare un proprio compito alla materia di un altro, nemmeno
  conoscendone l'id.
- Il ruolo `anon` non ha permessi; ad `authenticated` è tolto anche TRUNCATE.
- La funzione di importazione è `SECURITY INVOKER`: vale la stessa RLS.
- Nel frontend c'è solo la chiave pubblica. L'app non carica file degli
  utenti, quindi Supabase Storage non è usato.

### Salvataggio e più dispositivi

- Supabase è la fonte dei dati. Con gli account attivi l'app **non** legge né
  scrive i dati in `localStorage` (solo la sessione di accesso, gestita da
  supabase-js).
- Ogni modifica viene salvata dopo circa mezzo secondo. In alto si vede lo
  stato: *Modifiche da salvare…*, *Salvataggio in corso…*, *✓ Tutto salvato*
  (solo dopo la conferma del server), *Senza connessione: le modifiche NON sono
  salvate*, *Salvataggio non riuscito, riprovo tra N s* con *Riprova ora*.
- Senza rete le modifiche restano solo nella pagina aperta: l'app riprova da
  sola (attese crescenti fino a 30 s e subito quando torna la rete) e avvisa se
  provi a chiudere la pagina con modifiche non salvate. Non c'è una modalità
  offline completa.
- **Modifiche concorrenti**: ogni riga ha una versione. Un dispositivo salva
  una modifica solo se la riga è ancora alla versione che conosce. Se un altro
  dispositivo l'ha cambiata o eliminata prima, vince la versione già salvata:
  la pagina la mostra e compare l'avviso con il nome dell'elemento
  ("Nel frattempo è stato modificato su un altro dispositivo: materia «…»").
  Modifiche a elementi diversi si salvano tutte. Nessuna sovrascrittura
  silenziosa.
- Le altre pagine aperte si aggiornano con Realtime; inoltre i dati vengono
  riletti all'accesso, quando la pagina torna in primo piano, quando torna la
  rete e ogni minuto, unendo le modifiche non ancora salvate.
- **Uscita / cambio account**: i dati vengono tolti dalla pagina e dalla
  memoria; la sessione viene rimossa dal browser (anche senza rete).
- **Sessione scaduta**: la pagina torna alla schermata di accesso e i dati
  vengono nascosti. Se c'erano modifiche non salvate e si rientra con lo stesso
  account, vengono salvate (con lo stesso controllo dei conflitti); con un
  altro account vengono scartate.

### Dati già salvati su un dispositivo

Se nel browser ci sono dati della versione precedente (`programma-studio-v1`),
dopo l'accesso compare una proposta di importazione con il riepilogo e
l'indirizzo dell'account. Niente viene copiato senza due clic di conferma.

- Account vuoto: si copia tutto, compresi orari e impostazioni.
- Account con dati: materie, verifiche, impegni e giorni liberi si aggiungono
  in coda; orari settimanali e impostazioni dell'account restano quelli.
- L'importazione avviene in un'unica transazione (tutto o niente).
- Ripeterla non crea doppioni: il database ricorda l'impronta (SHA-256) dei
  dati importati per ciascun account.
- I dati locali **non vengono cancellati**: dopo aver verificato sul server che
  ci sia tutto, vengono solo marcati come migrati (`programma-studio-v1-migrated`)
  e la proposta non compare più su quel dispositivo, nemmeno per altri account.

### Copie dell'app che restano senza account

L'artifact su claude.ai e il file offline (`programma-studio-offline.html`)
continuano a funzionare come prima, con i dati nel browser.
