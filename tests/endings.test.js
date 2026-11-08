import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, resolveSegments } from '../lib/input.js';
import { endingOptions, selectEnding } from '../lib/endings.js';
import { runPipeline, baselineReview } from '../lib/pipeline.js';

// Synthetic illustration, not additional events asserted about the user's example.
const rows = [
  { id:'hook',episode:'e',start:0,end:3,text:'WIFE: Are you lying to me about where you go every night?' },
  { id:'follow',episode:'e',start:3,end:12,text:'ACTION: She follows her husband to a hotel.' },
  { id:'approach',episode:'e',start:12,end:20,text:'ACTION: She hears him speaking through a closed door.' },
  { id:'door',episode:'e',start:20,end:24,text:'ACTION: Her hand reaches for the handle.' },
  { id:'reveal',episode:'e',start:24,end:28,text:'ACTION: She opens the door and sees her husband kissing another woman.' },
  { id:'reaction',episode:'e',start:28,end:32,text:'ACTION: She gasps, freezes, and takes off her wedding ring.' },
  { id:'resolution',episode:'e',start:32,end:38,text:'WIFE: All is forgiven. Everything is fine.' },
];
const source = normalize(rows);
const c = { id:'c',...resolveSegments({ segments:[{episode:'e',startId:'hook',endId:'reveal'}] },source) };
c.endingOptions = endingOptions(c,source);
function review(candidate, selected='reaction') {
  return { candidateId:candidate.id,selectedEndId:selected,endingStrategy:'reaction',questionEvidenceIds:['reveal','reaction'],viewerQuestion:'Will she confront him or leave the marriage?',cutReason:'The discovery confirms the betrayal; removing the ring makes her next action the unanswered question.',alternativeCuts:candidate.endingOptions.map(o => ({endId:o.endId,reason:o.endId === selected ? 'Creates a concrete question about her response.' : 'Withholds the discovery or stops before her consequential reaction.'})),hook:4,cliffhanger:4,clarity:4,emotion:4,hookId:'hook',cliffhangerId:selected,why:'Suspicion builds to discovery and an unresolved response.',risks:[],needsReview:false };
}

test('offers legal before-reveal, reveal and reaction boundaries with exact durations', () => {
  assert.deepEqual(c.endingOptions.map(o => o.endId),['reveal','door','reaction']);
  assert.deepEqual(c.endingOptions.map(o => o.duration),[28,24,32]);
  const chosen = selectEnding(c,review(c));
  assert.equal(chosen.duration,32); assert.equal(chosen.originalEndId,'reveal');
});
test('model pipeline accepts a post-reveal reaction and updates exported cut/evidence', async () => {
  let calls=0;
  const result = await runPipeline(rows,{mode:'model',generate:async (agent,payload) => {
    calls++;
    if (agent==='questionPick') return {question:'Will she leave him?',evidenceIds:['reveal','reaction']};
    if (agent==='questionProof') return {supported:true,natural:true,answered:false,central:true,reason:'The discovery and ring removal establish the stakes.'};
    return agent==='scout' ? {candidates:[{title:'Discovery',segments:[{episode:'e',startId:'hook',endId:'reveal'}]}]} : {reviews:payload.candidates.map(c => review(c))};
  }});
  assert.equal(calls,4); assert.equal(result.summary.failures,0); assert.equal(result.summary.ranked,1);
  const promo=result.candidates[0];
  assert.equal(promo.segments[0].end,32); assert.equal(promo.review.cliffhangerId,'reaction');
  assert.match(promo.review.cliffhangerText,/wedding ring/);
});
test('cut editor cannot invent an option or omit comparison evidence', () => {
  assert.throws(() => selectEnding(c,review(c,'invented')),/outside/);
  assert.throws(() => selectEnding(c,{...review(c),alternativeCuts:[]}),/every supplied/);
  assert.throws(() => selectEnding(c,{...review(c),endingStrategy:'resolved'}),/specific unresolved/);
});
test('fully resolved endings can be reported but cannot pass the curiosity gate', async () => {
  const result=await runPipeline(rows,{mode:'model',generate:async (agent,payload) => agent==='scout' ? {candidates:[{title:'Resolved',segments:[{episode:'e',startId:'hook',endId:'resolution'}]}]} : {reviews:payload.candidates.map(c => ({...review(c,'resolution'),endingStrategy:'resolved',viewerQuestion:'',cliffhanger:0}))}});
  assert.equal(result.summary.failures,0); assert.equal(result.summary.ranked,0); assert.equal(result.candidates[0].status,'rejected');
});
test('a resolved earlier beat does not automatically reject later new curiosity in baseline', () => {
  const modified=normalize(rows.map(r => r.id==='follow' ? {...r,text:'HUSBAND: Everything is fine.'} : r));
  const clip={id:'c',...resolveSegments({segments:[{episode:'e',startId:'hook',endId:'reaction'}]},modified)};
  assert.ok(baselineReview(clip).cliffhanger>=3);
});
test('nearby alternatives never break duration or repeat earlier montage footage', () => {
  const long=normalize([{id:'a',episode:'e',start:0,end:3,text:'WIFE: Stop!'}, {id:'b',episode:'e',start:55,end:60,text:'ACTION: A reveal.'}, {id:'c',episode:'e',start:60,end:65,text:'ACTION: She gasps.'}]);
  const original={id:'x',...resolveSegments({segments:[{episode:'e',startId:'a',endId:'b'}]},long)};
  assert.ok(endingOptions(original,long).every(o=>o.duration<=60));
  const montage={id:'m',...resolveSegments({segments:[{episode:'e',startId:'reaction',endId:'resolution'},{episode:'e',startId:'hook',endId:'reveal'}]},source)};
  assert.ok(!endingOptions(montage,source).some(o=>o.endId==='reaction'));
});
