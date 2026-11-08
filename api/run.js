import { runPipeline } from '../lib/pipeline.js';
import { timingSafeEqual } from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Allow', 'POST'); return res.end('Method not allowed'); }
  const token = process.env.APP_ACCESS_TOKEN;
  if (token) {
    const supplied = Buffer.from(String(req.headers.authorization ?? ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.statusCode = 401; return res.end('Access token required or incorrect.'); }
  } else if (process.env.VERCEL && process.env.MODEL_API_KEY) { res.statusCode = 503; return res.end('Set APP_ACCESS_TOKEN before enabling hosted model runs.'); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Run exceeded the 240-second budget. Reduce the episode batch.')), 240000);
  res.on('close', () => controller.abort());
  try {
    let body = req.body;
    if (body === undefined) {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 3000000) throw new Error('Input exceeds the 3 MB request limit.'); }
      body = JSON.parse(raw);
    } else if (typeof body === 'string' || Buffer.isBuffer(body)) body = JSON.parse(body.toString());
    if (Buffer.byteLength(JSON.stringify(body)) > 3000000) throw new Error('Input exceeds the 3 MB request limit.');
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
    const report = await runPipeline(body.records, { mode: body.mode, stitch: !!body.stitch, signal: controller.signal, onEvent: send });
    send({ type: 'result', report });
  } catch (e) {
    if (!res.headersSent) { res.statusCode = 400; res.setHeader('Content-Type', 'application/x-ndjson'); }
    if (!res.destroyed) res.write(JSON.stringify({ type: 'error', message: e.message }) + '\n');
  } finally { clearTimeout(timer); res.end(); }
}
