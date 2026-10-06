// Independent QA runner. Never imports or edits the application implementation.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export async function runSuite(suite, {transport, sourceCommit, mode='mock', ids,
  pause=async()=>{}, now=()=>Date.now(), maxDurationMs=600000}={}) {
  if(!suite.synthetic_only || typeof transport!=='function')throw Error('Synthetic suite and transport required');
  if(!/^[a-f0-9]{40}$/.test(sourceCommit||''))throw Error('Exact implementation SHA required');
  if(!['mock','live','local'].includes(mode))throw Error('Unknown execution mode');
  const started=now(), results=[];
  const selected=ids?suite.cases.filter(c=>ids.includes(c.id)):suite.cases;
  if(ids && (new Set(ids).size!==ids.length || selected.length!==ids.length))throw Error('Unknown or repeated case ID');
  for(const c of selected){
    const result={id:c.id,category:c.category,status:'not_run',turns:[],expected:c.expected,
      semantic_review:{status:'pending',scores:null,notes:null}};
    results.push(result);
    if(c.fixture){result.reason='requires_isolated_fixture_or_browser';continue;}
    if(now()-started>=maxDurationMs){result.reason='suite_time_budget';continue;}
    // Cases are isolated. Carry only actual successful replies within this case.
    let history=[];result.status='executed';
    for(const turn of c.turns){
      if(now()-started>=maxDurationMs){result.status='incomplete';result.reason='suite_time_budget';break;}
      const start=now();
      try{
        const response=await transport({message:turn.content,history:structuredClone(history)});
        const body=response.body;
        const valid=response.status===200 && body && typeof body.answer==='string' && body.answer.length>0;
        const item={question:turn.content,status:response.status,duration_ms:now()-start,
          response:body,checks:{successful_answer:valid}};
        result.turns.push(item);
        if(!valid){result.status='failed';result.reason='request_or_response_failure';break;}
        history.push({role:'user',content:turn.content},{role:'assistant',content:body.answer});
        history=history.slice(-6).map(t=>({...t,content:t.content.slice(0,800)}));
        while(history.reduce((n,t)=>n+t.content.length,0)>3200)history.shift();
        await pause();
      }catch{
        // Do not persist transport exception text (could contain credentials/URLs).
        result.status='failed';result.reason='transport_error';
        result.turns.push({question:turn.content,duration_ms:now()-start,error:'transport_error'});break;
      }
    }
    const last=result.turns.at(-1)?.response;
    if(result.status==='executed'){
      result.contract_checks={
        action_matches:last.action===c.expected.action,
        required_knowledge_present:c.expected.knowledge_ids.every(id=>last.knowledge_ids?.includes(id)),
        model_used:result.turns.some(t=>t.response?.mode==='model'),
      };
      result.status='needs_review'; // HTTP success is never a CS-quality pass.
    }
  }
  return {schema:1,suite_version:suite.version,source_commit:sourceCommit,execution_mode:mode,
    started_at:new Date(started).toISOString(),finished_at:new Date(now()).toISOString(),
    summary:{selected:results.length,needs_review:results.filter(r=>r.status==='needs_review').length,
      failed:results.filter(r=>r.status==='failed').length,not_run:results.filter(r=>r.status==='not_run').length,
      quality_passes:0},results};
}

export function validateEndpoint(value,live){
  const u=new URL(value);
  if(u.username||u.password||u.search||u.hash)throw Error('Endpoint cannot contain credentials, query, or fragment');
  if(live){if(u.protocol!=='https:')throw Error('Live endpoint requires HTTPS');}
  else if(u.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Remote calls require explicit --live');
  if(u.pathname!=='/.netlify/functions/consult')throw Error('Use the consult function endpoint');
  return u.href;
}

async function main(){
  const args=process.argv.slice(2);const get=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
  if(args.includes('--help')){
    console.log('node run-conversation-evals.mjs --endpoint URL --sha FULL_SHA --out NEW_JSON [--live] [--cases CS-001,CS-003]');return;
  }
  const live=args.includes('--live'),endpoint=validateEndpoint(get('--endpoint'),live),out=get('--out');
  if(!out||fs.existsSync(out))throw Error('New output path required');
  const suite=JSON.parse(fs.readFileSync(new URL('conversation-evals.json',import.meta.url),'utf8'));
  const report=await runSuite(suite,{sourceCommit:get('--sha'),mode:live?'live':'local',
    ids:get('--cases')?.split(','),pause:()=>new Promise(resolve=>setTimeout(resolve,live?7000:0)),
    transport:async input=>{
      const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
      // Bound response before parsing, just as the client must.
      const reader=response.body?.getReader();if(!reader)throw Error('Missing body');
      const chunks=[];let size=0;
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw Error('Response too large');}chunks.push(value);}
      const bytes=Buffer.concat(chunks);const body=JSON.parse(bytes.toString('utf8'));
      // Keep only fields needed for customer-visible QA, never raw diagnostics.
      const clean={};for(const k of ['answer','action','knowledge_ids','mode','reason','code'])if(Object.hasOwn(body,k))clean[k]=body[k];
      return {status:response.status,body:clean};
    }});
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report.summary));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Evaluation failed. Check arguments, endpoint and new output path; secrets are not printed.');process.exitCode=1;});
