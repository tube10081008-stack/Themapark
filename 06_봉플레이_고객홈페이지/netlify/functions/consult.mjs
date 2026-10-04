import { consult } from './lib/consultation.mjs';
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
export default async function handler(request) {
  if(request.method!=='POST') return json({error:'POST 요청만 지원합니다.'},405);
  if(!request.headers.get('content-type')?.startsWith('application/json')) return json({error:'JSON 형식이 필요합니다.'},415);
  // Origin is browser CSRF protection, not authentication or a cost-control boundary.
  const origin=request.headers.get('origin');
  if(origin && origin!==new URL(request.url).origin) return json({error:'허용되지 않은 출처입니다.'},403);
  if(Number(request.headers.get('content-length'))>8192) return json({error:'질문이 너무 깁니다.'},413);
  try {
    const reader=request.body?.getReader();if(!reader)return json({error:'질문을 입력해 주세요.'},400);
    const chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();return json({error:'질문이 너무 깁니다.'},413);}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
    const input=JSON.parse(new TextDecoder().decode(bytes));
    return json(await consult(input.message,{env:process.env}));
  }catch{return json({error:'질문은 1~1,200자로 입력해 주세요.'},400);}
}
