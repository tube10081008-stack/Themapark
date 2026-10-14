// 계약 v1 상태 ↔ ANT-006 상태 대응표 (벤 지시 2026-10-09).
// 이름만 연결한다. 전이 조건·검증 조건은 계약 그대로 적용하며 완화하지 않는다.
export const CONTRACT_TO_IMPL = Object.freeze({
  waiting: 'waiting',
  called: 'called',
  serving: 'processing',
  held: 'no_show',
  cancelled: 'canceled',
  issued: 'issued',
  closed: null // ANT-006 에 대응 상태 없음 (계약 §8 영업일 종료) — 별도 차이로 보고
});
export const IMPL_TO_CONTRACT = Object.freeze(
  Object.fromEntries(Object.entries(CONTRACT_TO_IMPL).filter(([, v]) => v).map(([k, v]) => [v, k]))
);
export const impl = (contractState) => {
  const v = CONTRACT_TO_IMPL[contractState];
  if (!v) throw new Error(`구현에 대응 상태 없음: ${contractState}`);
  return v;
};
