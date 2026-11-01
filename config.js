// Configurazione di Supabase per Programma Studio.
//
// Lasciando i valori vuoti l'app funziona come prima: niente account, dati
// salvati solo nel browser di questo dispositivo.
//
// Per attivare gli account inserisci qui (oppure genera questo file con
// `npm run config` a partire da .env, vedi SUPABASE.md):
//   supabaseUrl             -> Project URL (Settings > API)
//   supabasePublishableKey  -> chiave pubblica "publishable" (sb_publishable_...)
//                              oppure la vecchia chiave "anon"
//   siteUrl (facoltativo)   -> indirizzo a cui portano i link nelle email;
//                              se vuoto si usa l'indirizzo della pagina aperta
//
// Queste chiavi sono pubbliche per definizione (la sicurezza è data dalle
// policy RLS nel database). NON inserire mai la chiave "secret"/"service_role".
window.PROGRAMMA_STUDIO_CONFIG = {
  supabaseUrl: "https://djdkhkxraysjnlhcrbpq.supabase.co",
  supabasePublishableKey: "sb_publishable_czWj6QLmoQG3fZIiTlYE-Q_qQyjLSyF",
  siteUrl: ""
};
