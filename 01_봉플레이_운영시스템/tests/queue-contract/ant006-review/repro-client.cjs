// CLAUDE-011 검토: ANT-006 bongplay-queue.js(0ea7b61) 클라이언트 재현 — 온라인인데 서버 RPC 가 실패하면?
// 실행: node repro-client.cjs <01_봉플레이_운영시스템/assets/bongplay-queue.js 경로> 2>/dev/null
console.warn = () => {};
const path = process.argv[2];
const results = [];
for (const [label, rpcImpl] of [
  ['rpc_returns_error (예: 함수 미적용·권한 거부·FK 위반)', async () => ({ ok: false, status: 404, error: 'function not found' })],
  ['rpc_throws (네트워크 오류)', async () => { throw new Error('network'); }]
]) {
  delete require.cache[require.resolve(path)];
  global.window = { BongplaySync: { isOnline: () => true, rpc: rpcImpl } };
  global.navigator = { onLine: true };
  require(path);
  const Q = global.window.BongplayQueue || global.BongplayQueue;
  results.push({ case: label, run: Q });
}
(async () => {
  const out = [];
  for (const r of results) {
    const Q = r.run;
    const a = await Q.enqueueConsent({ id: 'cst_X1', guardian_phone: '010-0000-1111', children: [] });
    const b = await Q.enqueueConsent({ id: 'cst_X2', guardian_phone: '010-0000-2222', children: [] });
    const called = await Q.callNext(1, 'desk');
    out.push({ case: r.case,
      enqueue_ok: a.ok, enqueue_source: a.source, number_shown: a.item && (a.item.formatted_number || a.item.queue_number),
      second_number: b.item && (b.item.formatted_number || b.item.queue_number),
      staff_callNext_ok: called && called.ok, staff_callNext_source: called && called.item ? 'local_store' : null });
  }
  console.log(JSON.stringify(out, null, 1));
})();
