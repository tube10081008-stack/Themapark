# ANT-007: 리플레이스 실증 데이터 시제품 (Operational Evidence Prototype)

## 1. 개요 및 목적
본 시제품은 **봉플레이(BongPlay)** 현장 운영 기록을 기반으로 문제를 진단하고, 운영 변경에 따른 정량/정성적 결과를 객관적으로 검토하며, 타 현장(예: 타 지점 키즈카페 및 복합문화공간)에 전파 가능한 **운영 표준 지침(SOP)**을 도출하는 대시보드 시제품입니다.

> **주의 및 제약 사항:**
> - **회계 연결 제외**: 재무 시스템/회계 원장과의 연결은 엄격히 배제되었습니다.
> - **합성 데이터 격리**: 실제 고객 개인정보, 운영 DB, 외부 API와 분리된 시제품 전용 합성 데이터(`data/synthetic_evidence_data.json`)만 사용합니다.
> - **기존 정책 및 실험 보호**: 현장 고객 대상의 실제 실험이 아니며, 기존 운영 정책을 변경하지 않습니다.
> - **포트 격리**: 기존 지오 시험 환경(4189)과 충돌하지 않도록 기본 포트 `4192`를 사용합니다.

---

## 2. 핵심 화면 구성 및 엄격한 판정 원칙

### ① 데이터 품질 화면 (Data Quality Dashboard)
- **4단계 품질 상태 분류**:
  - `정상 (healthy)`: 전송 및 검증 완료, 정합성 100%.
  - `일부 누락 (partial_missing)`: 일부 필드 결측(예: 보호자 설문 완료율 78%).
  - `오래된 자료 (stale)`: 최종 갱신 시각 기준 24시간 초과 경과.
  - `확인 불가 (unverifiable)`: 통신 단절, 파서 오류 또는 집계 불능.
- **수치 왜곡 방지 원칙**:
  - **조회 실패 및 확인 불가는 절대 0건으로 왜곡 표기하지 않습니다.** (`total_records: null` 유지 및 '확인 불가 (오류)' 배지 표시)
  - 최종 갱신 시각(ISO 8601 및 상대 시각)을 각 데이터셋별로 명확히 표시합니다.

### ② 실험 카드 (Experiment Cards)
- **주제 예시**: 보호자 웰컴 음료 서비스 도입 영향 분석
- **구조화 항목**: 가설, 변경 내용, 대상, 기간, 비교 방식, 지표, 표본 수, 결과, 다음 결정
- **엄격한 라벨링 원칙**:
  - **표본 부족 (`N < 30`)**: 성공/실패 단정이 불가하므로 반드시 `판단 보류 (표본 부족)`로 라벨링 (예: EXP-003 VIP 케어룸 사전 시범).
  - **단순 전후 비교**: 대조군이 없는 단순 시계열 비교는 인과관계를 입증할 수 없으므로 `관찰 결과 (단순 전후 비교)`로 격리 표기 (예: EXP-002 주말 동선 안내 사이니지).
  - **A/B 테스트 대조군 검증**: 동시 무작위 대조군이 확보된 경우에만 `검증 완료 (유의미한 개선)` 표시 (예: EXP-001 웰컴 음료 도입).
  - **비용 미입력 가드**: 원가 데이터가 미입력된 경우 **0원 또는 수익성 검증 완료로 왜곡하지 않고**, `비용 미입력 (수익성 미검증 / ROI 산정 보류)` 경고를 노출합니다.

### ③ 운영 지침 (Standard Operating Procedures - SOP)
- **구성 요소**: 적용 조건, 실행 절차(단계별 프로토콜), 실증 근거, 한계 및 주의점, 타 현장 재검증 항목
- **타 현장 확장성**: 타 매장 도입 시 필수 검증 항목(원가 변동성, 인력 부담도, 객단가 연계)을 명시하여 무분별한 전파를 방지합니다.

---

## 3. 실행, 확인 및 종료 방법

### 빠른 실행 (기본 포트: 4192)

#### Windows PowerShell
```powershell
# 실행 (백그라운드 프로세스로 기동)
.\prototypes\evidence\ANT-007\run_prototype.ps1 -Port 4192

# 포트 지정 실행 (예: 4195)
.\prototypes\evidence\ANT-007\run_prototype.ps1 -Port 4195
```

#### Windows Batch (cmd)
```cmd
.\prototypes\evidence\ANT-007\run_prototype.bat 4192
```

#### Node.js 직접 실행
```bash
node prototypes/evidence/ANT-007/server.js --port 4192
```

---

### 준비 확인 (Ready URL) 및 접속
- **준비 확인 (Health Check)**: `GET http://127.0.0.1:4192/ready`
  - 응답: `{"status":"ready","version":"1.0.0","uptime":...,"timestamp":...}`
- **대시보드 웹 접속**: `http://127.0.0.1:4192/`
- **합성 데이터 API**: `GET http://127.0.0.1:4192/api/evidence/all`

---

### 안전 종료 (Shutdown)

#### Windows PowerShell
```powershell
.\prototypes\evidence\ANT-007\stop_prototype.ps1 -Port 4192
```

#### Windows Batch (cmd)
```cmd
.\prototypes\evidence\ANT-007\stop_prototype.bat 4192
```

#### API 원격 종료
```bash
curl -X POST http://127.0.0.1:4192/api/evidence/shutdown
```

---

## 4. 시나리오 주입기 (7종 시나리오)

대시보드 상단의 시나리오 스위처 버튼을 통해 다양한 환경을 즉시 테스트할 수 있습니다:
1. **정상 (Normal)**: 5종 원장 데이터셋 및 실험 카드 정상 로드.
2. **빈 자료 (Empty)**: 데이터 건수 0건 상태의 빈 화면 가이드 표시.
3. **지연 (Delayed)**: 네트워크 2.5초 지연 및 스켈레톤 로딩 UX 확인.
4. **실패 (Failure)**: 서버 500 오류 주입 시 전역 장애 배너 표시 (기존 정상 데이터 캐시 유지 및 0건 표기 차단).
5. **복구 (Recovered)**: 장애 후 정상 재조회 및 복구 배너 안내.
6. **중복 자료 (Duplicate)**: 동일 ID 중복 유입 시 중복 감지 경고 배너 및 중복 필터링 적용.
7. **모바일 뷰 (Mobile View)**: 390px 스마트폰 화면 프리뷰 모달 제공.

---

## 5. 자동 검증 스위트 (`verify_prototype.js`)

각 검증 항목에 타임아웃(3000ms)이 적용된 자동화 검증 스크립트입니다.

```powershell
node prototypes/evidence/ANT-007/verify_prototype.js --port 4192
```

### 전수 검증 항목 (8/8 PASS)
1. `GET /ready` 헬스체크 및 포트 격리 검증
2. `GET /api/evidence/all` 합성 데이터 무결성 검증
3. 품질 4단계 분류 (`healthy`, `partial_missing`, `stale`, `unverifiable`) 및 갱신 시각 검증
4. **조회 실패 시 0건 왜곡 방지** (`total_records: null` 유지 확인)
5. **표본 부족 건 `판단 보류` 판정** (EXP-003, N=8)
6. **단순 전후 비교 건 `관찰 결과` 표기** (EXP-002)
7. **비용 미입력 시 `0원/수익성 검증 완료` 왜곡 차단 및 경고 노출** (EXP-001)
8. 시나리오 주입 파라미터(`empty`, `delay`, `error`, `duplicate`) 동작 검증
