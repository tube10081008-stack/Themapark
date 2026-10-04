import test from 'node:test';
import assert from 'node:assert/strict';
import {decideConsultation} from '../netlify/functions/lib/decision-engine.mjs';
const env={CONSULT_ENABLED:'true',CONSULT_PROVIDER:'sakana',CONSULT_MODEL:'test-model',SAKANA_API_KEY:'fake-test-key'};
const response=(content,finish_reason='stop')=>new Response(JSON.stringify({choices:[{finish_reason,message:{content:JSON.stringify(content)}}]}));
test('exact topics, sensitive input and missing permission make zero external calls',async()=>{
  let calls=0;const fetcher=async()=>{calls++;throw Error();};
  for(const message of ['요금','환불해 주세요','010-1234-5678','주소 좀 알려주세요'])await decideConsultation(message,{env,fetcher});
  await decideConsultation('요금',{env,fetcher,externalAllowed:true});assert.equal(calls,0);
});
test('Fugu transport and multi-topic answer use only reviewed knowledge',async()=>{
  let calls=0;const r=await decideConsultation('입장 비용과 찾아가는 곳을 알려주세요',{env,externalAllowed:true,fetcher:async(url,opts)=>{
    calls++;assert.equal(url,'https://api.sakana.ai/v1/chat/completions');const body=JSON.parse(opts.body);assert.equal(body.model,'test-model');assert.equal(body.response_format.type,'json_schema');assert.equal(opts.redirect,'error');return response({ids:['price','location'],clarify:false});
  }});assert.equal(calls,1);assert.match(r.answer,/21,000/);assert.match(r.answer,/유록길 22/);
});
test('unknown, duplicate, extra prose, empty, excessive and contradictory selections fail closed',async()=>{
  for(const selected of [{ids:['unknown'],clarify:false},{ids:['price','price'],clarify:false},{ids:['price'],clarify:false,answer:'무료'},{ids:[],clarify:false},{ids:['price'],clarify:true},{ids:['price','hours','location','group'],clarify:false}]){
    const r=await decideConsultation('알려주세요',{env,externalAllowed:true,fetcher:async()=>response(selected)});assert.equal(r.intent,'other');
  }
});
test('provider failure, truncated output and oversized response do not leak provider text',async()=>{
  for(const fetcher of [async()=>{throw Error('SECRET');},async()=>response({ids:['price'],clarify:false},'length'),async()=>new Response('x'.repeat(33000))]){
    const r=await decideConsultation('알려주세요',{env,externalAllowed:true,fetcher});assert.equal(r.intent,'other');assert.doesNotMatch(JSON.stringify(r),/SECRET/);
  }
});
test('another adapter can satisfy the same contract without changing knowledge or policy',async()=>{
  const r=await decideConsultation('알려주세요',{env:{...env,CONSULT_PROVIDER:'synthetic'},externalAllowed:true,providerRegistry:{synthetic:async()=>({ids:['hours'],clarify:false})}});assert.match(r.answer,/확정 후/);
});
