# Programma Studio

App per creare piani di studio giorno per giorno: materie, verifiche, pagine, orari liberi e impegni fissi.

Apri: https://cioscina.github.io/Programma-studio/

## Account e dati su più dispositivi

L'app può usare [Supabase](https://supabase.com) per gli account (email e password) e per salvare i dati di ogni persona in modo separato e sicuro. Finché `config.js` è vuoto funziona come prima, con i dati salvati solo nel browser.

Come attivarlo, impostazioni, sicurezza e test: **[SUPABASE.md](SUPABASE.md)**.

## Struttura

- `index.html`: l'app (interfaccia e pianificazione)
- `config.js`: URL e chiave pubblica di Supabase (vuoti = senza account)
- `src/model.js`: conversione tra i dati dell'app e le tabelle
- `src/sync.js`: salvataggio, rilettura e conflitti tra dispositivi
- `src/cloud.js`: accesso, registrazione, password, importazione dei dati locali
- `vendor/`: libreria supabase-js 2.118.0 (licenza MIT)
- `supabase/migrations/`: schema del database e regole di sicurezza
- `tests/`: test del modello, del database e nel browser
