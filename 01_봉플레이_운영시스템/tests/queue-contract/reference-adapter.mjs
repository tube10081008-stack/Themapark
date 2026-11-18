// 계약 적합성 시험용 어댑터 인터페이스의 기준 구현.
// 실제 구현(아난티)을 대조할 때는 같은 모양의 모듈을 만들고 QUEUE_IMPL=<경로> 로 지정한다.
//
// export function createQueue({ siteId, accessCode }) → 객체. 각 메서드는 값 또는 Promise 를 반환한다.
//   submit({clientRequestId, consent, serverNow})
//   myStatus({token, serverNow, etaParams?})
//   cancelSelf({token, requestId, serverNow})
//   setCounter({accessCode, counterId, state, requestId, serverNow})
//   callNext({accessCode, counterId, requestId, serverNow})
//   transition({accessCode, entryRef, expectedVersion, action, requestId, reason, serverNow})
//   issueComplete({accessCode, entryRef, expectedVersion, orderId, requestId, serverNow})
//   recordLedger({orderId, rec})            // 시험 준비: 서버 원장 상태를 합성으로 만든다
//   closeDay({accessCode, businessDate, requestId, serverNow})
//   publicBoard({serverNow})
//   staffList({accessCode, serverNow})
//   auditFor({entryRef, from, to})           // → {found, has_order_keys}
//   validSampleSeconds()                     // 선택: 예상시간 표본 대조용
// serverNow 는 ms(epoch). 구현이 DB 시계를 쓰면 어댑터가 시험용 시계 주입 방법을 제공해야 한다.
import { QueueModel } from './reference-model.mjs';

export function createQueue(opts = {}) {
  const m = new QueueModel(opts);
  return {
    submit: (a) => m.submit(a),
    myStatus: (a) => m.myStatus(a),
    cancelSelf: (a) => m.cancelSelf(a),
    setCounter: (a) => m.setCounter(a),
    callNext: (a) => m.callNext(a),
    transition: (a) => m.transition(a),
    issueComplete: (a) => m.issueComplete(a),
    recordLedger: ({ orderId, rec }) => { m.recordLedger(orderId, rec); return { ok: true }; },
    closeDay: (a) => m.closeDay(a),
    publicBoard: (a) => m.publicBoard(a),
    staffList: (a) => m.staffList(a),
    auditFor: ({ entryRef, from, to }) => {
      const hit = m.audit.find((x) => x.kind === 'entry' && x.entry_ref === entryRef && x.from === from && x.to === to);
      return { found: !!hit, has_order_keys: !!hit && hit.old_order_key != null && hit.new_order_key != null && hit.new_order_key > hit.old_order_key };
    },
    validSampleSeconds: () => m.validSamples().map((s) => s.seconds),
    _model: m
  };
}
