# ANT-004 — 봉플레이 JEV 상담 런타임·호출제한·수동배포 검증 보고서 (R2 완결)

- **작업 ID**: ANT-004
- **담당자**: 아난티 (Antigravity, Google Pro)
- **오케스트레이터**: 벤 (Ben)
- **대상 PR**: PR #31 (`ben/BEN-015-jev-consultation`)
- **기준 브랜치 및 커밋**: `origin/ben/BEN-015-jev-consultation` (`6a83e8b809f62746f5be924ac851ada25f33cd2d`, 클로이 PR #32 병합 및 R2 검토 최신 커밋)
- **작업 브랜치**: `antigravity/ANT-004-jev-runtime`
- **검증 환경**: Node.js v24.18.0 (`agy-node`), Windows PowerShell, Google Chrome Headless (`--headless=new` via Chrome DevTools Protocol), 로컬 HTTP 서버 (`127.0.0.1:4188`)

---

## 1. 벤 R2 검토 피드백 반영 및 조치 현황

벤의 2차 검토서(`docs/qa/BEN-015_R2_보완검토.md`)에 명시된 4개 요구사항을 전수 완결하였습니다:

### 1.1 [P1 만료 성공 검사 오류 수정] Redis EXPIRE 명령 결과 엄격 검증
- **문제점 분석**: R1 코드의 `&& typeof ipExpire !== 'number'` 조건으로 인해 숫자로 평가되는 `0`(키 미존재), `-1`(오류), `2`(비정상 수)가 허용되어 `allowed: true, allowExternal: true`가 되는 결함이 벤의 모의 검증에서 재현되었습니다.
- **수정 내용 (`rate-limit.mjs`)**:
  - `isValidExpireResult(val)` 헬퍼를 도입하여 Redis 표준 성공 값인 `1` 및 일부 REST 프록시의 `'OK'`만 성공으로 엄격 제한.
  - `0`, 음수(`-1`), `2` 이상의 수, 비인가 문자열, `null`, `undefined` 등은 양쪽 위치(위치 1: IP EXPIRE, 위치 3: Daily EXPIRE)에서 예외(`STORE_INVALID_IP_EXPIRE`, `STORE_INVALID_DAILY_EXPIRE`)를 발생시키고, `checkRateLimit`의 Fail-Closed 원칙에 따라 **`allowExternal = false` (외부 유료 API 호출 0건 유지)** 및 HTTP 429(`STORE_FAILURE`)로 안전 차단.
- **검증 (`runtime.test.mjs` 1-6)**:
  - `isValidExpireResult` 단위 검증(1, OK 허용 / 0, -1, 2, FAIL, null, undefined 불허).
  - 위치 1 및 위치 3에 대해 `0`, `-1`, `2`, `FAIL`, `null`, `undefined` 주입 시 핸들러 통과 후 외부 JEV 호출이 0건(`externalApiCalled === false`)이며 HTTP 429로 안전 차단됨을 전수 실측.
  - 유효 성공 응답(`1`, `'OK'`)에서는 정상 경로 통과 확인.

### 1.2 [IP 신뢰 경계 확립] Netlify 플랫폼 보증 경로 연동 및 임의 헤더 차단
- **문제점 분석**: 클라이언트가 전송한 `client-ip`나 `x-forwarded-for`를 신뢰할 경우, 공격자가 헤더에 가짜 IP를 임의 회전(IP rotation)하여 분당 한도를 우회할 수 있는 보안 취약점이 존재했습니다.
- **수정 내용 (`rate-limit.mjs`, `consult.mjs`)**:
  - **플랫폼 계약 근거 준수**: Netlify Functions 런타임이 주입하는 `context.ip` 및 Netlify 엣지 프록시 헤더 `x-nf-client-connection-ip`만 공인 클라이언트 IP로 신뢰.
  - **임의 헤더 스푸핑 차단**: 플랫폼 보증 IP가 없는 경우, 클라이언트가 보낸 임의의 `client-ip`/`x-forwarded-for`는 개별 IP로 인정하지 않고 **`'untrusted_client'` 공통 제한 키**로 귀속. 따라서 공격자가 XFF 헤더를 매번 바꿔도 모두 동일한 버킷으로 집계되어 분당 제한을 우회할 수 없음.
  - **테스트 격리**: 로컬/단위 테스트용 IP 주입은 `options.testIp`로 엄격히 분리하여 운영 경로와 격리.
- **검증 (`runtime.test.mjs` 1-8)**:
  - `context.ip`가 가짜 XFF/client-ip를 무시하고 최우선 적용됨을 검증.
  - 플랫폼 보증 없는 XFF 회전 공격(192.0.2.1, 192.0.2.2, 192.0.2.3...) 시 4회차에서 `untrusted_client` 한도 초과(429)로 차단됨을 실측.

### 1.3 [기존 커밋 보존 및 최신 통합 브랜치 병합] No Rebase / No Force-Push
- 벤의 지시에 따라 커밋 재작성(rebase) 및 강제 푸시(--force)를 일체 배제하고, 기존 커밋(`54973e9`)을 보존한 상태에서 최신 통합 브랜치 `origin/ben/BEN-015-jev-consultation`(`6a83e8b`)을 정규 `git merge`로 병합 완료.
- 클로이(CLAUDE-009)의 지식 계약 파일(`knowledge.mjs`, `knowledge.test.mjs`)과 종합권 21,000원 대표 결정, 변경된 고객용 출처 문구(`리틀포레스트 봉플레이 공개 안내 기준`)와의 연동을 전수 검증. 클로이 소유 파일은 일체 수정하지 않음.

### 1.4 [하위 PR 제출 준비]
- 대상 브랜치: `ben/BEN-015-jev-consultation` (PR #31 연계).
- 환경상 GitHub CLI(`gh`) 및 `GITHUB_TOKEN`이 부재하여 CLI 자동 PR 생성이 차단되므로, 지시서 규정에 따라 생성 URL과 정확한 HEAD 커밋 정보를 제출하여 벤이 즉시 통합할 수 있도록 준비.

---

## 2. 전수 자동화 검증 결과 (45/45 Pass, 100%)

리포지토리 내 3개 전체 테스트 스위트(독립 43개 시나리오, 묶음 포함 총 45개 항목)를 전수 실행하여 100% 통과를 확인하였습니다.

### 실행 명령:
```bash
agy-node.cmd --test "06_봉플레이_고객홈페이지/tests/consultation.test.mjs" "06_봉플레이_고객홈페이지/tests/knowledge.test.mjs" "06_봉플레이_고객홈페이지/tests/runtime.test.mjs"
```

### 실행 결과 로그:
```text
✔ no key: deterministic guidance and unconfirmed hours (1.6543ms)
✔ personal info and sensitive requests never reach provider (0.4054ms)
✔ JEV request and fixed source answer, never provider prose (34.0497ms)
✔ low confidence and invalid enum fail closed (0.5585ms)
✔ provider failure has fallback without error leakage (0.5254ms)
✔ booking never confirms a reservation (0.0861ms)
✔ multiple topics in basic mode ask clarification (0.0695ms)
✔ input limits (0.2145ms)
✔ HTTP guards and no-store (3.3033ms)
✔ contract: every fact has a known status, basis and verifiable SHA fields (1.1756ms)
✔ contract: recorded blob SHAs equal the bytes in this checkout (no guessed SHA) (3.3234ms)
✔ answers: every amount/time stated is a statable fact; nothing unconfirmed leaks (0.7684ms)
✔ answers: confirmed values are stated exactly (0.1013ms)
✔ answers follow status: demoting or promoting a fact changes what is said (0.3426ms)
✔ published facts are not statable, except contact channels (2.2337ms)
✔ current repo: classification snapshot (17.4062ms)
✔ portability: CRLF checkout classifies the same as LF; real edits are still detected (17.1769ms)
✔ homepage price rows parse (3.9596ms)
✔ synthetic: fully consistent inputs are ok (published still uncertain) (0.4098ms)
✔ synthetic mismatch: homepage price differs from decision (0.2243ms)
✔ synthetic mismatch: 05 value differs (0.1676ms)
✔ synthetic mismatch: undetermined hours published as a time (0.1855ms)
✔ synthetic mismatch: abolished values reappear on homepage or other notices (0.2961ms)
✔ synthetic missing: homepage row, homepage text, 05 field, source file (0.4012ms)
✔ synthetic uncertain: 05 not confirmed, source changed since snapshot (0.2909ms)
✔ severity: mismatch outranks missing and uncertain (0.1472ms)
✔ consult output contract unchanged and answers come from the knowledge contract (30.1171ms)
▶ 1. 분산 레이트 리미트 & Fail-Closed 과금 방어 (ANT-004 / R2 보완)
  ✔ 1-1. IP별 분당 상한(RATE_LIMIT_PER_MINUTE) 초과 시 429 반환 및 Retry-After 헤더 검증 (7.6271ms)
  ✔ 1-2. 일일 전역 쿼터(RATE_LIMIT_DAILY_TOTAL) 초과 시 DAILY_QUOTA_EXCEEDED 반환 검증 (1.3369ms)
  ✔ 1-3. [Fail-Closed] JEV_ENABLED=true 시 분산 저장소 미설정 상태면 외부 유료호출 원천 차단 검증 (0.4853ms)
  ✔ 1-4. [Fail-Closed] 분산 저장소 통신 장애 시 외부 유료 호출 차단 및 429 반환 검증 (0.3959ms)
  ✔ 1-5. DistributedRedisRateLimitStore 정상 파이프라인 배치 실행 검증 (0.4864ms)
  ✔ 1-6. [P1 Fail-Closed & R2 EXPIRE 엄격 검증] 만료 성공(1, OK) 외 0/음수/2/문자/오류 시 외부 호출 0건 차단 검증 (2.3073ms)
  ✔ 1-7. [P1 Memory 우회 방지 & 한도 파싱] 분산 저장소 없이 메모리 우회 불가 및 한도 0/음수/NaN/Infinity 정책 검증 (0.1893ms)
  ✔ 1-8. [R2 IP 신뢰 경계 검증] Netlify context.ip 최우선 및 위변조 임의 헤더 차단(untrusted_client) 검증 (0.5977ms)
✔ 1. 분산 레이트 리미트 & Fail-Closed 과금 방어 (ANT-004 / R2 보완) (16.8914ms)
▶ 2. 실제 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844 실동작) (ANT-004 / R2 보완)
  ✔ 2-1. [Desktop 1440x900] 상담 열기, ESC 닫기, 포커스 복원 검증 (502.7785ms)
  ✔ 2-2. [Desktop 1440x900] 빠른 주제(요금) 질문 제출 및 15,000원 안내 응답 실측 (217.8683ms)
  ✔ 2-3. [Desktop 1440x900] 연속 제출 방지 (Double Submit Guard) 실측 (503.7351ms)
  ✔ 2-4. [Desktop 1440x900] 한글 IME 조합 중(isComposing=true) Enter 전송 방지 실측 (1.3426ms)
  ✔ 2-5. [Desktop 1440x900] HTTP 429 일일 한도 vs 1분 분당 제한 차등 렌더링 실측 (229.0489ms)
  ✔ 2-6. [Desktop 1440x900] 실제 9초 타임아웃(AbortSignal.timeout) 발생 및 안내 문구 렌더링 실측 (9051.5987ms)
  ✔ 2-7. [Mobile 390x844] 뷰포트 레이아웃 수평 넘침 0 및 모바일 다이얼로그 적합성 실측 (177.4631ms)
  ✔ 2-8. [Mobile 390x844] 오프라인 상태(navigator.onLine=false) 감지 안내 실측 (120.7532ms)
✔ 2. 실제 브라우저 실측 (데스크톱 1440x900 & 모바일 390x844 실동작) (ANT-004 / R2 보완) (12474.1895ms)
ℹ tests 45
ℹ suites 0
ℹ pass 45
ℹ fail 0
ℹ duration_ms 13972.1898
```

- **시험 소요 시간**: 실제 9초 타임아웃 검증(`2-6`)을 포함하여 전체 13.97초에 완결 (5분 상한 규정 엄격 준수).
- **프로세스 안전 종료**: Chrome 프로세스 단일 PID 식별 종료(`finally` 블록 `kill('SIGTERM')`), 임시 디렉터리 삭제, 잔류 프로세스 0건.

---

## 3. 미실행 항목 및 사유

1. **실제 TypeSafe API 유료 호출**: 벤 R1/R2 지시 및 대표 결정 문서(`BEN-015_대표결정_20261005.md`)에 따라 모의 검증만 수행 (계정 미생성, 유료 호출 금지 유지).
2. **실제 Netlify 외부 배포**: 지시서에 따라 실제 외부 배포 금지. `DEPLOY.md`에 초안 배포 분리 절차서 작성 완료.
3. **실제 Upstash Redis 프로비저닝**: 외부 인프라 미연결 상태 유지, REST 파이프라인 모의 검증 완료.

---

## 4. 하위 PR 제출 및 벤 인계

- **작업 브랜치**: `antigravity/ANT-004-jev-runtime`
- **대상 브랜치**: `ben/BEN-015-jev-consultation` (PR #31 연계)
- **하위 PR 웹 생성 링크**: [Compare & Pull Request (ben/BEN-015-jev-consultation...antigravity/ANT-004-jev-runtime)](https://github.com/tube10081008-stack/Themapark/compare/ben/BEN-015-jev-consultation...antigravity/ANT-004-jev-runtime)
- **CLI PR 생성 차단 사유**: 런타임 환경에 GitHub CLI(`gh`) 및 `GITHUB_TOKEN`이 미설치/미제공되어 자동 API 호출이 불가하므로, 상기 URL과 최신 커밋 SHA를 제출하여 벤이 즉시 검토/병합할 수 있도록 인계합니다.

---

## 5. 작업 시간 기록

- **R2 보완 작업 실측치 (ISO 8601 및 단조 타이머)**:
  - 시작 시스템 시각: `2026-10-05T08:08:26+09:00`
  - 완료 시스템 시각: `2026-10-05T08:12:00+09:00`
  - 단조 타이머(`performance.now`) 기반 작업 시간: **3분 34초** (외부 대기 0초, 재작업 0초)
