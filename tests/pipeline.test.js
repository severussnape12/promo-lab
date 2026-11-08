import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalize, seconds, parseText, resolveSegments } from '../lib/input.js';
import { runPipeline, baselineScout, baselineReview, validateReview, overlap } from '../lib/pipeline.js';
import { callModel } from '../lib/model.js';
import { endingOptions, selectEnding } from '../lib/endings.js';
import { compactCandidates } from '../lib/model-payload.js';
const sample = JSON.parse(await readFile(new URL('../public/sample.json', import.meta.url), 'utf8'));
const source = normalize(sample);
const firstEpisode = [...source.episodes.keys()][0];
const proposal = { segments:[{ episode:firstEpisode,startId:'r00001',endId:'r00006' }] };
const candidate = { id:'c1',...resolveSegments(proposal,source) };
const modelReview = c => ({ ...baselineReview(c), clarity:4, selectedEndId:c.segments.at(-1).endId, endingStrategy:'confrontation', questionEvidenceIds:[c.segments.at(-1).endId], viewerQuestion:'How will the family respond to the accusation?', cutReason:'The confrontation leaves the response unresolved.', alternativeCuts:c.endingOptions.map(o => ({ endId:o.endId,reason:o.endId === c.segments.at(-1).endId ? 'Keeps the accusation and withholds the answer.' : 'Less focused confrontation.' })) });

test('compact model payload preserves all evidence without repeating source text', () => {
  const c = {...candidate,title:'Test',endingOptions:endingOptions(candidate,source)};
  const compact = compactCandidates({candidates:[c]});
  assert.equal(new Set(compact.sourceRecords.map(r=>r.id)).size,compact.sourceRecords.length);
  for (const option of compact.candidates[0].endingOptions) for (const segment of option.segments) for (const id of [...segment.recordIds,segment.beforeId,segment.afterId].filter(Boolean)) assert.ok(compact.sourceRecords.some(r=>r.id===id));
  assert.ok(compact.candidates[0].eligibleHookIds.includes('r00001'));
  assert.ok(!compact.candidates[0].eligibleHookIds.includes('r00005'));
  assert.ok(JSON.stringify(compact).length < JSON.stringify({candidates:[c]}).length);
});

test('provider retry respects Retry-After once and does not retry ordinary errors', async () => {
  const original=global.fetch,events=[];let calls=0;
  global.fetch=async()=>++calls===1?new Response('',{status:429,headers:{'retry-after':'0'}}):new Response(JSON.stringify({choices:[{message:{content:'{"candidates":[]}'}}]}));
  const options={emit:e=>events.push(e),signal:new AbortController().signal,config:{baseURL:'https://api.groq.com/openai/v1',apiKey:'test',model:'test'}};
  try {
    await callModel('scout',{},options);assert.equal(calls,2);assert.ok(events.some(e=>e.status==='retrying'));
    calls=0;global.fetch=async()=>{calls++;return new Response('',{status:413});};
    await assert.rejects(callModel('scout',{},options),/token limit/);assert.equal(calls,1);
    calls=0;global.fetch=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'0'}});};
    await assert.rejects(callModel('scout',{},options),/Rate limit/);assert.equal(calls,2);
  } finally {global.fetch=original;}
});

test('timestamps retain fractional precision and reject malformed values', () => {
  assert.equal(seconds('01:02:03.45'),3723.45); assert.equal(seconds('00:03,500'),3.5);
  for (const value of ['1:60','abc',-1,Infinity,'1.5:03']) assert.throws(() => seconds(value));
});
test('input rejects duplicate IDs, missing fields and reversed times', () => {
  assert.throws(() => normalize([{ episode:'e',start:3,end:2,text:'x' }]));
  assert.throws(() => normalize([{ start:0,end:2,text:'x' }]));
  assert.throws(() => normalize([{ id:'a',episode:'e',start:0,end:2,text:'x' },{ id:'a',episode:'e',start:2,end:3,text:'y' }]));
});
test('Kuku parser preserves simultaneous camera and dialogue, counts every timed block', () => {
  const txt = 'EPISODE NUMBER: Episode 1\n--- SCRIPT START ---\n**CAMERA:**\nStart: (00:00.00) | End: (00:05.00)\nA door.\n\n**MARA (Angry):**\nStart: (00:01.00) | End: (00:03.00)\n"Stop!"\n--- SCRIPT END ---';
  const rows = parseText(txt); assert.equal(rows.length,2); assert.equal(normalize(rows).records[1].start,1);
  assert.throws(() => parseText(txt + '\nStart: (00:10.00) | End: (00:12.00)\nMissing label.'));
  assert.throws(() => parseText('Untimed dialogue'));
});
test('source resolver derives timestamps and enforces duration, IDs and overlap', () => {
  assert.equal(candidate.duration,27); assert.equal(candidate.segments[0].start,0); assert.equal(candidate.segments[0].end,27);
  assert.throws(() => resolveSegments({ segments:[{ episode:firstEpisode,startId:'invented',endId:'r00006' }] },source));
  assert.throws(() => resolveSegments({ segments:[{ episode:firstEpisode,startId:'r00001',endId:'r00002' }] },source));
  assert.throws(() => resolveSegments({ segments:[...proposal.segments,...proposal.segments] },source));
});
test('multi-episode duration is summed in supplied playback order', () => {
  const c = resolveSegments({ segments:[{ episode:'Episode 2 — The stranger',startId:'r00011',endId:'r00013' },{ episode:firstEpisode,startId:'r00004',endId:'r00006' }] },source);
  assert.equal(c.duration,27); assert.equal(c.segments[0].episode,'Episode 2 — The stranger');
});
test('critic cannot cite a late hook, invented ending or out-of-range score', () => {
  const review = baselineReview(candidate);
  assert.equal(validateReview(candidate,review).hookId,'r00001');
  assert.throws(() => validateReview(candidate,{ ...review,hookId:'r00005' }));
  assert.throws(() => validateReview(candidate,{ ...review,cliffhangerId:'r00005' }));
  assert.throws(() => validateReview(candidate,{ ...review,hook:7 }));
});
test('overlapping dialogue at a cut boundary is surfaced as risk', () => {
  const src = normalize([{ id:'a',episode:'e',start:0,end:3,text:'ACTION: Stop the wedding.' },{ id:'b',episode:'e',start:2,end:28,text:'MARA: Who is the stranger at the door?' },{ id:'c',episode:'e',start:20,end:24,text:'ACTION: She gasps.' }]);
  const c = { id:'c',...resolveSegments({ segments:[{ episode:'e',startId:'a',endId:'c' }] },src) };
  const review = validateReview(c,baselineReview(c));
  assert.ok(review.risks.some(r => r.includes('dialogue record')));
});
test('baseline does not give a bare Why or actor annotation a strong hook', () => {
  const rows = normalize([{ episode:'e',start:0,end:2,text:'MARA (Betrayed): Why?' },{ episode:'e',start:20,end:25,text:'ACTION: She gasps.' }]).records;
  assert.equal(baselineScout(rows).candidates.length,0);
});
test('end-to-end baseline covers quiet episodes without manufacturing a promo', async () => {
  const report = await runPipeline(sample);
  assert.equal(report.coverage.length,3); assert.equal(report.coverage[2].proposed,0); assert.equal(report.summary.failures,0);
  assert.ok(report.summary.ranked > 0);
  for (const c of report.candidates) { assert.ok(c.duration >=20 && c.duration<=60); assert.equal(c.review.needsReview,true); }
  const ranked = report.candidates.filter(c => c.rank);
  for (let i=0;i<ranked.length;i++) for (let j=i+1;j<ranked.length;j++) assert.ok(overlap(ranked[i],ranked[j]) < .65);
});
test('model orchestration rejects fabricated proposals and keeps failures visible', async () => {
  const records = sample.filter(r => r.episode === firstEpisode);
  const result = await runPipeline(records,{ mode:'model',generate:async (agent,payload) => agent === 'scout' ? { candidates:[{ title:'valid',...proposal },{ title:'invented',segments:[{ episode:firstEpisode,startId:'bad',endId:'r00006' }] }] } : agent === 'questionPick' ? {question:'Whose signature is on the letter?',evidenceIds:[payload.eligibleIds.at(-1)]} : agent === 'questionProof' ? {supported:true,natural:true,answered:false,central:true,reason:'Supported by the cited source.'} : { reviews:payload.candidates.map(modelReview) } });
  assert.equal(result.summary.proposed,1); assert.equal(result.summary.failures,1); assert.equal(result.summary.partial,true); assert.equal(result.candidates.length,1);
});
test('model failure never silently substitutes the offline baseline', async () => {
  const r = await runPipeline(sample,{ mode:'model',generate:async () => { throw new Error('Provider unavailable'); } });
  assert.equal(r.summary.ranked,0); assert.equal(r.coverage.filter(c => c.status==='failed').length,3); assert.equal(r.mode,'model');
});
test('duplicate critic reviews fail a batch instead of filling in guesses', async () => {
  const r = await runPipeline(sample.slice(0,10),{ mode:'model',generate:async agent => agent==='scout' ? { candidates:[{ title:'one',...proposal }] } : { reviews:[] } });
  assert.equal(r.summary.reviewed,0); assert.equal(r.unreviewed.length,1);
});
test('expired budget produces partial coverage instead of claiming success', async () => {
  const control = new AbortController(); control.abort(new Error('Budget expired'));
  const r = await runPipeline(sample,{ signal:control.signal });
  assert.equal(r.summary.partial,true); assert.equal(r.coverage.length,3); assert.equal(r.summary.ranked,0);
});
test('provider adapter sends JSON contract, retains raw output and never traces key', async () => {
  const original = global.fetch, events = [];
  global.fetch = async (url, init) => {
    assert.equal(url,'https://example.test/v1/chat/completions');
    assert.equal(init.headers.Authorization,'Bearer test-secret');
    assert.equal(JSON.parse(init.body).response_format.type,'json_object');
    return new Response(JSON.stringify({ choices:[{ message:{ content:'{"candidates":[]}' } }],usage:{ total_tokens:12 } }));
  };
  try {
    const r = await callModel('scout',{ records:[] },{ emit:e => events.push(e),signal:new AbortController().signal,config:{ baseURL:'https://example.test/v1',apiKey:'test-secret',model:'test-model' } });
    assert.deepEqual(r,{ candidates:[] }); assert.equal(events.find(e => e.status === 'completed').usage.total_tokens,12); assert.ok(!JSON.stringify(events).includes('test-secret'));
  } finally { global.fetch = original; }
});

test('OpenRouter adapter requires JSON-compatible providers and caps output', async () => {
  const original = global.fetch;
  global.fetch = async (url,init) => {
    assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
    const request = JSON.parse(init.body);
    assert.equal(request.provider.require_parameters,true); assert.equal(request.max_tokens,4096);
    return new Response(JSON.stringify({ choices:[{ message:{ content:'{"candidates":[]}' },finish_reason:'stop' }] }));
  };
  try { await callModel('scout',{}, { emit:()=>{}, signal:new AbortController().signal,config:{ baseURL:'https://openrouter.ai/api/v1',apiKey:'test',model:'provider/model' } }); }
  finally { global.fetch = original; }
});
