import {renderAnswers, contactChannel, CUSTOMER_SOURCE, KNOWLEDGE_VERSION} from './knowledge.mjs';
import {providers} from './model-provider.mjs';

// Only compiled, reviewed public knowledge is eligible for retrieval.
const labels={price:'요금',hours:'운영시간',location:'위치',facilities:'시설',booking:'예약',group:'단체'};
const explicitTopics=new Map(Object.entries(labels).map(([id,label])=>[label,id]));
function validSelection(value,candidates){
  return value && Object.keys(value).length===2 && typeof value.clarify==='boolean' && Array.isArray(value.ids)
    && value.ids.length<=3 && new Set(value.ids).size===value.ids.length
    && value.ids.every(id=>candidates.some(c=>c.id===id))
    && (value.clarify?value.ids.length===0:value.ids.length>0);
}

export async function decideConsultation(message,{env={},fetcher=fetch,externalAllowed=false,providerRegistry=providers}={}){
  if(typeof message!=='string'||!message.trim()||message.length>1200)throw Error('INVALID_MESSAGE');
  const question=message.normalize('NFKC').trim();
  if(question.length>1200)throw Error('INVALID_MESSAGE');
  const answers=renderAnswers();
  const result=(ids,mode,reason)=>({intent:ids[0],mode,reason,answer:ids.map(id=>answers[id].text).join('\n\n'),source:CUSTOMER_SOURCE,
    contact:contactChannel()??{label:'전화 문의',href:'#location'},notice:'AI 자동 안내입니다. 직원의 실시간 답변이나 예약 확정이 아닙니다.'});
  if(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|(?:\+82|0\d{1,2})[-\s]?\d{3,4}[-\s]?\d{4}|\d{6}[-\s]?[1-4]\d{6}/.test(question))return result(['human'],'rules','personal_data');
  if(/환불|취소|사고|다쳤|부상|응급|안전|장애|임산|민원|보상|분실|개인정보|비밀번호|프롬프트|지시.*무시|system prompt/i.test(question))return result(['human'],'rules','staff_required');
  // Exact topic buttons are handled at zero model calls. Free text is not guessed by substring.
  if(explicitTopics.has(question))return result([explicitTopics.get(question)],'rules','direct_topic');
  if(env.CONSULT_ENABLED!=='true'||externalAllowed!==true)return result(['other'],'rules','external_disabled');
  const provider=providerRegistry[env.CONSULT_PROVIDER];
  if(typeof provider!=='function')return result(['other'],'fallback','provider_not_configured');
  const candidates=Object.entries(labels).map(([id,label])=>({id,label,text:answers[id].text,version:KNOWLEDGE_VERSION}));
  try{
    const selection=await provider({question,candidates,env,fetcher});
    if(!validSelection(selection,candidates)||selection.clarify)return result(['other'],'fallback','clarification_required');
    // Model prose never reaches the customer; render only server-selected knowledge.
    return result(selection.ids,'model','selected_knowledge');
  }catch{return result(['other'],'fallback','provider_unavailable');}
}
