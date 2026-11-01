// Server statico minimo per provare l'app in locale: npm run dev
// (http://localhost:3000). Nessuna dipendenza.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] || '.');
const port = Number(process.env.PORT || 3000);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// overrides: { '/config.js': 'contenuto' } per servire file diversi (usato dai test)
export function startServer({ dir = root, listen = port, overrides = {} } = {}) {
  const srv = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (overrides[p] !== undefined) { res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'text/plain', 'cache-control': 'no-store' }); res.end(overrides[p]); return; }
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(dir, p));
      if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
      if (!(await stat(file)).isFile()) throw 0;
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch (e) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Non trovato'); }
  });
  return new Promise(ok => srv.listen(listen, () => ok(srv)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then(() => console.log(`Programma Studio su http://localhost:${port}`));
}
