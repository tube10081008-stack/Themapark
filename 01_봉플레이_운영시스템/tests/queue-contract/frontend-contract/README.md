# 저장 확정·동일 요청 재시도 계약 시험 (CLAUDE-011, 브라우저 계층)

아난티 화면(`pages/consent.html`, `pages/consent-desk.html`)이 `docs/qa/20261014_클로이_queue-followup.md` §5 계약을 지키는지 검사하는 시험이다.

- 단언 기준은 계약이다. 실패하면 계약 누락이 검출된 것이다.
- 대상 화면과 자산 파일은 수정하지 않는다.

## 구성

| 파일 | 내용 |
|---|---|
| `harness.mjs` | 모의 PostgREST·정적 서버, 장애 주입, 요청 기록, Chromium 실행. CDN 은 차단하고 최소 대체 스크립트를 준다 |
| `save-retry-contract.test.mjs` | 고객 접수 C0~C5, 매표 발권 D0~D3 |

모의 서버의 대기열 RPC 는 제안 SQL(`claude/CLAUDE-011-queue-followup` 592d181)의 계약을 **간략히 모사**한다.

- 접수: 서약서 확정 확인(`CONSENT_NOT_FOUND`), 멱등키·서약서 중복 처리
- 발권 완료: 원장 대사(활성 품목, 서약서 소속, 입장권 수량, 원장 완비, 할인 후 금액 수납)

이것은 SQL 실행이 아니다. SQL 자체는 `../ant006-conformance/` 의 PGlite·로컬 PostgreSQL 시험이 검증한다.

## 장애 모드

| 모드 | 서버 처리 | 응답 | 쓰임 |
|---|---|---|---|
| `503` | 안 함 | HTTP 503 | 일시 장애 |
| `lost` | 함 (커밋) | HTTP 503 | 응답 유실 (결과 불명) |
| `json` | 안 함 | 지정 JSON (예: `ENQUEUE_CONFLICT`) | 서버 거부 |
| `abort` | 안 함 | 연결 끊김 | **계약 시험에 쓰지 않음** (아래 참고) |

`abort` 를 쓰지 않는 이유: 재사용 연결에서 응답 없이 끊긴 POST 는 Chromium 이 스스로 다시 보낼 수 있다. 그러면 화면 코드의 재시도와 구분되지 않는다.

## 실행

```sh
# 대상 구현을 별도 폴더에 고정 SHA 로 꺼낸다
git worktree add --detach <dir> <SHA>
# playwright 는 저장소 밖 설치본, PLAYWRIGHT_BROWSERS_PATH 는 설치된 Chromium
ANT006_ROOT=<dir> PW_DIR=<playwright 모듈 경로> \
  node --test --test-concurrency=1 01_봉플레이_운영시스템/tests/queue-contract/frontend-contract/save-retry-contract.test.mjs
```

- `ANT006_ROOT` 를 주지 않으면 전부 건너뛴다.
- 결과는 반드시 대상 구현의 전체 SHA 와 함께 기록한다.
- 이 시험은 운영 DB·Supabase 에 접속하지 않는다. 합성 값만 쓴다.
