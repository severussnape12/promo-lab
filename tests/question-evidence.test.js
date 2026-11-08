import test from 'node:test';
import assert from 'node:assert/strict';
import { groundQuestion } from '../lib/question-evidence.js';
const rows=[
  {id:'partial',start:19,end:21,text:'GUARD: Listen to me.'},
  {id:'next',start:25,end:27,text:"PILOT: That flare is my signal."},
  {id:'swell',start:28,end:30,text:'SOUND FX: The bells swell.'},
];
const clip={segments:[{episode:'Fixture',start:20,end:30,records:rows}]};
const review=()=>({cliffhanger:4,endingStrategy:'before_reveal',risks:[]});
test('a natural question keeps exact evidence; verifier receives only cited records',async()=>{
  const r=review(); await groundQuestion(clip,r,async(agent,p)=>{
    if(agent==='questionPick'){assert.deepEqual(p.eligibleIds,['next']);return {question:'Will the pilot see the flare in time?',evidenceIds:['next']};}
    assert.deepEqual(Object.keys(p).sort(),['evidence','question']);
    assert.deepEqual(p.evidence,[rows[1]]);
    return {supported:true,natural:true,answered:false,central:true,reason:'The pilot identifies the flare as her signal.'};
  },()=>{});
  assert.equal(r.viewerQuestion,'Will the pilot see the flare in time?');assert.deepEqual(r.questionEvidence,[rows[1]]);
});
test('unsupported premises and parroting cannot survive two failed drafts',async()=>{
  const r=review();let drafts=0;
  await groundQuestion(clip,r,async(agent)=>{
    if(agent==='questionProof')return {supported:false,natural:true,answered:false,central:true,reason:'No secret is established.'};
    drafts++;return {question:drafts===1?'When will she learn his secret?':'What happens after she looks up?',evidenceIds:['next']};
  },()=>{});
  assert.equal(drafts,2);assert.equal(r.viewerQuestion,'');assert.equal(r.cliffhanger,0);
});
test('uncitable lines get one rewrite and abstention prevents ranking',async()=>{
  const r=review();
  await groundQuestion(clip,r,async(agent,p)=>{assert.equal(agent,'questionPick');return p.revision ? {question:null} : {question:'What will she hear?',evidenceIds:['partial','swell']};},()=>{});
  assert.equal(r.viewerQuestion,'');assert.equal(r.cliffhanger,0);
});
test('a well-phrased but already answered question is withheld',async()=>{
  const r=review();await groundQuestion(clip,r,async(agent)=>agent==='questionPick'?{question:'Whose signal is the flare?',evidenceIds:['next']}:{supported:true,natural:true,answered:true,central:true,reason:'The pilot identifies the signal as hers.'},()=>{});
  assert.equal(r.viewerQuestion,'');assert.equal(r.cliffhanger,0);
});
test('a spoken fear keeps its meaning while switching to the viewer’s perspective',async()=>{
  const fear={id:'fear',start:21,end:24,text:'MARA (Frightened): "What if I lose everything?"'};
  const r=review();await groundQuestion({segments:[{start:20,end:30,records:[fear]}]},r,async (agent,p)=>{
    assert.equal(agent,'spokenFear');assert.equal(p.options[0].question,'Is Mara going to lose everything?');return {id:'fear'};
  },()=>{});
  assert.equal(r.viewerQuestion,'Is Mara going to lose everything?');assert.deepEqual(r.questionEvidence,[fear]);
});
