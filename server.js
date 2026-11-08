import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import run from './api/run.js';
import status from './api/status.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/run') return await run(req, res);
    if (url.pathname === '/api/status') {
      let localPack = false;
      try { await readFile(path.join(root, 'private-inputs/show.json')); localPack = true; } catch {}
      const originalEnd = res.end.bind(res);
      res.end = data => originalEnd(JSON.stringify({ ...JSON.parse(data), localPack }));
      return status(req, res);
    }
    if (url.pathname === '/api/local-pack') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(await readFile(path.join(root, 'private-inputs/show.json')));
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; return res.end(); }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(root, 'public', '.' + pathname);
    if (!file.startsWith(path.join(root, 'public') + path.sep)) { res.statusCode = 403; return res.end(); }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('Not found'); }
});
server.listen(Number(process.env.PORT || 4317), '127.0.0.1', () => console.log(`Promo Lab: http://localhost:${process.env.PORT || 4317}`));
