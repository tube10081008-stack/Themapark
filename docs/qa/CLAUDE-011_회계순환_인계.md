# CLAUDE-011 회계 순환 자동화 — 벤(Ben) 인계

- 작성: 클로이(Claude Code) · 2026-10-08
- 브랜치: `claude/CLAUDE-011-accounting-cycle`. 로컬에만 있고 **푸시·PR하지 않았다**.
- 기준 커밋: `origin/master` `892a061`. 작업 커밋: `95890aa07649f91505561c54250107fba7d6a84f`, 이 문서 커밋은 그 다음이다.
- 대표 요청: (1) "회계_최소셋.xlsx를 바탕으로 회계의 순환과정을 자동화", (2) "엑셀 오류 수정하고 배포 ZIP 만들어줘"

> **절차 이탈 (벤 확인 필요)**
> 1. 착수 전에 작업표(`docs/BRANCH_COORDINATION.md`)에 CLAUDE-011을 등록하지 않았다. ID는 기존 최대 CLAUDE-010 다음 번호로 임의 부여했다. 작업표 등록 여부와 ID 확정을 벤이 결정해 주기 바란다.
> 2. 초기 구현은 대표 작업 폴더(현재 checkout = `antigravity/ANT-005-conversation-assistant`)에서 했다. 같은 파일 5개가 그 폴더에 **미커밋 사본**으로 남아 있다(아래 §6). ANT-005에 커밋되면 안 된다.
> 3. 배포 ZIP은 대표 요청에 따라 이 브랜치에서 생성했다. 벤 검토 전 산출물이다.

## 1. 변경 파일 (커밋 95890aa, +1428/−1)

| 파일 | 내용 |
|---|---|
| `01_봉플레이_운영시스템/assets/bongplay-accounting.js` (신규, 714줄) | 회계 엔진. DOM·네트워크에 의존하지 않아 Node로 테스트할 수 있다. `window.BongplayAccounting`과 `module.exports`로 노출한다. |
| `01_봉플레이_운영시스템/pages/accounting.html` (신규, 517줄) | 7단계 화면: ①수집 ②분개 ③원장 ④시산표 ⑤결산수정 ⑥재무제표 ⑦마감·내보내기 |
| `01_봉플레이_운영시스템/tests/accounting_engine.test.js` (신규, 182줄) | 합성 데이터 회귀 테스트 11개 |
| `01_봉플레이_운영시스템/index.html` (+12) | '경영 · 분석' 섹션에 카드 1개 |
| `01_봉플레이_운영시스템/sw.js` (+3/−1) | `CACHE_NAME` → `bongplay-static-v2026-10-08r1`, 캐시 목록 2개 추가 |

DB 스키마, `bongplay-id.js`, `bongplay-sync.js`, 기존 페이지 로직은 수정하지 않았다.

## 2. 설계 요점 (fugu D-007·D-008)

- **원장 형식**은 `회계_최소셋.xlsx` '전표' 시트 A~J와 같다: 전표번호·날짜·증빙·적요·계정코드·차변·대변·부가세액·거래처·비고.
- **계정과목**은 엑셀 53개(`BASE_CHART`)에 2개를 더했다(`ADDED_CHART` :51): 205 미지급세금(부가세 정리용), 509 원재료비(카페 재료).
- **일일매출 자동분개** `buildDailySalesVouchers` (:153). 입력은 `order_items` + `order_payments`.
  - 결제수단은 `METHOD_RULES` (:136)로 계정에 매핑한다: card·mobile_pay → 103, cash → 101, local_pay → 104, youth_voucher → 141 미수금. 이 분류는 `bongplay-id.js` `PAYMENT_METHODS.bucket`과 같다.
  - 품목은 `revenueCodeOf` (:127)로 매핑한다: ticket*·addon_attraction → 401, fnb·merchandise → 403.
  - 날짜는 KST 기준(`kstDate` :80)이다. cancelled는 제외하고 id로 중복을 제거한다. 결제행이 없는 구 주문은 품목의 `payment_method`로 보완한다.
  - 부가세는 ROUND(합계/11)로 계산한다(엑셀 V-005 방식). 세액은 수익 라인 H열과 220 라인에 함께 기록한다.
  - 결제 합계와 품목 합계가 다르면 141 또는 230 임시 라인으로 처리하고 `SALES_PAYMENT_GAP` 오류를 낸다.
- **시재 과부족** `buildCashOverShortVouchers` (:228): `closing_records.diff_amount`(실사−장부, `closing.html` 기준)를 410 잡이익 또는 530 잡비로 처리한다.
- **수기 템플릿 18종** `TEMPLATES` (:251): 카드 입금 정산(수수료 자동 계산), 상품권·바우처 입금, 매입(적격증빙+과세 계정일 때만 135 분리), 선급비용(→ 월 배분 일정 자동 등록), 자산 취득(→ 감가상각 일정 자동 등록), 대관 세금계산서 매출, 급여(예수금·사업주 보험), 부가세 납부, 자본·인출·차입 등.
- **결산 수정분개**:
  - 기간배분·감가상각 `buildScheduleVouchers` (:377): 월할로 계산하고 끝전은 마지막 달에 붙인다.
  - 부가세 정리 `buildVatClearingVouchers` (:402): 6월·12월 말에 220과 135를 상계하고 차액을 205 또는 141로 보낸다. 예정고지 납부분(205 차변)과 자동 상계된다.
- **연 마감** `buildYearCloseVouchers` (:426): 수익·비용 → 320 → 301로 대체하고, 302 인출금 → 301도 처리한다. **개인사업자 가정**이다.
- **장부 조립** `assembleBooks` (:615): 자동 전표는 저장하지 않고 매번 원천 데이터에서 다시 만든다. 월 잠금 시에만 `lockSnapshot`으로 고정하고, 잠근 뒤 원천이 바뀌면 `LOCKED_SOURCE_CHANGED`로 경고한다.
- **검증** `validate` (:552): 엑셀 검증 시트의 9개 항목에 다음을 더했다.
  - 계정별 합계 누락(TB_INCOMPLETE)
  - 전표별 H열과 세액 계정 불일치(VAT_LINE_MISMATCH)
  - 수기·자동 매출 같은 날 중복(DUPLICATE_SALES)
  - 현금 음수(NEGATIVE_CASH)
  - 카드 미정산 경과(CARD_UNSETTLED, 선입선출)
  - 제안: 연간 비용 일시 처리(LUMP_EXPENSE), 재료비가 소모품비로 처리됨(COGS_AS_SUPPLIES)
- **엑셀 입출력**:
  - 내보내기: `toMinisetRows`/`toTsv`/`toCsv` (:666~)
  - 가져오기: `parseMinisetRows` (:676). 엑셀 날짜 일련번호를 처리한다.
  - 결산 xlsx 생성과 xlsx 읽기는 화면에서 SheetJS를 `cdn.jsdelivr.net/npm/xlsx@0.18.5`에서 **필요할 때만** 불러온다.
- **화면 데이터 출처**:
  - 로컬 `bongplay_order_items`, `bongplay_order_payments`, `bongplay_closing_records_history`
  - 서버 월 조회 `BongplaySync.select`. KST 월 경계(+09:00 인코딩), 1000행 단위로 offset 페이징한다.

## 3. 저장·보안

- 수기 전표, 일정, 잠금, 설정은 **브라우저 localStorage `bongplay_accounting_v1`에만** 있다. 서버 저장은 하지 않는다. ⑦ 탭에서 JSON 백업과 복원을 할 수 있다.
- 운영 테이블이 anon `using(true)` 구조라서 재무 데이터를 Supabase에 올리지 않았다. 서버 저장이 필요하면 인증 설계(ANT-003a)와 함께 결정해야 한다.
- 페이지 접근 통제는 없다(기존 경영 페이지와 동일). 서버 조회는 기존 anon 읽기 권한 범위 안에서만 한다.

## 4. 검증 결과

| 항목 | 결과 | 근거 |
|---|---|---|
| 엔진 회귀 | 11/11 통과 | `node --test 01_봉플레이_운영시스템/tests/accounting_engine.test.js` |
| 기존 회귀 | operations_integrity 29/29, screen_survey 28/28 | master 기준 worktree에서 실행 |
| 실데이터 대조 | 엔진 결과가 엑셀과 일치: 차대 106,592,717, 수익 3,155,500, 비용 43,050,000, 순손익 −39,894,500 | 일회성 scratch 스크립트. 실데이터는 저장소에 넣지 않음 |
| 브라우저 | 7개 탭 렌더, 템플릿 저장과 일정 등록, 붙여넣기 불러오기, 중복 감지와 해소, 월 잠금, CSV 내보내기, SheetJS 로드, 375px 폭 가로 스크롤 없음, 콘솔 오류 0건 | 빈 config 샌드박스(localhost:8767), 합성 POS 데이터 |
| 배포 ZIP | `build_deploy_zip.ps1` 정상 실행(dirty 아님), 49개 항목, 회계 2개 포함, 금지 항목·역슬래시 0건 | ZIP SHA-256 `f44ba65796f0beb8588f103910c443637799b6f5c86dd7d9a8712f9447c5196f` |

**미검증**:
- 실제 Supabase 월 조회와 페이징
- 결산 xlsx 파일 내용(생성 호출까지만 확인)
- Netlify 업로드와 배포 후 동작
- 실제 POS 데이터로 만든 자동전표

`screen_survey.test.js`는 실행할 때 `docs/qa/evidence/ANT-001/screen_survey_manifest.json`을 다시 쓴다. 두 checkout 모두 원복했다.

## 5. 배포 산출물 (대표 요청으로 생성)

- `01_봉플레이_운영시스템/bongplay_deploy.zip` + `bongplay_deploy.verify.json`. 커밋 95890aa 기준이다.
- master 기준이므로 **ANT-005의 '웰컴 음료 1잔 포함' 문구 변경 5개 파일은 포함되지 않았다**.
- 이전 ZIP(09-28)은 `_보관/bongplay_deploy_20260928_이전배포.zip`에 있다.
- 빌드 중 공개 설정 `assets/config.js`를 임시 worktree에 복사했다(내용은 읽지 않았다). worktree는 삭제했다.

## 6. 저장소 밖·브랜치 밖 변경 (벤 확인 필요)

- **`회계_최소셋.xlsx` (프로젝트 루트)**: 대표 요청으로 Excel COM을 써서 수정했다. 원본은 `_보관/회계_최소셋_백업_20261008_수정전.xlsx`에 백업했다.
  - 시산표 29행에 103 카드매출미정산금을 추가했다. 이 행이 빠져 계정별 합계가 93,450 불일치였는데, 상단 판정은 "일치"로 나오고 있었다.
  - V-2026-10-005 H20·H21에 부가세액을 넣었다. 매출세액이 307,677에서 315,550으로, 환급 예상이 −3,997,323에서 −3,989,450으로 바뀌었다.
  - 검증 16행에 계정 행 누락 점검을 추가했다.
  - 이 파일은 ANT-005 계열 커밋 `3bada78`에서 git 추적 중이고 `origin/master`에는 없다. **실거래 데이터이므로 커밋하지 않는 것을 권장한다** (AGENTS.md "실제 운영 데이터는 커밋하지 않는다").
- **ANT-005 작업 폴더**: `assets/bongplay-accounting.js`, `pages/accounting.html`, `tests/accounting_engine.test.js`는 미추적, `index.html`, `sw.js`는 수정 상태로 남아 있다. 내용은 95890aa와 같다. 아난티와 충돌하지 않도록 정리할 시점을 벤이 정해 주기 바란다.
- `.git/worktrees/`의 빈 관리 폴더(wt-acct 등)는 권한 거부로 prune되지 않았다. 기존 c008_worktree*와 같은 현상이며 무해하다.

## 7. 벤에게 요청하는 결정

1. CLAUDE-011 작업표 등록, 푸시, master PR 여부.
2. 배포 ZIP을 벤 검토 전에 Netlify에 올려도 되는지(대표에게 이미 전달함).
3. ANT-005 폴더의 미커밋 사본 정리 방법(되돌리기 또는 유지).

## 8. 대표 판단 대기 (대표에게 질문함, 미응답)

1. 자동매출 시작일: 10/1~10/6은 엑셀 수기 매출(V-005, V-008)과 이중 계상될 위험이 있다.
2. 사업자 유형(개인 일반과세 가정). 법인이면 연 마감 계정을 바꿔야 한다.
3. 엑셀 '계정과목' 시트에 205·509를 추가할지.
4. 매점 회원 할인율 10%는 이전 작업에서 쓴 임시값이며 아직 확정되지 않았다.

## 9. 후속 과제 후보

- VAN/PG 정산 내역 자동 연동: 현재는 카드 입금액을 손으로 입력한다.
- 회계 상태 서버 저장: 인증 설계 이후.
- 실제 Supabase에서의 월 조회 실사용 검증(지오 배정 후보).
