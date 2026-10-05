import test from 'node:test';
import assert from 'node:assert/strict';
import {runSuite,validateEndpoint} from './run-conversation-evals.mjs';
const sourceCommit='a'.repeat(40);
const makeCase=(id,turns,fixture=null)=>({id,category:'context',turns:turns.map(content=>({role:'user',content})),fixture,expected:{action:'answer',knowledge_ids:['price.guardian']}});
const suite=cases=>({synthetic_only:true,version:'test',cases});
test('uses real previous reply; never leaks context between cases or reports quality pass',async()=>{
  const requests=[];
  const r=await runSuite(suite([makeCase('1',['first','follow-up']),makeCase('2',['new visitor'])]),{sourceCommit,transport:async input=>{
    requests.push(input);return {status:200,body:{answer:'actual reply '+requests.length,action:'answer',knowledge_ids:['price.guardian'],mode:'model'}};
  }});
  assert.deepEqual(requests[1].history,[{role:'user',content:'first'},{role:'assistant',content:'actual reply 1'}]);
  assert.deepEqual(requests[2].history,[]);assert.equal(r.summary.quality_passes,0);assert.equal(r.summary.needs_review,2);
});
test('fixtures never run against ordinary endpoint',async()=>{
  let calls=0;const r=await runSuite(suite([makeCase('1',['x'],{store:'down'})]),{sourceCommit,transport:async()=>{calls++;}});
  assert.equal(calls,0);assert.equal(r.results[0].status,'not_run');
});
test('failed replies stop a case and exception text is never logged',async()=>{
  let calls=0;const r=await runSuite(suite([makeCase('1',['x','y']),makeCase('2',['z'])]),{sourceCommit,transport:async()=>{
    calls++;if(calls===1)return {status:429,body:{code:'RATE_LIMIT_EXCEEDED'}};throw Error('private-token-must-not-appear');
  }});
  assert.equal(calls,2);assert.equal(r.summary.failed,2);assert(!JSON.stringify(r).includes('private-token'));
});
test('history bounded and time budget is explicit',async()=>{
  const requests=[];let time=0;
  const r=await runSuite(suite([makeCase('1',Array(20).fill('q')),makeCase('2',['z'])]),{sourceCommit,now:()=>time,maxDurationMs:5,
    pause:async()=>{time++;},transport:async input=>{requests.push(input);return {status:200,body:{answer:'x'.repeat(1200)}};}});
  assert(requests.every(q=>q.history.length<=6 && q.history.reduce((n,t)=>n+t.content.length,0)<=3200));
  assert.equal(r.results[0].status,'incomplete');assert.equal(r.results[1].reason,'suite_time_budget');
});
test('remote, credential and malformed selection safeguards',async()=>{
  assert.throws(()=>validateEndpoint('https://example.test/.netlify/functions/consult',false));
  assert.throws(()=>validateEndpoint('https://user:secret@example.test/.netlify/functions/consult',true));
  assert.throws(()=>validateEndpoint('https://example.test/.netlify/functions/consult?token=x',true));
  assert.equal(validateEndpoint('http://127.0.0.1:4173/.netlify/functions/consult',false),'http://127.0.0.1:4173/.netlify/functions/consult');
  await assert.rejects(()=>runSuite(suite([makeCase('1',['q'])]),{sourceCommit,ids:['missing'],transport:async()=>{}}));
});
