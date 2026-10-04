# 고객 홈페이지 & JEV 상담 Netlify 수동 배포 가이드

이 문서는 2026-10-05 기준 고객 홈페이지 정적 에셋 및 JEV AI 상담 서버리스 함수(`netlify/functions/consult.mjs`)의 **수동 배포 및 릴리스 재현 절차**를 정의합니다. (01 운영시스템, 02 기업사이트, 04 업무로그와 격리된 전용 사이트입니다.)

---

## 1. 정적 배포와 서버리스 함수 배포의 차이점

> [!WARNING] Netlify Web UI 단순 폴더 드롭(Drop) 시 함수 누락 주의
> Netlify Web 대시보드의 단순 드래그 앤 드롭(`https://app.netlify.com/drop`)은 오직 정적 파일(`publish = "."`)만 서비스하며, **`netlify/functions/` 하위의 서버리스 함수를 자동으로 빌드·배포하지 않습니다.**
> 따라서 단순 정적 ZIP을 올리면 `/.netlify/functions/consult` 호출 시 `404 Not Found`가 발생하며 상담 기능이 작동하지 않습니다.

서버리스 함수가 포함된 고객 홈페이지를 Git 자동 연동 없이 수동 릴리스하기 위해서는 **Netlify CLI 수동 배포** 방식을 표준 절차로 채택합니다.

---

## 2. 서버 환경변수 설정 (Netlify Site Settings)

배포 전 Netlify 대시보드 (`Site configuration > Environment variables`)에서 아래 환경변수를 설정합니다. **API 키나 비밀값은 저장소·HTML·채팅에 절대 커밋하지 않습니다.**

| 환경변수명 | 필수 여부 | 권장 기본값 | 설명 |
|---|---|---|---|
| `JEV_ENABLED` | 필수 | `false` | JEV 유료 외부 호출 활성화 스위치 (미승인 시 `false` 유지, 기본 안내 모드로 동작) |
| `TYPESAFE_API_KEY` | 선택 (JEV_ENABLED=true 시 필수) | `(비공개)` | TypeSafe API 인증 키 |
| `JEV_MODEL` | 선택 (JEV_ENABLED=true 시 필수) | `systemone-preview` | 계정 지원 모델 식별자 |
| `RATE_LIMIT_STORE_URL` | 권장 (JEV_ENABLED=true 시 필수) | `(Upstash REST URL)` | 다중 인스턴스 분산 레이트리미트 저장소 URL |
| `RATE_LIMIT_STORE_TOKEN` | 권장 (JEV_ENABLED=true 시 필수) | `(Upstash REST Token)` | 분산 저장소 인증 토큰 |
| `RATE_LIMIT_PER_MINUTE` | 선택 | `10` | IP당 분당 허용 요청 수 |
| `RATE_LIMIT_DAILY_TOTAL` | 선택 | `500` | 전체 인스턴스 일일 허용 총 요청 수 (비용 상한선) |

> [!IMPORTANT] Fail-Closed 비용 방어 규칙
> `JEV_ENABLED === 'true'`일 때 `RATE_LIMIT_STORE_URL`이 설정되지 않았거나 통신 장애가 발생하면, 서버는 유료 호출을 즉시 차단(`Fail-Closed`)하고 기본 안내 모드로 안전하게 폴백하여 미인가 과금을 방지합니다.

---

## 3. 배포 전 로컬 무결성 전수 검증 절차

배포를 실행하기 전 로컬 환경에서 기존 및 신규 테스트 스위트를 전수 실행하여 100% 통과를 확인합니다:

```bash
# 1. 프로젝트 폴더 이동
cd 06_봉플레이_고객홈페이지

# 2. 계약 및 지식 스냅샷 테스트 실행 (9건 통과 확인)
node --test tests/consultation.test.mjs

# 3. 런타임, 분산 비용 방어, 실제 브라우저 실측 테스트 실행
node --test tests/runtime.test.mjs
```

---

## 4. Netlify CLI 기반 수동 배포 실행 절차

Git 자동 연동 없이 로컬 산출물을 프로덕션에 배포하는 표준 명령:

```bash
# 1. Netlify CLI 인증 (초기 1회)
npx netlify login

# 2. 고객 홈페이지 프로젝트 연결 (초기 1회)
npx netlify link

# 3. 정적 파일과 Functions를 동시에 프로덕션 배포
npx netlify deploy --prod --dir=. --functions=netlify/functions
```

### 배포 패키지 구성 파일 목록:
- `index.html` (고객 홈페이지 메인)
- `styles.css` (공통 스타일)
- `app.js` (홈페이지 프론트엔드 인터랙션)
- `config.js` (공개 클라이언트 설정)
- `consultation.js` (AI 상담 모달 동작 로직)
- `consultation.css` (AI 상담 모달 스타일)
- `netlify.toml` (빌드 및 Functions 설정, 헤더 보안 정책)
- `netlify/functions/consult.mjs` (상담 서버리스 함수 진입점)
- `netlify/functions/lib/consultation.mjs` (지식 계약 및 의도 분류)
- `netlify/functions/lib/rate-limit.mjs` (분산 호출 제한 및 비용 방어)
- `assets/` (로고, 폰트, 반응형 이미지)

---

## 5. 배포 후 실측 검증 (Smoke Test)

배포 완료 후 반환된 프로덕션 URL(`https://<site-name>.netlify.app`)에서 다음을 실측합니다:

1. **상담 함수 정상 응답 확인**:
   ```bash
   curl -s -X POST https://<site-name>.netlify.app/.netlify/functions/consult \
     -H "Content-Type: application/json" \
     -d '{"message":"요금"}'
   ```
   - 응답: HTTP 200, `{"intent":"price","mode":"rules", ...}` 반환 확인
   - 헤더: `Cache-Control: no-store` 확인
2. **비정상 요청 차단 확인**:
   - `GET` 요청 시: HTTP 405 Method Not Allowed
   - 1,200자 초과 요청 시: HTTP 413 Payload Too Large
   - 단시간 10회 초과 반복 호출 시: HTTP 429 Too Many Requests
3. **실제 브라우저 UI 동작 확인**:
   - 데스크톱/모바일에서 'AI 상담' 버튼 클릭 시 모달 정상 팝업
   - '요금' 빠른 버튼 클릭 시 15,000원 기본권 안내 메시지 정상 렌더링
   - ESC 키 입력 시 팝업 닫힘 및 포커스 정상 복귀
   - 네트워크 오프라인 시 안내 문구 표출

---

## 6. 실패 시 롤백 절차

1. Netlify 대시보드의 `Deploys` 메뉴에서 직전 안정 버전(`Previous publish`)을 클릭합니다.
2. `Publish deploy` 버튼을 눌러 직전 안정 버전으로 1초 내 즉시 롤백합니다.
3. 최초 배포 실패 시 `Site settings > Danger zone > Stop builds/unpublish`로 공개를 즉시 중단합니다.
