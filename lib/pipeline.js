import { createHash, randomUUID } from 'node:crypto';
import { normalize, resolveSegments } from './input.js';
import { callModel, modelConfig } from './model.js';
import { VERSION } from './prompts.js';
import { endingOptions, selectEnding } from './endings.js';
import { groundQuestion } from './question-evidence.js';

const hookWords = /\b(slap|slaps|slapped|betray\w*|pregnant|murder\w*|kill\w*|divorce|secret|duke|marry|married|dead|blood|gun|liar|lie|lying|not anymore|look for yourself|stop)\b/i;
const cliffWords = /\b(suddenly|reveals?|gasps?|freezes?|shocked|shock|stunned|secret|about to|recogniz\w*|unmask\w*)\b/i;
const resolvedWords = /\b(happily ever after|everything is fine|case closed|all is forgiven|problem solved|it was a dream)\b/i;
const camera = r => /^CAMERA:/i.test(r.text);
const dialogue = r => !/^(CAMERA|ACTION|SFX|MUSIC|SOUND|TRANSITION):/i.test(r.text);
const content = r => r.text.replace(/^[^:]{1,150}:\s*/, '');
const substantiveQuestion = text => text.includes('?') && (text.match(/\b\w+\b/g) ?? []).length >= 5;
const scoreHook = r => hookWords.test(content(r)) ? 4 : substantiveQuestion(content(r)) ? 3 : camera(r) ? 1 : 2;
const scoreCliff = r => resolvedWords.test(content(r)) ? 0 : cliffWords.test(content(r)) ? 4 : substantiveQuestion(content(r)) ? 3 : 1;

export function baselineScout(list) {
  const windows = [];
  for (let i = 0; i < list.length; i++) {
    if (camera(list[i]) || scoreHook(list[i]) < 3) continue;
    for (let j = i; j < list.length && list[j].start - list[i].start <= 60; j++) {
      const duration = list[j].end - list[i].start;
      if (duration < 20 || duration > 60 || camera(list[j])) continue;
      windows.push({ title: list[i].text.replace(/^[^:]+:\s*/, '').replace(/^"|"$/g, '').slice(0, 70), segments: [{ episode: list[i].episode, startId: list[i].id, endId: list[j].id }], proxy: scoreHook(list[i]) + scoreCliff(list[j]), start: list[i].start, end: list[j].end });
    }
  }
  windows.sort((a, b) => b.proxy - a.proxy || a.start - b.start || a.end - b.end);
  const selected = [];
  for (const w of windows) {
    if (selected.every(p => Math.max(0, Math.min(w.end, p.end) - Math.max(w.start, p.start)) / Math.min(w.end - w.start, p.end - p.start) < .65)) selected.push(w);
    if (selected.length === 3) break;
  }
  return { candidates: selected.map(({ title, segments }) => ({ title, segments })) };
}

export function baselineReview(candidate) {
  const first = candidate.segments[0], last = candidate.segments.at(-1);
  const opening = first.records.find(r => r.id === first.startId), ending = last.records.find(r => r.id === last.endId);
  // An earlier resolution can be followed by a new question: gate only on the ending.
  const resolved = resolvedWords.test(content(ending));
  return { candidateId: candidate.id, hook: scoreHook(opening), cliffhanger: resolved ? 0 : scoreCliff(ending), clarity: 2, emotion: hookWords.test(candidate.segments.flatMap(s => s.records).map(r => r.text).join(' ')) ? 3 : 1, hookId: opening.id, cliffhangerId: ending.id, why: 'Opening contains a potential conflict cue; the ending is scored for question or suspense cues. An editor must confirm the story works without prior context.', risks: ['Keyword baseline cannot understand irony, relationships, payoffs or whether the ending is genuinely unresolved.', ...(resolved ? ['The selected ending contains a resolution cue.'] : [])], needsReview: true };
}

export function validateReview(candidate, review) {
  if (!review || review.candidateId !== candidate.id) throw new Error('Missing or mismatched critic review.');
  for (const key of ['hook', 'cliffhanger', 'clarity', 'emotion']) if (!Number.isInteger(review[key]) || review[key] < 0 || review[key] > 5) throw new Error(`Invalid ${key} score.`);
  if (typeof review.why !== 'string' || !review.why.trim() || review.why.length > 2000 || !Array.isArray(review.risks) || review.risks.length > 20 || review.risks.some(r => typeof r !== 'string' || r.length > 1000) || typeof review.needsReview !== 'boolean') throw new Error('Invalid critic explanation or risks.');
  const first = candidate.segments[0], last = candidate.segments.at(-1);
  const hook = first.records.find(r => r.id === review.hookId);
  if (!hook || hook.start < first.start || hook.start - first.start > 3) throw new Error('Hook evidence is not in the first 3 seconds.');
  if (review.cliffhangerId !== last.endId) throw new Error('Cliffhanger evidence must identify the selected ending.');
  const risks = [...review.risks];
  if (hook.end - hook.start > 3) risks.push('Hook record is longer than 3 seconds; verify the hook happens early in the actual footage.');
  if (candidate.segments.some(s => s.records.some(r => dialogue(r) && (r.start < s.start || r.end > s.end)))) risks.push('A cut intersects a dialogue record. Check the footage and move the boundary if speech is interrupted.');
  if (candidate.segments.some(s => {
    const sorted = s.records;
    let covered = s.start;
    for (const r of sorted) { if (r.start > covered + 1) return true; covered = Math.max(covered, r.end); }
    return covered < s.end;
  })) risks.push('Source has an untimed gap greater than 1 second within the clip.');
  return { ...review, risks, needsReview: review.needsReview || risks.length > 0, hookText: hook.text, cliffhangerText: last.records.find(r => r.id === last.endId).text };
}

export const editorialScore = r => Math.round((r.hook * .35 + r.cliffhanger * .30 + r.clarity * .25 + r.emotion * .10) * 20);
export function overlap(a, b) {
  let intersection = 0;
  for (const x of a.segments) for (const y of b.segments) if (x.episode === y.episode) intersection += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return intersection / Math.min(a.duration, b.duration);
}

async function pool(items, concurrency, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (cursor < items.length) { const i = cursor++; await fn(items[i], i); } }));
}

export async function runPipeline(input, options = {}) {
  const started = Date.now(), runId = randomUUID(), events = [];
  const emit = event => { const e = { ...event, at: new Date().toISOString(), sequence: events.length + 1 }; events.push(e); options.onEvent?.(e); };
  const signal = options.signal ?? AbortSignal.timeout(240000);
  const mode = options.mode ?? 'baseline';
  const config = modelConfig();
  const groq = mode === 'model' && !options.generate && [config, ...config.fallbacks].some(route => new URL(route.baseURL).hostname === 'api.groq.com');
  const concurrency = groq ? 1 : 2;
  if (!['baseline', 'model'].includes(mode)) throw new Error('Mode must be baseline or model.');
  const source = normalize(input);
  const fingerprint = createHash('sha256').update(JSON.stringify(source.records)).digest('hex');
  const candidates = [], failures = [], coverage = [];
  const pendingCache = new WeakMap();
  const generate = options.generate ?? ((agent, payload) => callModel(agent, payload, {
    emit, signal, onCacheable: (result, commit) => pendingCache.set(result, commit),
  }));
  emit({ type: 'stage', agent: 'master', status: 'started', message: `Run started: ${source.episodes.size} episodes, ${source.records.length} records.`, mode, runId });
  emit({ type: 'stage', agent: 'ingest', status: 'completed', message: 'Source IDs and timestamps validated; overlapping visual and dialogue layers preserved.', fingerprint });
  const accept = (proposals, prefix, allowedEpisodes) => {
    if (!Array.isArray(proposals) || proposals.length > 3) throw new Error('Agent must return at most 3 candidates.');
    let valid = true;
    proposals.forEach((proposal, i) => {
      const id = `${prefix}-${i + 1}`;
      try {
        if (typeof proposal.title !== 'string' || !proposal.title.trim() || proposal.title.length > 200) throw new Error('Missing or oversized candidate title.');
        if (allowedEpisodes && proposal.segments?.some(s => !allowedEpisodes.includes(s.episode))) throw new Error('Scout selected a different episode.');
        if (allowedEpisodes && proposal.segments?.length !== 1) throw new Error('Scout must propose continuous single-segment clips.');
        const resolved = resolveSegments(proposal, source);
        candidates.push({ id, title: proposal.title, ...resolved });
      } catch (e) { valid = false; failures.push({ candidateId: id, agent: 'validator', reason: e.message, proposal }); }
    });
    return valid;
  };
  const entries = [...source.episodes];
  await pool(entries, concurrency, async ([episode, records], i) => {
    emit({ type: 'stage', agent: 'scout', status: 'started', episode, message: `Searching ${episode}.` });
    try {
      signal.throwIfAborted();
      if (mode === 'model' && JSON.stringify(records).length > 65000) throw new Error('Episode exceeds the model context budget; split it into smaller episode parts.');
      let result;
      if (mode === 'model') {
        // Give the scout usable time boundaries. Find the legal openings with
        // strongest hook cues and include both duration extremes for variety.
        const legalStartsByEnd = {};
        for (const end of records) {
          const starts = records.filter(r => end.end-r.start >= 20 && end.end-r.start <= 60 && r.start <= end.start);
          if (!starts.length) continue;
          const strongest = [...starts].sort((a,b)=>scoreHook(b)-scoreHook(a)).slice(0,3);
          legalStartsByEnd[end.id] = [...new Set([starts[0], ...strongest, starts.at(-1)].map(r=>r.id))];
        }
        result = await generate('scout', { episode, records, legalStartsByEnd });
      } else result = baselineScout(records);
      if (accept(result.candidates, `e${i + 1}`, [episode])) pendingCache.get(result)?.();
      coverage.push({ episode, status: 'completed', proposed: result.candidates.length });
      emit({ type: 'stage', agent: 'scout', status: 'completed', episode, message: `${episode}: ${result.candidates.length} candidates proposed.` });
    } catch (e) {
      coverage.push({ episode, status: 'failed', error: e.message });
      failures.push({ agent: 'scout', episode, reason: e.message });
      emit({ type: 'stage', agent: 'scout', status: 'failed', episode, message: e.message });
    }
  });
  candidates.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  if (options.stitch && mode === 'model' && candidates.length) {
    emit({ type: 'stage', agent: 'assembler', status: 'started', message: 'Testing a small cross-episode shortlist for coherent combinations.' });
    try {
      const shortlist = [...candidates].sort((a, b) => editorialScore(baselineReview(b)) - editorialScore(baselineReview(a))).slice(0, 12);
      const result = await generate('assembler', { candidates: shortlist });
      // Assembly is limited to records in the supplied shortlist, not the entire source.
      const allowed = new Set(shortlist.flatMap(c => c.segments.flatMap(s => s.records.map(r => r.id))));
      if (!Array.isArray(result.candidates) || result.candidates.some(c => !Array.isArray(c.segments) || c.segments.length < 2 || c.segments.some(s => !allowed.has(s.startId) || !allowed.has(s.endId)) || resolveSegments(c, source).segments.some(s => s.records.some(r => !allowed.has(r.id))))) throw new Error('Assembler selected records outside its shortlist or fewer than 2 segments.');
      if (accept(result.candidates, 'mix')) pendingCache.get(result)?.();
      emit({ type: 'stage', agent: 'assembler', status: 'completed', message: `${result.candidates.length} assemblies proposed.` });
    } catch (e) { failures.push({ agent: 'assembler', reason: e.message }); emit({ type: 'stage', agent: 'assembler', status: 'failed', message: e.message }); }
  }
  if (mode === 'model') for (const candidate of candidates) candidate.endingOptions = endingOptions(candidate, source);
  emit({ type: 'stage', agent: 'critic', status: 'started', message: `Reviewing ${candidates.length} source-valid candidates${mode === 'model' ? ' and comparing nearby ending boundaries' : ''}.` });
  const reviewed = [];
  const batchSize = groq ? 1 : 5;
  const batches = Array.from({ length: Math.ceil(candidates.length / batchSize) }, (_, i) => candidates.slice(i * batchSize, i * batchSize + batchSize));
  await pool(batches, concurrency, async batch => {
    try {
      signal.throwIfAborted();
      const result = mode === 'model' ? await generate('critic', { candidates: batch }) : { reviews: batch.map(baselineReview) };
      if (!Array.isArray(result.reviews) || result.reviews.length !== batch.length || new Set(result.reviews.map(r => r.candidateId)).size !== batch.length || result.reviews.some(r => !batch.some(c => c.id === r.candidateId))) throw new Error('Critic must return exactly one review per supplied candidate.');
      let valid = true;
      for (const candidate of batch) {
        try {
          const raw = result.reviews.find(r => r.candidateId === candidate.id);
          const selected = mode === 'model' ? selectEnding(candidate, raw) : candidate;
          const review = validateReview(selected, raw);
          if (mode === 'model') await groundQuestion(selected, review, generate, result => pendingCache.get(result)?.());
          const rejected = review.hook < 3 || review.cliffhanger < 3 || review.clarity < (mode === 'model' ? 3 : 2);
          reviewed.push({ ...selected, review, score: editorialScore(review), status: rejected ? 'rejected' : review.needsReview ? 'needs-review' : 'shortlisted', rejectionReason: rejected ? 'Below minimum hook, cliffhanger or standalone clarity threshold.' : null });
        } catch (e) { valid = false; failures.push({ agent: 'critic', candidateId: candidate.id, reason: e.message }); }
      }
      if (valid) pendingCache.get(result)?.();
    } catch (e) { for (const c of batch) failures.push({ agent: 'critic', candidateId: c.id, reason: e.message }); }
  });
  reviewed.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const ranked = [];
  for (const c of reviewed) {
    if (c.status === 'rejected') continue;
    const similar = ranked.find(p => overlap(c, p) >= .65);
    if (similar) { c.status = 'duplicate'; c.rejectionReason = `Overlaps ${similar.id} by at least 65% of the shorter clip.`; }
    else { c.rank = ranked.length + 1; ranked.push(c); }
  }
  emit({ type: 'stage', agent: 'critic', status: 'completed', message: `${reviewed.length} candidates reviewed; ${failures.filter(f => f.agent === 'critic').length} review failures.` });
  emit({ type: 'stage', agent: 'ranker', status: 'completed', message: `${ranked.length} distinct promos ranked; ${reviewed.length - ranked.length} rejected or overlapping.` });
  const report = { schemaVersion: VERSION, runId, createdAt: new Date().toISOString(), mode, fingerprint, options: { stitch: !!options.stitch }, summary: { episodes: source.episodes.size, records: source.records.length, proposed: candidates.length, reviewed: reviewed.length, ranked: ranked.length, failures: failures.length, elapsedMs: Date.now() - started, partial: failures.length > 0 }, coverage: coverage.sort((a, b) => a.episode.localeCompare(b.episode, undefined, { numeric: true })), candidates: reviewed, unreviewed: candidates.filter(c => !reviewed.some(r => r.id === c.id)), failures, limitations: ['Text-only analysis cannot verify acting, visual impact or frame-accurate edits.', 'Scores are editorial heuristics, not measured audience performance.', 'Whole-record boundaries require an editor to verify the actual footage.', ...(mode === 'baseline' ? ['Offline baseline uses keywords, not an AI model. Every result needs human story review.', 'Cross-episode assembly is available only in model mode.'] : ['Model judgments can be wrong; independently review the hook, ending and continuity.'])] };
  emit({ type: 'stage', agent: 'master', status: 'completed', message: report.summary.partial ? 'Run completed with failures. Inspect coverage and trace before using results.' : 'Run complete. Ready for editorial review.' });
  return { ...report, pipelineVersion: '0.2.0', model: mode === 'model' ? (options.generate ? 'injected-provider' : modelConfig().model) : null, usage: { cacheHits: events.filter(e => e.status === 'cache-hit').length, fallbackSwitches: events.filter(e => e.status === 'fallback').length, httpAttempts: events.filter(e => e.status === 'attempt').length, modelCalls: events.filter(e => e.type === 'tool' && e.status === 'started').length, reportedTokens: events.reduce((n,e) => n + (e.usage?.total_tokens ?? 0),0), reportedCost: events.reduce((n,e) => n + (e.usage?.cost ?? 0),0) }, events };
}
