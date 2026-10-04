# ANT-004 — 봉플레이 JEV 상담 런타임·호출제한·수동배포 검증 보고서 (R1 보완 완결)

- **작업 ID**: ANT-004
- **담당자**: 아난티 (Antigravity, Google Pro)
- **오케스트레이터**: 벤 (Ben)
- **대상 PR**: PR #31 (`ben/BEN-015-jev-consultation`)
- **기준 브랜치 및 커밋**: `origin/ben/BEN-015-jev-consultation` (`c935504ef7e87a700b7f8a99b1fc6daf60035186`, R1 검토 및 대표 결정 반영 최신)
- **작업 브랜치**: `antigravity/ANT-004-jev-runtime`
- **검증 환경**: Node.js v24.18.0 (`agy-node`), Windows PowerShell, Google Chrome Headless (`--headless=new` via Chrome DevTools Protocol), 로컬 HTTP 서버 (`127.0.0.1:4188`)

---

## 1. 벤 R1 검토 피드백 반영 및 조치 현황

벤의 1차 검토서(`docs/qa/BEN-015_R1_세에이전트_검토.md`)에서 지적된 6개 항목을 전수 보완하였습니다:

### 1.1 [시간 기록 정정] 과거 추정치 정정 및 단조 타이머 기반 실측
- **과거 기록 정정**: 1차 보고서(커밋 745e1ef)에 기재되었던 "착수 00:00, 완료 00:35, 35분" 기록은 커밋 타임스탬프(`00:18:18` 지시서, `00:32:23` 커밋) 대조 전 작성된 비보정 추정치였으므로, **"착수 시점 단조 타이머 미측정 / 확인 불가"**로 공식 정정합니다.
- **R1 보완 작업 실측치**:
  - 시작 시스템 시각: `2026-10-05T00:39:04+09:00`
  - 완료 시스템 시각: `2026-10-05T00:43:30+09:00`
  - 단조 타이머(`performance.now`) 기반 실제 작업 소요시간: **4분 26초** (외부 대기 0초, 재작업 0초)

### 1.2 [P1 저장소 응답 오류 시 외부 호출 허용 차단] Redis 파이프라인 엄격 검증
- **문제점 분석**: 과거 코드 `Number(results[0/2]?.result || 1)`로 인해 Redis가 빈 배열 `[]` 또는 에러 객체 `[{error:'ERR'}, ...]`를 반환할 때 `1`로 평가되어 요청이 통과(`allowed:true, allowExternal:true`)되는 취약점이 존재했습니다.
- **수정 내용 (`rate-limit.mjs`)**:
  - 파이프라인 배치 실행 결과 배열 길이 검증 (`results.length >= 4`).
  - 개별 명령(0~3단계) 객체 내 `error` 속성 존재 여부 전수 검사 (`'error' in item` 시 즉시 예외 투하).
  - 카운터 결과가 반드시 양의 안전 정수(`Number.isSafeInteger(val) && val > 0`)인지 검증.
  - 만료시간(EXPIRE) 결과 검증 (`1` 또는 `'OK'`).
  - Redis 파이프라인은 일괄 배치 전송(batched execution)이며 ACID 원자적 트랜잭션이 아니므로, 어느 한 단계라도 실패하면 즉시 예외를 발생시키고 `checkRateLimit`의 `catch` 블록에서 **`allowExternal = false` (외부 유료 API 호출 0건 유지)**를 강제 적용.
- **검증**: `1-6` 자동화 시험에서 `[]`, `[{error:'ERR'}, ...]`, 음수, 비정수 응답에 대해 전수 차단(429 반환 및 외부 호출 0건) 입증.

### 1.3 [P1 메모리 우회 플래그 제거 및 한도 파싱/용어 정정]
- **메모리 우회 플래그 제거**: `ALLOW_MEMORY_STORE_FOR_JEV` 환경변수를 운영 로직에서 완전 제거. `JEV_ENABLED === 'true'`일 때 분산 저장소(Redis) 연결 정보가 없으면 예외 없이 `allowExternal = false`를 강제.
- **한도 설정값 의미 명확화 (`parsePositiveLimit`)**:
  - `0` 또는 음수: 모든 요청을 전면 차단 (`RATE_LIMIT_BLOCKED`, 429 반환).
  - `NaN`, `Infinity`, 미설정: 안전 기본값(분당 10, 일일 500)으로 자동 복원.
- **용어 정정**: 공급자/호스팅/네트워크 고정비가 존재하는 환경에서 부적절한 "$0 과금 보장" 문구를 전면 삭제하고, **"저장소 미설정 및 통신 장애 시 외부 유료 JEV API 호출 차단 (외부 API 호출 0건 유지)"**로 정확히 기술.

### 1.4 [시험 보고 정확성 및 9초 타임아웃 실측]
- **시나리오 수 집계 명확화**:
  - 상위 테스트 묶음(2개)을 제외한 **독립 하위 시나리오는 총 25개** (기존 지식 계약 9개 + 레이트리미트/과금방어 8개 + 브라우저 실측 8개). 상위 묶음 포함 시 총 27개 테스트 항목 전수 통과.
- **실제 9초 타임아웃 흐름 실측 (`runtime.test.mjs` 2-6)**:
  - 서버에서 응답을 9.6초 지연시키고, 클라이언트 `AbortSignal.timeout(9000)`에 의해 9초 경과 시 `TimeoutError`가 발생하는 전체 플로우를 실제 Chrome 브라우저에서 실측(9,198ms 소요).
  - "상담 응답 시간이 초과되었습니다 (9초). 잠시 후 다시 시도해 주세요." 안내 메시지 출력 및 전송 버튼 재활성화(`disabled=false`) 검증 완료.
- **시간 상한 명시**: 상위 시험 300,000ms(5분), 하위 시험 60,000ms(60초) 타임아웃 명시적 설정.

### 1.5 [배포 문서 개정 (`DEPLOY.md`)]
- "Drop은 함수가 항상 누락된다"는 단정적 표현을 삭제하고, 지오(GEO-006)의 배포 관찰과 구분하여 `06_봉플레이_고객홈페이지`의 서버리스 함수 수동 배포는 **실제 배포 미검증(미실행) 상태**임을 명시.
- 1단계 Preview 초안 배포(`npx netlify deploy --dir=. --functions=netlify/functions`) 후 스모크 테스트를 거쳐 정식 승인 시에만 2단계 프로덕션 승격(`--prod`)을 수행하도록 운영 배포 분리. 외부 실제 배포 금지 원칙 재확인.

### 1.6 [화면 및 서버 신뢰성 보강]
- **한글 IME 조합 중 Enter 전송 방지**: `e.isComposing || e.keyCode === 229`일 때 폼 제출을 방지하여 조합 문자 중복 전송 방어 (브라우저 시험 2-4 검증).
- **HTTP 429 안내 구분**: 분당 제한 초과 시 "1분 후 다시 시도" 안내 vs 일일 쿼터 마감 시 "오늘 상담 안내 한도가 마감되었습니다" 안내 차등 표출 (브라우저 시험 2-5 검증).
- **입력 오류와 서버 오류 구분**: HTTP 400/413/415는 "입력 오류:", 5xx는 "서버 연결 오류:"로 구분.
- **IP 식별 신뢰성 (IP Spoofing 방어)**: Netlify Edge가 보증하는 `x-nf-client-connection-ip`를 최우선 신뢰하고, 차순위로 `client-ip`, 마지막으로 `x-forwarded-for` 체인의 첫 번째 IP를 추출 (단위 시험 1-8 검증).

---

## 2. 전수 자동화 검증 결과 (27/27 Pass, 100%)

실제 브라우저(Google Chrome Headless) 및 Node.js 런타임을 통해 독립 25개 시나리오(총 27개 테스트 항목)를 전수 검증하였습니다.

### 실행 명령:
```bash
agy-node.cmd --test "06_봉플레이_고객홈페이지/tests/consultation.test.mjs" "06_봉플레이_고객홈페이지/tests/runtime.test.mjs"
```

### 실행 결과 로그:
```text
✔ no key: deterministic guidance and unconfirmed hours (1.6078ms)
✔ personal info and sensitive requests never reach provider (0.4521ms)
✔ JEV request and fixed source answer, never provider prose (31.7701ms)
✔ low confidence and invalid enum fail closed (0.5628ms)
✔ provider failure has fallback without error leakage (0.5276ms)
✔ booking never confirms a reservation (0.0885ms)
✔ multiple topics in basic mode ask clarification (0.0702ms)
✔ input limits (0.228ms)
✔ HTTP guards and no-store (3.3291ms)
▶ 1. 분산 레이트 리미트 & Fail-Closed 과금 방어 (ANT-004 / R1 보완)
  ✔ 1-1. IP별 분당 상한(RATE_LIMIT_PER_MINUTE) 초과 시 429 반환 및 Retry-After 헤더 검증 (6.5696ms)
  ✔ 1-2. 일일 전역 쿼터(RATE_LIMIT_DAILY_TOTAL) 초과 시 DAILY_QUOTA_EXCEEDED 반환 검증 (2.28ms)
  ✔ 1-3. [Fail-Closed] JEV_ENABLED=true 시 분산 저장소 미설정 상태면 외부 유료호출 원천 차단 검증 (0.4237ms)
  ✔ 1-4. [Fail-Closed] 분산 저장소 통신 장애 시 외부 유료 호출 차단 및 429 반환 검증 (0.3779ms)
  ✔ 1-5. DistributedRedisRateLimitStore 정상 파이프라인 배치 실행 검증 (0.491ms)
  ✔ 1-6. [P1 Fail-Closed] Redis 응답이 빈 배열([])이거나 개별 명령에 error가 포함된 경우 엄격 차단 검증 (1.7947ms)
  ✔ 1-7. [P1 Memory 우회 방지 & 한도 파싱] 분산 저장소 없이 메모리 우회 불가 및 한도 0/음수/NaN/Infinity 정책 검증 (0.2176ms)
  ✔ 1-8. [IP 식별 신뢰성] x-nf-client-connection-ip > client-ip > x-forwarded-for 헤더 우선순위 검증 (0.2224ms)
✔ 1. 분산 레이트 리미트 & Fail-Closed 과금 방어 (ANT-004 / R1 보완) (14.3135ms)
▶ 2. 실제 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844 실동작) (ANT-004 / R1 보완)
  ✔ 2-1. [Desktop 1440x900] 상담 열기, ESC 닫기, 포커스 복원 검증 (516.1098ms)
  ✔ 2-2. [Desktop 1440x900] 빠른 주제(요금) 질문 제출 및 15,000원 안내 응답 실측 (222.6086ms)
  ✔ 2-3. [Desktop 1440x900] 연속 제출 방지 (Double Submit Guard) 실측 (505.8687ms)
  ✔ 2-4. [Desktop 1440x900] 한글 IME 조합 중(isComposing=true) Enter 전송 방지 실측 (2.4037ms)
  ✔ 2-5. [Desktop 1440x900] HTTP 429 일일 한도 vs 1분 분당 제한 차등 렌더링 실측 (231.7958ms)
  ✔ 2-6. [Desktop 1440x900] 실제 9초 타임아웃(AbortSignal.timeout) 발생 및 안내 문구 렌더링 실측 (9198.1309ms)
  ✔ 2-7. [Mobile 390x844] 뷰포트 레이아웃 수평 넘침 0 및 모바일 다이얼로그 적합성 실측 (180.187ms)
  ✔ 2-8. [Mobile 390x844] 오프라인 상태(navigator.onLine=false) 감지 안내 실측 (117.5446ms)
✔ 2. 실제 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844 실동작) (ANT-004 / R1 보완) (12673.0192ms)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14383.846
```

- **시험 소요 시간**: 9초 실제 타임아웃 검증을 포함하여 전체 14.38초에 완결 (5분 상한 규정 엄격 준수).
- **프로세스 안전 종료**: Chrome 프로세스 단일 PID 식별 종료(`finally` 블록 `kill('SIGTERM')`), 임시 디렉터리 삭제, 포트 반환 완료.

---

## 3. 미실행 항목 및 사유

1. **실제 TypeSafe API 유료 호출**: 벤 R1 지시 및 대표 결정 문서(`BEN-015_대표결정_20261005.md`)에 따라 모의 검증만 수행.
2. **실제 Netlify 외부 배포**: 지시서에 따라 실제 배포 금지. `DEPLOY.md`에 초안 배포 분리 절차서 작성 완료.
3. **실제 Upstash Redis 프로비저닝**: 외부 인프라 미연결 상태 유지, REST 파이프라인 모의 검증 완료.

---

## 4. 남은 결정 요청 사항

1. **하위 PR 생성**:
   - 브랜치 `antigravity/ANT-004-jev-runtime`을 최신 기준 커밋 `c935504` 기반으로 리베이스 완료했습니다.
   - 대상 브랜치: `ben/BEN-015-jev-consultation` (PR #31 연계).
2. **대표 확인 사항과의 부합 여부**:
   - 대표 결정 문서에 명시된 "종합 이용권 21,000원 확정" 및 "TypeSafe 계정 없이 모의 검증 진행" 방침과 런타임/배포 가이드가 완벽히 일치함을 확인했습니다.
