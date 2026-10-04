# ANT-004 — 봉플레이 JEV 상담 런타임·호출제한·수동배포 검증 보고서

- **작업 ID**: ANT-004
- **담당자**: 아난티 (Antigravity, Google Pro)
- **오케스트레이터**: 벤 (Ben)
- **대상 PR**: PR #31 (`ben/BEN-015-jev-consultation`)
- **기준 브랜치 및 커밋**: `origin/ben/BEN-015-jev-consultation` (`934dd0f1a559a41c533dcd300c4dce4e9c14a440`)
- **작업 브랜치**: `antigravity/ANT-004-jev-runtime`
- **검증 일시**: 2026-10-05 00:35 (KST)
- **검증 환경**: Node.js v24.18.0 (`agy-node`), Windows PowerShell, Google Chrome Headless (`--headless=new` via Chrome DevTools Protocol), 로컬 HTTP 서버 (`127.0.0.1:4188`)

---

## 1. 작업 범위 및 경계 준수 (Scope & Boundaries)

벤의 착수 지시서(`docs/tasks/BEN-015_JEV_병행착수.md`)의 작업 경계를 엄격히 준수하였습니다:

### 소유 및 수정한 파일
1. `06_봉플레이_고객홈페이지/netlify/functions/lib/rate-limit.mjs` (신규: 분산 레이트리미트 및 Fail-Closed 과금 방어 모듈)
2. `06_봉플레이_고객홈페이지/netlify/functions/consult.mjs` (수정: 분산 저장소 연동, HTTP 429 및 Retry-After 응답, Fail-Closed 안전 차단)
3. `06_봉플레이_고객홈페이지/consultation.js` (수정: 키보드 조작성, 포커스 복원, 연속 제출 방지, 429 안내, 오프라인 감지, 9초 타임아웃)
4. `06_봉플레이_고객홈페이지/consultation.css` (수정: 모바일 390px 뷰포트 반응형, 세이프에어리어, 키보드 포커스 가시성)
5. `06_봉플레이_고객홈페이지/DEPLOY.md` (수정: Netlify Functions 포함 수동 CLI 배포 절차서 및 롤백 가이드)
6. `06_봉플레이_고객홈페이지/tests/runtime.test.mjs` (신규: 레이트리미트 5건 + Chrome Headless 데스크톱/모바일 실측 6건)
7. `docs/qa/ANT-004_JEV상담.md` (신규: 본 QA 보고서)

### 불침범 파일 및 준수 사항
- `06_봉플레이_고객홈페이지/netlify/functions/lib/consultation.mjs`: 클로이(CLAUDE-009) 전담 소유 파일로 **일체 수정하지 않음**.
- `06_봉플레이_고객홈페이지/tests/consultation.test.mjs`: 기존 9건 테스트 계약 유지 (읽기/실행만 수행, 9/9 전수 통과 확인).
- `06_봉플레이_고객홈페이지/index.html`: `consultation.js`와 `consultation.css`가 이미 정상 로드되어 있어 **수정 불필요(원형 보존)**.
- `docs/tasks/BEN-015_JEV_병행착수.md` 및 `05/site_profile.json`: 수정하지 않음.
- 실제 TypeSafe API 유료 호출 0건, 실 배포 0건, 실 자격증명 노출 0건 완결.

---

## 2. 주요 구현 내용

### 2.1 분산 레이트 리미트 및 Fail-Closed 과금 방어 (`lib/rate-limit.mjs`)
- **다중 인스턴스 원자적 카운터 지원**:
  - `DistributedRedisRateLimitStore`: 서버리스 다중 인스턴스 환경에서 상태 불일치 과금을 방어하기 위해 Upstash Redis REST 파이프라인(`INCR` + `EXPIRE`)을 활용한 원자적 카운터 구현 (외부 무거운 npm 의존성 없이 표준 `fetch`만 사용).
  - `MemoryRateLimitStore`: 로컬 개발 및 단위 테스트용 슬라이딩 윈도우/일일 카운터 구현.
- **다층 호출 제한 정책**:
  - IP당 분당 제한: 기본 10회 (`RATE_LIMIT_PER_MINUTE`), 초과 시 HTTP 429 (`Retry-After: 60`, `Cache-Control: no-store`).
  - 전역 일일 쿼터: 기본 500회 (`RATE_LIMIT_DAILY_TOTAL`), 초과 시 전역 인스턴스 429 차단으로 예산 초과 방지.
- **Fail-Closed 안전 차단 ($0 과금 보장)**:
  - `JEV_ENABLED === 'true'` 상태에서 분산 저장소 URL/토큰이 설정되지 않았거나 통신 장애가 발생할 경우, **외부 유료 API 호출을 원천 차단**하고 로컬 확정 규칙 모드로 안전 폴백.

### 2.2 프론트엔드 UI·접근성·오류 처리 보강 (`consultation.js`, `consultation.css`)
- **키보드 접근성 및 포커스 관리**:
  - 다이얼로그 오픈 시 입력 필드(`textarea`) 자동 포커스.
  - ESC 키 입력 또는 닫기 버튼 클릭 시 이전 활성 요소(트리거 버튼)로 포커스 안전 복원.
  - Enter 키로 즉시 전송, Shift+Enter로 줄바꿈 지원.
  - 고대비 `:focus-visible` 아웃라인 스타일 적용.
- **견고한 런타임 오류 방어**:
  - 연속 제출 차단 (Double Submit Guard): 전송 직후 `busy=true`, 전송 버튼 `disabled`, 폼 `aria-busy="true"` 적용으로 중복 과금 차단.
  - 오프라인 감지: `navigator.onLine === false` 감지 시 서버 호출 없이 오프라인 안내 및 전화 문의 유도.
  - HTTP 429 수신 시: 1분 대기 안내 및 고객 전화 문의 메시지 렌더링.
  - 9초 타임아웃 감지: `AbortSignal.timeout(9000)`으로 무한 대기 방지 및 타임아웃 안내 출력.
- **모바일 390px 뷰포트 레이아웃**:
  - 모바일(390×844) 화면에서 가로 스크롤 넘침 0px 보장.
  - 하단 고정 액션바 및 `env(safe-area-inset-bottom)` 여백 처리.

### 2.3 Netlify Functions 수동 배포 절차서 개정 (`DEPLOY.md`)
- **정적 Web Drop과 Functions 배포의 구조적 차이점 규명**:
  - Netlify 대시보드 폴더 드래그 앤 드롭(`netlify.com/drop`)은 `publish` 정적 파일만 서비스하므로 Functions가 누락되어 404가 발생하는 원인 명시.
  - 해결책으로 Netlify CLI 기반 프로덕션 수동 배포 절차 수립 (`npx netlify deploy --prod --dir=. --functions=netlify/functions`).
- **환경변수 템플릿, 배포 전후 실측 검증, 원클릭 롤백 절차 상세화**.

---

## 3. 전수 자동화 검증 결과 (22/22 Pass, 100%)

실제 브라우저(Google Chrome Headless) 및 Node.js 런타임을 통해 22개 시나리오를 전수 검증하였습니다.

### 실행 명령:
```bash
agy-node.cmd --test "06_봉플레이_고객홈페이지/tests/consultation.test.mjs" "06_봉플레이_고객홈페이지/tests/runtime.test.mjs"
```

### 실행 결과 로그:
```text
✔ no key: deterministic guidance and unconfirmed hours (1.9231ms)
✔ personal info and sensitive requests never reach provider (0.4801ms)
✔ JEV request and fixed source answer, never provider prose (35.3477ms)
✔ low confidence and invalid enum fail closed (0.6069ms)
✔ provider failure has fallback without error leakage (0.6058ms)
✔ booking never confirms a reservation (0.1335ms)
✔ multiple topics in basic mode ask clarification (0.0802ms)
✔ input limits (0.2372ms)
✔ HTTP guards and no-store (3.6458ms)
▶ 1. 분산 레이트 리미트 & Fail-Closed 과금 방어 (ANT-004)
  ✔ 1-1. IP별 분당 상한(RATE_LIMIT_PER_MINUTE) 초과 시 429 반환 및 Retry-After 헤더 검증 (7.0352ms)
  ✔ 1-2. 일일 전역 쿼터(RATE_LIMIT_DAILY_TOTAL) 초과 시 인스턴스 전역 429 차단 검증 (2.586ms)
  ✔ 1-3. [Fail-Closed] JEV_ENABLED=true 시 분산 저장소 미설정 상태면 외부 유료호출 원천 차단 검증 (0.3627ms)
  ✔ 1-4. [Fail-Closed] 분산 저장소 통신 장애 시 외부 유료 호출 차단 검증 (0.4572ms)
  ✔ 1-5. DistributedRedisRateLimitStore 원자적 파이프라인 호출 검증 (1.1948ms)
✔ 1. 분산 레이트 리미트 & Fail-Closed 과금 방어 (ANT-004) (12.9869ms)
▶ 2. 실제 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844 실동작) (ANT-004)
  ✔ 2-1. [Desktop 1440x900] 상담 열기, ESC 닫기, 포커스 복원 검증 (492.6689ms)
  ✔ 2-2. [Desktop 1440x900] 빠른 주제(요금) 질문 제출 및 15,000원 안내 응답 실측 (226.5069ms)
  ✔ 2-3. [Desktop 1440x900] 연속 제출 방지 (Double Submit Guard) 실측 (513.0531ms)
  ✔ 2-4. [Desktop 1440x900] HTTP 429 레이트 리미트 수신 시 안내 문구 렌더링 실측 (118.05ms)
  ✔ 2-5. [Mobile 390x844] 뷰포트 레이아웃 수평 넘침 0 및 모바일 다이얼로그 적합성 실측 (210.1265ms)
  ✔ 2-6. [Mobile 390x844] 오프라인 상태(navigator.onLine=false) 감지 안내 실측 (110.0558ms)
✔ 2. 실제 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844 실동작) (ANT-004) (3439.879ms)
ℹ tests 22
ℹ suites 0
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 4929.3077
```

### 시험 시간 및 프로세스 안전성:
- **전체 소요 시간**: 4.93초 (전체 상한 5분 규정 완벽 준수)
- **시나리오별 소요 시간**: 최대 530ms (시나리오별 60초 상한 준수)
- **프로세스 안전 종료**: Chrome 프로세스는 `child.pid`로 단일 식별하여 `finally` 블록에서 `SIGTERM`/`SIGKILL`로 안전 종료, 임시 유저 데이터 디렉터리 자동 삭제 완료, 백그라운드 PowerShell/Chrome 잔류 프로세스 0건.

---

## 4. 미실행 항목 및 사유

1. **실제 TypeSafe API 유료 호출 검증**:
   - 사유: 지시서 보안 및 비용 안전 수칙 준수 (실제 API 키 커밋 및 유료 호출 엄금). 모의 fetcher 및 장애 주입 테스트로 Fail-Closed 차단 동작 100% 검증 완료.
2. **실제 Netlify 프로덕션 배포 실행**:
   - 사유: 지시서 원칙 준수 (실 배포·계정 변경 금지). `DEPLOY.md`에 재현 가능한 표준 수동 배포 절차서를 완비함.
3. **실제 Upstash Redis 프로비저닝**:
   - 사유: 실제 외부 유료 인프라 자격증명 미연결. 로컬 모의 REST 파이프라인 검증 및 환경변수 템플릿 분리 완료.

---

## 5. 남은 결정 요청 사항

1. **분산 저장소(Redis) 및 TypeSafe API 도입 시기 결정**:
   - JEV 외부 유료 상담 활성화(`JEV_ENABLED=true`)를 위해서는 Upstash Redis(무료 티어 가능) 프로비저닝 및 환경변수 등록이 선행되어야 함. 현재 상태에서는 Fail-Closed 원칙에 따라 무조건 로컬 확정 규칙 모드로만 작동합니다.
2. **지오(GEO-006) 브라우저 실사용 검증 연계**:
   - 데스크톱/모바일 UI 동작 및 에러 안내 문구(오프라인, 429 등)의 고객 경험 적절성에 대한 지오(Aside) 실사용 검증 피드백 대기.

---

## 6. 작업 시간 기록

- **착수 시각**: 2026-10-05 00:00 (KST)
- **완료 시각**: 2026-10-05 00:35 (KST)
- **실제 작업 시간**: 약 25분 (레이트리미트 모듈 작성, 핸들러 연동, UI 보강, DEPLOY.md 작성, 보고서 작성)
- **재작업 시간**: 약 10분 (Chrome CDP `Runtime.evaluate` IIFE 스코프 격리 및 폼 셀렉터 정밀화)
- **외부 대기 시간**: 0분
- **총 소요 시간**: 약 35분
