# 봉뜨락 업무로그 — Netlify 판

단톡방 대화를 붙여넣으면 AI가 **[결정] / [할일] / [공유] / [아이디어]** 로 나눠 담당자·마감일까지
뽑아주고, 확인한 것만 구글 시트에 행으로 쌓습니다. **쓰는 사람은 로그인이 필요 없습니다.**
링크만 열면 됩니다.

```
봉뜨락_업무로그_netlify/
├── netlify.toml                 배포 설정 (빌드 없음)
├── public/index.html            화면 (외부 CDN 없음)
├── netlify/functions/api.mjs    서버 — 모델 호출 + 구글 시트 적재
└── README.md                    이 문서
```

**의존성이 하나도 없습니다.** `npm install` 도, 빌드도 필요 없어서 zip 을 그대로 끌어다 놓으면 뜹니다.

---

## 1. 준비물

1. **Netlify 계정** — 무료. 깃허브 없이 이메일로 가입해도 됩니다.
2. **AI API 키 하나** — 넣은 쪽이 자동으로 쓰입니다.
   - Sakana Fugu: [console.sakana.ai](https://console.sakana.ai/get-started) (키는 생성 시 한 번만 표시)
   - 또는 Gemini: [aistudio.google.com](https://aistudio.google.com/apikey)
3. **구글 시트 + 서비스 계정** — 아래 3번에서 만듭니다 (10분 정도).

## 2. 배포

### 방법 A — zip 끌어다 놓기 (가장 빠름)

1. [app.netlify.com/drop](https://app.netlify.com/drop) 접속
2. 받은 **zip 파일을 그대로 끌어다 놓기** (압축을 풀어 폴더째 놓아도 됩니다)
3. `랜덤이름.netlify.app` 주소가 즉시 생깁니다 → **Site configuration → Change site name** 에서
   `bongttorak-worklog` 처럼 바꾸면 주소가 `bongttorak-worklog.netlify.app` 이 됩니다

### 방법 B — Netlify CLI (드롭이 함수를 못 잡을 때)

```bash
npm i -g netlify-cli
netlify login
cd 봉뜨락_업무로그_netlify
netlify deploy --prod        # 안내에 따라 새 사이트 선택
```

> 배포 후 **Functions** 탭에 `api` 가 보이면 정상입니다. 안 보이면 방법 B로 다시 올리세요.
> 환경변수를 넣기 전에는 화면만 뜨고 분류는 실패합니다. 3~4번을 마치고 재배포하세요.

## 3. 구글 시트 연결 (서비스 계정)

서버가 사람 대신 시트에 쓰려면 **서비스 계정**이 필요합니다. 한 번만 하면 됩니다.

1. [console.cloud.google.com](https://console.cloud.google.com) → 상단에서 **새 프로젝트** 생성 (이름: `bongttorak`)
2. 검색창에 **Google Sheets API** → **사용 설정**
3. 왼쪽 **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → 서비스 계정**
   - 이름 아무거나(`worklog-bot`) → 만들기 → 역할 지정 없이 완료
4. 만들어진 서비스 계정 클릭 → **키 탭 → 키 추가 → 새 키 만들기 → JSON** → 파일이 내려받아집니다
5. 그 JSON 안의 두 값을 4번 환경변수에 넣습니다.
   - `"client_email": "worklog-bot@....iam.gserviceaccount.com"`
   - `"private_key": "-----BEGIN PRIVATE KEY-----\nMIIE..."`
6. **적재할 구글 시트를 열고 → 공유 → 위 `client_email` 주소를 편집자로 추가**
   ← 빠뜨리면 저장할 때 403 이 납니다. 가장 흔한 실수입니다.
7. 시트 주소에서 ID 를 복사합니다.
   ```
   https://docs.google.com/spreadsheets/d/1AbCd...XyZ/edit
                                          └──── 이 부분 ────┘
   ```

`업무로그` 시트 탭과 헤더(A~H)는 첫 저장 때 자동으로 만들어집니다.

## 4. 환경변수

Netlify: **Site configuration → Environment variables → Add a variable**

| 변수 | 필수 | 값 |
|---|:--:|---|
| `SAKANA_API_KEY` | ◼ | Sakana Fugu 키 |
| `GEMINI_API_KEY` | ◼ | Gemini 키 (Sakana 대신 쓸 때) |
| `SHEET_ID` | ✅ | `1AbCd...XyZ` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | ✅ | `worklog-bot@....iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | ✅ | JSON 의 `private_key` 값 (`-----BEGIN PRIVATE KEY-----` 부터 끝까지. `\n` 이 들어간 형태 그대로 붙여넣어도 됩니다) |
| `ACCESS_CODE` | | 설정하면 화면에서 이 코드를 입력해야 동작 (권장) |
| `LLM_PROVIDER` | | `sakana` 또는 `gemini`. 비우면 키가 있는 쪽 (둘 다면 Sakana) |
| `SAKANA_MODEL` | | 기본 `fugu`. `fugu-ultra` / `fugu-max` / `fugu-cyber` |
| `GEMINI_MODEL` | | 기본 `gemini-3.7-flash` |
| `SHEET_NAME` | | 기본 `업무로그` |

◼ = 둘 중 **하나는 반드시** 필요합니다.

> **환경변수를 바꾸면 반드시 재배포해야 반영됩니다.** Deploys → Trigger deploy → Deploy site.

## 5. 쓰는 법

1. 주소를 엽니다 (접근 코드를 걸었다면 한 번 입력 — 그 기기에 저장됩니다)
2. 단톡방 대화 붙여넣기 → **AI로 자동 분류**
3. 카드에서 담당자·마감일 확인/수정, 필요 없는 건 `제외`
4. 카드별 **승인 및 시트 전송** 또는 하단 **전체 시트 전송**
5. `Google 시트에 N건의 업무가 성공적으로 등록되었습니다.` + 시트 링크

휴대폰에서 **홈 화면에 추가**하면 앱처럼 씁니다. 음성 입력(🎤)은 지원 브라우저에서만 보입니다.

## 6. 안전장치

- API 키와 서비스 계정 키는 **서버(환경변수)에만** 있습니다. 화면으로 내려가지 않습니다.
- 화면에서 올라온 값도 서버에서 다시 검사합니다. 분류·담당자·우선순위는 허용된 값으로만,
  마감일은 `YYYY-MM-DD` 를 통과한 것만 들어가고 나머지는 `미정` 이 됩니다.
- 한 번에 최대 50건, 입력은 12,000자까지.
- `ACCESS_CODE` 를 걸면 주소를 아는 사람이라도 코드 없이는 쓰지 못합니다.
- 검색엔진에 잡히지 않도록 `noindex` 를 걸어두었습니다.

## 7. 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| `API 키가 설정되지 않았습니다` | 환경변수 미입력, 또는 넣고 재배포하지 않음 |
| `시트에 접근할 수 없습니다` (403) | 시트를 서비스 계정 이메일에 **편집자**로 공유하지 않음 |
| `시트를 찾을 수 없습니다` (404) | `SHEET_ID` 오타 |
| `서비스 계정 비밀키 형식이 잘못되었습니다` | `private_key` 값을 따옴표 없이 `-----BEGIN` 부터 `-----END PRIVATE KEY-----` 까지 전부 넣었는지 확인 |
| `API 키가 올바르지 않습니다` | 키 앞뒤 공백/오타. Sakana 키는 생성 시 한 번만 보이므로 재발급 |
| 화면은 뜨는데 요청이 404 | Functions 탭에 `api` 가 없음 → 방법 B(CLI)로 재배포 |
| 응답이 느림 | Fugu 는 여러 모델을 거치는 오케스트레이션 모델이라 Flash 계열보다 느릴 수 있습니다. `LLM_PROVIDER=gemini` 로 바꿔 비교해 보세요 |

## 8. Apps Script 판과의 차이

이 저장소의 `chatlog/` 는 같은 도구의 **Google Apps Script 판**입니다.

| | Netlify 판 (이 폴더) | Apps Script 판 (`chatlog/`) |
|---|---|---|
| 배포 | zip 드래그 | 에디터에 붙여넣기 |
| 구글 인증 | 서비스 계정 (설정 10분) | 없음 — 시트에 직접 접근 |
| 주소 | `내이름.netlify.app` | `script.google.com/macros/...` |
| 비용 | 무료 (함수 월 125k 호출) | 무료 |

주소가 짧고 관리 화면이 편한 쪽은 Netlify, 설정이 덜 번거로운 쪽은 Apps Script 입니다.
둘 다 사용자는 로그인 없이 URL 만 열면 되고, 화면·분류 규칙·시트 형식은 완전히 같습니다.
