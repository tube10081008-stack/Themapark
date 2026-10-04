(() => {
  const button=document.createElement('button');button.className='consult-open';button.textContent='AI 상담';button.type='button';
  const dialog=document.createElement('dialog');dialog.className='consult-dialog';dialog.setAttribute('aria-labelledby','consult-title');
  dialog.innerHTML='<h2 id="consult-title">봉플레이 상담 안내</h2><p>AI 자동 안내 · 직원 실시간 상담은 아닙니다.</p><p>전화번호·이름·예약번호 등 개인정보는 입력하지 마세요. AI 연결 시 질문은 TypeSafe로 전송될 수 있습니다.</p><div class="consult-log" role="log" aria-live="polite"></div><div class="consult-topics"></div><form><label for="consult-question">궁금한 점</label><textarea id="consult-question" maxlength="1200" required rows="3"></textarea><button type="submit">문의하기</button><button type="button" class="consult-close">닫기</button></form><a href="tel:01059314144">담당자 전화 문의</a>';
  document.body.append(button,dialog);
  const log=dialog.querySelector('.consult-log'),form=dialog.querySelector('form'),input=dialog.querySelector('textarea'),submit=dialog.querySelector('[type=submit]');
  function line(text){const p=document.createElement('p');p.textContent=text;log.append(p);while(log.children.length>20)log.firstChild.remove();log.scrollTop=log.scrollHeight;}
  button.addEventListener('click',()=>{dialog.showModal();input.focus();});dialog.querySelector('.consult-close').addEventListener('click',()=>dialog.close());
  for(const topic of ['요금','운영시간','위치','시설','예약','단체']){const b=document.createElement('button');b.type='button';b.textContent=topic;b.addEventListener('click',()=>{input.value=topic;form.requestSubmit();});dialog.querySelector('.consult-topics').append(b);}
  let busy=false;
  form.addEventListener('submit',async event=>{event.preventDefault();if(busy||!input.value.trim())return;busy=true;submit.disabled=true;const message=input.value.trim();line('나: '+message);input.value='';
    try{const res=await fetch('/.netlify/functions/consult',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message}),signal:AbortSignal.timeout(9000)});const data=await res.json();if(!res.ok||typeof data.answer!=='string')throw Error();line((data.mode==='jev'?'AI 안내: ':'기본 안내: ')+data.answer);line(data.source);}
    catch{line('상담 서버에 연결하지 못했습니다. 요금·시설 안내는 홈페이지에서 확인하시고 개별 문의는 전화로 부탁드립니다. 문의가 접수된 상태는 아닙니다.');}
    finally{busy=false;submit.disabled=false;input.focus();}
  });
})();
