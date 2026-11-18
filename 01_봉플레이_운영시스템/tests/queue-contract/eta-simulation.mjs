// CLAUDE-011 — 예상시간 계산 시뮬레이션 표 (합성 표본, 운영 실측 아님).
// 실행: node 01_봉플레이_운영시스템/tests/queue-contract/eta-simulation.mjs
// 고정 처리량을 가정하지 않는다. 표본 분포를 바꿔 계산식의 반응만 보여 준다.
import { computeEta } from './reference-model.mjs';

const profiles = {
  '표본A 4~6분': [240, 270, 300, 330, 360],
  '표본B 2~10분(편차 큼)': [120, 180, 300, 420, 600],
  '표본 부족(4건)': [240, 270, 300, 330]
};
const counterSets = {
  '1창구 비어 있음': [{ kind: 'idle' }],
  '1창구 처리 1분 경과': [{ kind: 'serving', elapsed_seconds: 60 }],
  '2창구(처리 중+빈 창구)': [{ kind: 'serving', elapsed_seconds: 60 }, { kind: 'idle' }],
  '3창구 동시 완료(모두 빔)': [{ kind: 'idle' }, { kind: 'idle' }, { kind: 'idle' }],
  '창구 전부 정지': []
};
const fmt = (r) => (r.state === 'range' ? `${r.min_minutes}~${r.max_minutes}분` : r.state === 'estimating' ? '집계 중' : r.state === 'paused' ? '일시 중지' : r.state);
const aheads = [0, 1, 3, 6];
for (const [pn, samples] of Object.entries(profiles)) {
  console.log(`\n### ${pn}`);
  console.log(`| 창구 상태 | ${aheads.map((a) => `앞 ${a}팀`).join(' | ')} |`);
  console.log(`|---|${aheads.map(() => '---').join('|')}|`);
  for (const [cn, work] of Object.entries(counterSets)) {
    console.log(`| ${cn} | ${aheads.map((a) => fmt(computeEta({ samples, counterWork: work, aheadWaiting: a, serverNow: 0 }))).join(' | ')} |`);
  }
}
