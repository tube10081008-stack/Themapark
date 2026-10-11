# ANT-007: 리플레이스 실증 데이터 시제품 (Operational Evidence Prototype v1.1.0-r2)

## 1. 개요 및 목적
본 시제품은 **봉플레이(BongPlay)** 현장 운영 기록을 기반으로 문제를 진단하고, 운영 변경에 따른 정량/정성적 결과를 객관적으로 검토하며, 타 현장(예: 타 지점 키즈카페 및 복합문화공간)에 전파 가능한 **운영 표준 지침(SOP)**을 도출하는 대시보드 시제품입니다.

> **주의 및 제약 사항:**
> - **회계 연결 제외**: 재무 시스템/회계 원장과의 연결은 엄격히 배제되었습니다 (수익성 판단 제외).
> - **합성 데이터 격리**: 실제 고객 개인정보, 운영 DB, 외부 API와 분리된 시제품 전용 합성 데이터(`data/synthetic_evidence_data.json`)만 사용합니다.
> - **기존 정책 및 실험 보호**: 현장 고객 대상의 실제 실험이 아니며, 기존 운영 정책을 변경하지 않습니다.
> - **포트 격리**: 기존 지오 시험 환경(4189)과 충돌하지 않도록 기본 포트 `4192`를 사용합니다.

---

## 2. 벤(Ben) R1 검토 반영 핵심 개선 사항

### ① 최초 조회 실패 Fallback 및 오프라인 모드 분리
- **연결 상태 왜곡 차단**: 네트워크 오류나 HTTP 500 발생 시 더미 데이터를 채우고 `fetchError`를 지워 '실시간 연결됨'으로 속이던 구버전 문제를 완전히 제거했습니다.
- **오프라인 예제 모드 분리**: `오프라인 예제 모드 (실서버 미연결)`는 사용자가 수동 진입할 때만 활성화되며, 실제 네트워크 연결 상태와 엄격히 분리됩니다.
- **전 탭 일관 표시**: 조회 실패 시 직전 성공 데이터가 있으면 **오래된 자료(캐시 유지)**와 **마지막 성공 시각**을 표기하고, 초기 조회 실패 시 **확인 불가 (수신 실패)**를 모든 탭 상단 배너로 일관되게 표시합니다.
- **타임아웃 & 경합(Race Condition) 방지**: `AbortController` 기반 4초 타임아웃을 적용하고, 요청 시퀀스 ID 가드를 통해 오래된 지연 응답이 최신 결과를 덮어쓰지 못하도록 차단했습니다.

### ② 실험 판정 고도화 및 3단계 평가 분리
- **A/B 명칭 또는 임의 표본만으로 개선·유의성·성공 확정 금지**:
  - **사전 표본 계획 부재 (`unplanned`)**: 표본 수가 많아도 **`판단 보류 (사전 표본 계획 부재)`**로 강제 분류 (EXP-004).
  - **표본 수 기준 미달 (`N < 목표치`)**: **`판단 보류 (표본 부족)`**로 분류 (EXP-003, N=8/30).
  - **단순 전후 비교 (`before_after`)**: 외생변수 미통제로 인과성을 입증할 수 없으므로 **`관찰 결과 (단순 전후 비교)`**로 한계 명시 (EXP-002).
  - **사전 계획 충족 A/B 테스트**: 개선 확정이 아닌 **`검토 가능 (합성 자료 관찰)`**로 엄격 표기 (EXP-001).
- **3단계 분리 평가**:
  1. `합성 결과`: 모의 수치 관찰 판정
  2. `운영 승인`: 현장 관리자 승인 상태 (대기 / 조건부 검토 / 보류)
  3. `타 현장 재현`: 안동/영주 등 타 현장 재현 실측 여부 (미실시 / 전제 미충족)
- **비용 null / 0 / 값 구분**:
  - `비용 미입력 (null)` / `명시적 비용 0원` / `단위 원가 850원`을 엄격히 구분하고, 모든 경우에 **수익성 판단은 전면 제외(회계 비연결 원칙)**합니다.
- **자료 이중 관리 제거**: `app.js` 내부의 방대한 `FALLBACK_DATA` 중복을 제거하고 단일 API 원천으로 정돈했습니다.

### ③ 중복 원장 정제 3대 범주 분류
- **동일 ID · 동일 내용 재전송 (`idempotent_retransmission`, 16건)**: 네트워크 지연 재시도로 멱등 필터링 적용.
- **동일 ID · 다른 내용 충돌 (`data_conflict_collision`, 4건)**: 속성값 불일치로 무결성 경고 격리.
- **별개 독립 사건 (`independent_events`, 210건)**: 정상 트랜잭션으로 집계 반영 (중복 오탐 방지).

### ④ 375px/390px 좁은 화면(모바일) 가로 넘침(Overflow) 방지
- 상단 툴바 `flex-wrap`, 텍스트 축약 `min-w-0`, `truncate`, 본문 레이아웃 `overflow-x-hidden`, 테이블 래퍼 `overflow-x-auto`를 적용하여 375px 화면에서도 가로 스크롤 깨짐 없이 탭 전환, 에러 배너, 복구 배너가 안정적으로 렌더링됩니다.

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
  - 응답 포맷:
    ```json
    {
      "ok": true,
      "status": "ready",
      "service": "ANT-007-evidence-prototype",
      "version": "1.1.0-r2",
      "is_synthetic": true,
      "environment": "synthetic_prototype",
      "port": 4192,
      "server_pid": 12345,
      "active_scenario": "normal",
      "edge_cases_supported": [
        "cost_null",
        "cost_zero",
        "cost_valued",
        "zero_denominator",
        "sample_plan_unplanned"
      ],
      "timestamp": "2026-10-11T09:48:00.000Z"
    }
    ```
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

## 4. 엣지 케이스 주입 및 테스트 수단

### ① 대시보드 UI 버튼을 통한 원터치 주입
- 상단 툴바 2번째 줄에서 즉시 토글 가능:
  - `[비용: null]` / `[비용: 0원]` / `[비용: 850원]`
  - `[분모: 0 토글]`
  - `[표본계획: 미정]`
  - `[경합 덮어쓰기 방지 시험]`

### ② API 쿼리 파라미터를 통한 주입
- `GET /api/evidence/all?cost=null`
- `GET /api/evidence/all?cost=zero`
- `GET /api/evidence/all?cost=valued`
- `GET /api/evidence/all?zero_denom=1`
- `GET /api/evidence/all?sample_plan=unplanned`

---

## 5. 자동 검증 스위트 (`verify_prototype.js`)

각 검증 항목에 타임아웃(3000ms)이 적용된 자동화 검증 스크립트입니다.

```powershell
node prototypes/evidence/ANT-007/verify_prototype.js --port 4192
```

### 전수 검증 항목 (10/10 PASS)
1. `/ready` 헬스체크: 판본(1.1.0-r2), 합성 환경 플래그, 포트 격리(4189 불간섭)
2. 데이터 품질 4단계 분류 & 조회 실패 0건 왜곡 방지 (null 유지)
3. 최초 조회 실패 fallback 수정: 오프라인 예제 모드 분리 & 전 탭 캐시/확인불가 표기
4. 실험 판정: 사전 계획 부재(보류)·단순전후(관찰)·충족(검토가능) & 3단계 분리
5. 엣지 케이스 동적 주입: 비용 null/0/값, 분모0(N/A), 표본계획미정 100% 일치
6. 중복 3대 범주 분류: 동일내용 재전송(16건 멱등) vs 충돌(4건 격리) vs 별개사건(210건 정상)
7. 지연 시나리오 및 요청 제한시간(타임아웃) 검증
8. 오래된 응답 경합 덮어쓰기(Race Condition) 방지 가드 검증
9. 좁은 화면(375px/390px) 탭 전환·오류·복구·가로 넘침(Overflow-x) 방지 구조 검증
10. 500 장애 주입 후 정상 복구 및 정적 자산 무결성 검증

---

## 6. 지오(Aside)의 재시험 준비 및 인수인계 절차

지오가 실제 브라우저(Aside × Sakana Fugu Pro 연동) 환경에서 본 시제품을 검증할 수 있도록 아래의 절차를 제공합니다:

1. **포트 충돌 확인**:
   - 지오의 기존 시험 서버(`4189`)가 유지 중인지 확인하고, 본 시제품은 격리된 `4192` 포트에서 기동합니다.
2. **시제품 서버 기동**:
   ```powershell
   .\prototypes\evidence\ANT-007\run_prototype.ps1 -Port 4192
   ```
3. **기동 상태 확인**:
   - `GET http://127.0.0.1:4192/ready` 호출하여 `"version": "1.1.0-r2"`, `"is_synthetic": true`, `"status": "ready"` 확인.
4. **브라우저 접속 및 시나리오 검증**:
   - 브라우저로 `http://127.0.0.1:4192/` 접속.
   - 상단 툴바에서 `[4. 실패 (500)]` 클릭 시: 상단 연결 배지가 `연결 장애`로 바뀌고, 모든 탭 상단에 장애 배너가 뜨며 데이터 수치가 0건으로 왜곡되지 않는지 확인.
   - `[5. 복구]` 클릭 시: `실시간 연결됨`으로 정상 복원되는지 확인.
   - `[6. 중복 자료]` 클릭 시: 보라색 중복 정제 배너에서 `동일 내용 재전송 16건 / 다른 내용 충돌 4건 / 별개 사건 210건` 3대 분류가 표출되는지 확인.
   - 엣지 케이스 버튼 `[비용: null]`, `[비용: 0원]`, `[분모: 0]`, `[표본계획: 미정]` 클릭하여 실험 카드 탭에서 실시간 판정 변화 확인.
   - 브라우저 개발자 도구 디바이스 모드(375px / 390px)에서 가로 스크롤 발생 없이 탭 전환이 매끄러운지 확인.
5. **시험 종료 후 정리**:
   ```powershell
   .\prototypes\evidence\ANT-007\stop_prototype.ps1 -Port 4192
   ```
