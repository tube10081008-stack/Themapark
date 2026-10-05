// Validates training artifacts, not the behavior of the not-yet-integrated chatbot.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {facts, statable} from '../../../06_봉플레이_고객홈페이지/netlify/functions/lib/knowledge.mjs';
const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url),'utf8'));
const catalog=read('knowledge-blocks.json');
const ids=new Set();
for(const block of catalog.blocks){
  assert(!ids.has(block.id),`duplicate ${block.id}`);ids.add(block.id);
  if(block.kind==='fact'){
    assert(block.required_confirmed.length>0);
    for(const id of block.required_confirmed){assert(facts[id],id);assert.equal(facts[id].status,'confirmed',id);assert(facts[id].basis.length,id);}
    for(const match of block.template.matchAll(/\{\{([^}]+)\}\}/g)){
      const id=match[1];assert(block.required_confirmed.includes(id),id);assert(statable(facts[id]),id);
    }
    assert(block.fallback && !/\d/.test(block.fallback),`fallback must not preserve stale numeric facts ${block.id}`);
  } else if(block.kind==='status_notice') assert.equal(facts[block.fact]?.status,block.required_status);
  else assert.equal(block.kind,'policy');
}
const suite=read('conversation-evals.json');
assert(suite.synthetic_only);assert(suite.cases.length>=40);
assert.equal(new Set(suite.cases.map(c=>c.id)).size,suite.cases.length);
for(const c of suite.cases){
  assert(c.turns.length && c.turns.every(t=>t.role==='user'&&t.content));
  for(const id of c.expected.knowledge_ids)assert(ids.has(id),`${c.id}: ${id}`);
  assert.equal(c.result.status,'not_run','Materials must not claim unexecuted behavioral passes');
  assert(c.expected.must_include_meaning.length);
}
assert.equal(read('examples.json').examples.length,6);
console.log(`PASS materials: ${ids.size} blocks reference existing facts; ${suite.cases.length} scenarios remain not_run; 6 paired examples. No chatbot behavior or live model pass claimed.`);
