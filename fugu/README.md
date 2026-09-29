# Fugu persistent workspace

이 폴더는 Codex CLI/PowerShell 세션이 종료되거나 `Ctrl+C`로 중단되어도 남아 있는
**작업 기억, 검증 결과, 변경 감지, 인수인계** 공간이다.

## 시작할 때

```powershell
Set-Location 'C:\Users\bongp\OneDrive\문서\new\fugu'
.\scripts\snapshot.ps1
Get-Content .\INDEX.md
Get-Content .\SNAPSHOT.md
Get-Content .\OPEN_QUESTIONS.md
```

이 폴더의 실제 위치는 `C:\Users\bongp\OneDrive\문서\new\fugu`다. (`C:\Users\bongp\fugu`는 존재하지 않는다.)
`scripts\snapshot.ps1`은 `snapshot.json`·`SNAPSHOT.md`에 쓰기 때문에 쓰기 권한이 없는 세션에서는 실패한다. 그 경우 `snapshot.json`과 현재 파일 목록을 읽기 전용으로 대조한다.

프로젝트 소스는 `config.json`의 `projectRoot`에 지정한다. 현재 기본값은
`C:\Users\bongp\OneDrive\문서\new`이다.

## 파일 역할

- `INDEX.md`: 매 세션 가장 먼저 읽는 짧은 지도와 현재 상태
- `SNAPSHOT.md`: 사람이 읽는 변경 요약
- `snapshot.json`: 파일 메타데이터·해시·제외 목록을 담는 기계용 상태
- `FACTS.md`: 코드/실행 결과로 검증한 사실만 기록
- `DECISIONS.md`: 확인된 사실에 근거한 설계 결정과 변경 이력
- `OPEN_QUESTIONS.md`: 아직 확인하지 못한 질문과 다음 검증 방법
- `LOG.md`: 세션별 append-only 인수인계
- `scripts/snapshot.ps1`: 변경 파일만 우선 검사하는 스냅샷 생성기
- `scripts/status.ps1`: 현재 프로젝트 상태와 위험 신호 요약
- `scripts/session-start.ps1`: 세션 시작 스냅샷·부트스트랩
- `scripts/session-end.ps1`: 세션 인수인계 기록·스냅샷 갱신
- `sessions/`: 선택적 세션 원문/메모. 비밀값은 저장하지 않는다.

## 주의

이 폴더의 기록도 진실 그 자체가 아니다. 각 사실에는 상태, 근거 파일/라인,
확인 날짜를 붙인다. 외부 서비스와 현장 장비는 이 폴더만으로 검증할 수 없다.
