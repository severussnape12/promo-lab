import test from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../lib/pipeline.js';

const rows = [{ episode:'Fixture', start:0, end:21, text:'ACTION: A quiet morning.' }];
const response = value => Response.json({ choices:[{message:{content:JSON.stringify(value)}}] });

test('429 switches routes with endpoint-specific credentials, and only validated responses become cache hits', async () => {
  const settings = { MODEL_BASE_URL:'https://first.example/v1', MODEL_NAME:'primary', MODEL_API_KEY:'fixture-key-primary', MODEL_FALLBACK_1_BASE_URL:'https://second.example/v1', MODEL_FALLBACK_1_NAME:'secondary', MODEL_FALLBACK_1_API_KEY:'fixture-key-secondary' };
  const saved = Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));
  Object.assign(process.env,settings);
  const originalFetch = global.fetch;
  const requests = [];
  let valid = false;
  global.fetch = async (url, init) => {
    requests.push(url);
    const body = JSON.parse(init.body);
    assert.equal(body.response_format.type,'json_object');
    if (url === 'https://first.example/v1/chat/completions') {
      assert.equal(init.headers.Authorization,'Bearer fixture-key-primary');
      assert.equal(body.model,'primary');
      return new Response('',{status:429,headers:{'retry-after':'900'}});
    }
    assert.equal(url,'https://second.example/v1/chat/completions');
    assert.equal(init.headers.Authorization,'Bearer fixture-key-secondary');
    assert.equal(body.model,'secondary');
    return response({candidates:valid ? [] : [{title:'Invalid',segments:[]}]});
  };
  try {
    const run = input => runPipeline(input,{mode:'model'});
    const invalid = await run(rows);
    assert.equal(invalid.summary.partial,true);
    valid = true;
    const success = await run(rows);
    assert.equal(success.summary.partial,false);
    assert.equal(success.usage.httpAttempts,2);
    assert.equal(success.usage.fallbackSwitches,1);
    const hit = await run(rows);
    assert.equal(requests.length,4);
    assert.equal(hit.usage.cacheHits,1);
    assert.equal(hit.usage.httpAttempts,0);
    assert.equal(hit.events.find(e=>e.status==='cache-hit').model,'secondary');
    assert.ok(!JSON.stringify(success).includes('fixture-key'));
    await run([{...rows[0],text:'A different screenplay.'}]);
    assert.equal(requests.length,6);
    // A permanent failure must not disclose the input to another endpoint.
    global.fetch=async url=>{requests.push(url);return new Response('',{status:401});};
    const failure=await run([{...rows[0],episode:'Auth check'}]);
    assert.equal(failure.usage.fallbackSwitches,0);
    assert.equal(failure.usage.httpAttempts,1);
    assert.equal(failure.summary.partial,true);
  } finally {
    global.fetch=originalFetch;
    for (const [key,value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});
