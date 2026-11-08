import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { prompts, VERSION } from './prompts.js';
import { compactCandidates } from './model-payload.js';

// Entries belong to this server process. Cache only responses accepted by the pipeline.
const cache = new Map();
const maxEntries = 256;
const ttlMs = 60 * 60 * 1000;

export function modelConfig() {
  const primary = {
    baseURL: process.env.MODEL_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: process.env.MODEL_API_KEY,
    model: process.env.MODEL_NAME,
  };
  const fallbacks = [];
  for (let slot = 1; slot <= 3; slot++) {
    const prefix = `MODEL_FALLBACK_${slot}_`;
    if (!process.env[prefix + 'API_KEY']) continue;
    fallbacks.push({
      baseURL: process.env[prefix + 'BASE_URL'] || primary.baseURL,
      apiKey: process.env[prefix + 'API_KEY'],
      model: process.env[prefix + 'NAME'] || primary.model,
    });
  }
  return { ...primary, fallbacks };
}

function buildRoute(config, agent, content) {
  if (!config.apiKey || !config.model) throw new Error('Configure an API key and model name for each model endpoint.');
  const url = new URL(config.baseURL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    throw new Error('Use a clean HTTPS model base URL (HTTP is allowed for localhost).');
  }
  const request = {
    model: config.model,
    messages: [{ role: 'system', content: prompts[agent] }, { role: 'user', content }],
    response_format: { type: 'json_object' },
  };
  if (url.hostname === 'api.openai.com' && config.model === 'gpt-5-nano') {
    request.reasoning_effort = agent === 'questionProof' ? 'medium' : 'low';
  }
  if (url.hostname === 'openrouter.ai') {
    request.provider = { require_parameters: true };
    request.max_tokens = 4096;
  }
  return { url: url.href.replace(/\/$/, '') + '/chat/completions', apiKey: config.apiKey, request, provider: url.host };
}

function storeResult(key, entry) {
  if (cache.size >= maxEntries && !cache.has(key)) cache.delete(cache.keys().next().value);
  cache.set(key, { ...entry, expiresAt: Date.now() + ttlMs });
}

export async function callModel(agent, payload, { emit, signal, config = modelConfig(), onCacheable }) {
  signal.throwIfAborted();
  const content = JSON.stringify(payload.candidates ? compactCandidates(payload) : payload);
  const routes = [config, ...(config.fallbacks ?? [])].map(c => buildRoute(c, agent, content));
  const key = createHash('sha256').update(JSON.stringify([VERSION, agent, routes])).digest('hex');
  const callId = randomUUID();
  const event = (status, fields) => emit({ type:'tool', agent, callId, status, tool:'model.generate_json', ...fields });
  const cached = onCacheable && cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    event('cache-hit', { provider:cached.provider, model:cached.model, slot:cached.slot, raw:cached.raw, message:'Using a previously validated model response.' });
    return JSON.parse(cached.raw);
  }
  if (cached) cache.delete(key);
  const start = Date.now();
  event('started', { promptVersion:VERSION, request:routes[0].request });
  try {
    for (let index = 0; index < routes.length; index++) {
      const route = routes[index];
      const origin = { slot:index + 1, provider:route.provider, model:route.request.model };
      for (let attempt = 0; attempt < 2; attempt++) {
        event('attempt', { ...origin });
        const response = await fetch(route.url, {
          method:'POST', redirect:'error',
          headers:{ Authorization:`Bearer ${route.apiKey}`, 'Content-Type':'application/json' },
          body:JSON.stringify(route.request),
          signal:AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        });
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          await response.text();
          if (index + 1 < routes.length) {
            event('fallback', { ...origin, nextSlot:index + 2, nextProvider:routes[index + 1].provider, message:'HTTP 429. Trying the next configured endpoint.' });
            break;
          }
          const waitMs = retryAfter === null ? NaN : Number(retryAfter) * 1000;
          if (!attempt && Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= 60000) {
            event('retrying', { ...origin, waitMs, message:'Waiting for Retry-After on the last configured endpoint.' });
            await delay(waitMs + 100, undefined, { signal });
            continue;
          }
          throw new Error('Model provider returned HTTP 429. Rate limit reached on all configured endpoints.');
        }
        if (!response.ok) throw new Error(`Model provider returned HTTP ${response.status}. ${response.status === 413 ? 'Request exceeds the provider token limit.' : 'Check the configured model, credentials and quota.'}`);
        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content;
        if (data.error || data.choices?.[0]?.finish_reason === 'length') throw new Error('Provider returned an error or truncated its response.');
        let parsed;
        try { parsed = JSON.parse(raw); } catch {
          event('invalid-json', { ...origin, raw, usage:data.usage ?? null });
          throw new Error('Model returned invalid JSON. See the trace.');
        }
        event('completed', { ...origin, elapsedMs:Date.now() - start, usage:data.usage ?? null, raw });
        if (parsed && typeof parsed === 'object' && onCacheable) {
          onCacheable(parsed, () => storeResult(key, { ...origin, raw }));
        }
        return parsed;
      }
    }
    throw new Error('No configured model endpoint completed the request.');
  } catch (error) {
    event('failed', { elapsedMs:Date.now() - start, error:error.message });
    throw error;
  }
}

