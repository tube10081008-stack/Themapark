# 고객 홈페이지 수동 ZIP 배포

2026-10-05 대표가 채팅을 포함한 배포를 승인했고, 이어 Sakana 키 입력 후 사용하도록 요청했다. 고객 사이트는 https://bongplayhome.netlify.app/ 이며 01 운영시스템·04 업무로그 배포와 분리한다.

## 패키지 만들기

저장소 루트에서 커밋 후 실행한다. 출력 경로는 새 폴더여야 한다.

```powershell
node 06_봉플레이_고객홈페이지/build-release.mjs <새 출력폴더> <전체 커밋 SHA> runtime-enabled
Compress-Archive -Path <출력폴더>/* -DestinationPath <새 ZIP 경로>
```

- 기본값(네 번째 인수 생략)은 `basic-guidance`: 외부 모델 호출을 강제로 끈다.
- `runtime-enabled`: Sakana / fugu / CONSULT_ENABLED=true를 기본으로 적용하고 서버 환경변수로 덮어쓸 수 있다. 기존 TypeSafe 경로는 끈다. 공용 호출 제한 저장소 검증은 유지한다.
- 정적 파일은 `public/`, 서버 코드는 `netlify/functions/`로 분리한다. 소스·테스트·키·문서는 정적 공개 폴더에 넣지 않는다.
- `deploy-manifest.json`에 원본 SHA, 파일 해시, 릴리스 모드 및 서버 진입점 변환을 기록한다.

## 서버 환경변수

Netlify bongplayhome 프로젝트의 Environment variables에 설정한다. Production 문맥과 Functions 범위(범위 선택이 없으면 All scopes)에 적용한다. 변경 후 재배포해야 한다. 비밀값은 문서·채팅·Git에 적지 않는다.

| 변수 | 값/역할 |
|---|---|
| SAKANA_API_KEY | Sakana 발급 키, 비밀 |
| RATE_LIMIT_STORE_URL | Upstash Redis REST URL |
| RATE_LIMIT_STORE_TOKEN | 같은 DB의 쓰기 가능한 REST Token, 비밀 |
| CONSULT_PROVIDER | sakana (runtime-enabled 기본값) |
| CONSULT_MODEL | fugu (runtime-enabled 기본값, 계정 접근 확인 필요) |
| CONSULT_ENABLED | true, 긴급 중지 시 false |
| RATE_LIMIT_PER_MINUTE | 기본 10, IP당 분당 요청 수 |
| RATE_LIMIT_DAILY_TOTAL | 기본 500, 전체 일일 요청 수(UTC 기준) |

공용 저장소 미설정이면 외부 호출 없이 기본 안내로 응답한다. 활성화 상태에서 저장소 장애가 발생하면 429로 차단한다. 요청 수 제한은 금액 한도가 아니며 모델 과금 한도는 공급자 계정에서 별도 관리한다. 주제 버튼은 모델을 호출하지 않고 확정 안내로 응답한다.

Upstash 준비: https://console.upstash.com/ 에서 Redis DB 생성 후 REST URL과 REST Token을 확인한다. 읽기 전용 토큰은 INCR/EXPIRE를 수행할 수 없다. 유료 플랜 선택·신규 약관 동의는 대표가 수행한다.
공식 연결 문서: https://upstash.com/docs/redis/howto/connect-with-upstash-redis
모델 근거: https://console.sakana.ai/get-started (2026-10-05 확인, model=fugu)

## 업로드 및 검증

1. Netlify의 bongplayhome Deploys에서 현재 공개 배포를 기록한다.
2. 필요하면 auto publishing을 잠근 뒤 ZIP을 업로드하고 Preview에서 확인한다.
3. 빌드 결과에 consult Function이 포함되는지 확인한다. 이 계정의 ZIP Drop은 2026-10-05 실제 Functions 빌드·응답까지 확인했다.
4. Publish deploy 후 공개 URL에서 상담 버튼, 요금·웰컴 음료 안내, 예약 미확정 안내를 확인한다. 공개 사이트의 Netlify 배지와 상담 버튼이 겹치지 않는지도 확인한다.
5. manifest SHA 일치, POST 응답, GET 405, 비공개 소스 경로 404를 확인한다. 입력 1,200자 초과는 400, 본문 8,192바이트 초과는 413이다.
6. 임시 변경한 auto publishing 잠금을 기존 상태로 복원한다. Git 자동 배포 연결은 하지 않는다.

실제 모델 연결은 세 환경변수 설정·재배포 후 합성 자유질문에서 mode=model을 확인해야 완료다. rules 응답이나 모의 테스트만으로 실제 연결 성공을 보고하지 않는다.

## 롤백

Deploys에서 이전 정상 배포를 열어 Publish deploy로 복구하고 공개 manifest와 응답을 확인한다. 복구 소요 시간을 보장하지 않는다. 전체 사이트 공개 중단보다 이전 배포 복구를 우선한다.
