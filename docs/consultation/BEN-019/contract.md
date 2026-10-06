# ANT-005 인수 계약 v1

벤이 2026-10-06 CLAUDE-010/GEO-007을 대행한다. 아난티는 이 폴더를 수정하지 않고 구현 파일을 소유한다. 이 자료는 docs에 있으므로 현재 build-release ZIP에 들어가지 않는다. 필요한 런타임 모듈로 이식하고 명시적 허용 목록에 추가하는 작업은 ANT-005 범위다.

## 세부 지식
`knowledge-blocks.json`은 값 사본을 만들지 않고 기존 knowledge.mjs의 fact ID를 참조한다. `{{id}}`는 서버의 해당 fact.display로만 치환한다. 모델이 값이나 템플릿을 수정하지 않는다.

`required_confirmed` 항목이 하나라도 미확정·누락이면 정상 template을 사용하지 말고 fallback으로 응답한다. model에 전달할 후보도 같은 상태 검사 결과로 만든다. `status_notice`는 미정/계획 상태를 설명하는 고정 문장으로, 해당 상태가 달라지면 재검토 전까지 후보에서 제외한다. `policy`는 가격 사실과 별도로 버전 관리하는 서비스 한계 문장이다.

기존 `SOURCES`와 blob 대조 검사를 유지한다. 이 계약은 티켓 구성·음료 종류·군민 할인 적용권종 등 새로운 confirmed 사실을 추가하지 않는다. 종합권/기본권 활동 구성 비교는 별도 확인된 세부 계약을 만들기 전 일반 시설 안내 수준으로 제한한다. BEN-019 설계의 티켓 비교 예시는 확정 사실 추가의 근거가 아니다.

## 모델 반환 계약
정확히 action, knowledge_ids, opening, follow_up, handoff_reason의 다섯 필드를 사용한다. 추가 속성 금지.
- action: answer / clarify / handoff / out_of_scope.
- knowledge_ids: 이 카탈로그의 ID를 최대 3개, 중복 금지. answer는 최소 1개. clarify/out_of_scope는 0개. handoff는 policy.staff 또는 policy.booking을 포함한다.
- opening: 0~120자. 공감/상황 확인만. 숫자·가격·혜택·시간·링크·처리 약속 금지.
- follow_up: 0~100자, 질문 하나만. 개인정보 요청 금지. 충분한 답변이면 빈 문자열.
- handoff_reason: handoff일 때 complaint/refund/booking_change/eligibility/emergency/staff_confirmation 중 하나. 나머지 action은 null.

생성 문구 검증에 실패하면 그 문구를 폐기한다. 전체 계약 오류는 안전한 기본 답변으로 전환한다. 숫자 정규식만으로 의미 안전성이 보장되지는 않는다. 비수치 약속 공격과 사용자 거짓 주장 평가가 필수다.

## HTTP와 대화 문맥
입력 `{message, history}`. history는 최근 최대 6개 `{role,content}`. role은 user/assistant만, content 최대 800자, 전체 history 3,200자, 현재 message 최대 1,200자. 정규화 후 서버 재검사. request-body 최대 크기는 한글 UTF-8과 JSON overhead를 고려해 별도로 명시하고 최대 경계 시험을 추가한다(기존 8,192바이트 그대로면 정상 상한 대화도 거절될 수 있음).

출력은 기존 answer/mode/source/contact를 유지하고 action/knowledge_ids/follow_up을 추가할 수 있다. 실제 고객 화면에는 공급자 오류나 내부 계약 ID를 노출하지 않는다. 서버의 검증된 과거 답변도 다음 요청에서는 비신뢰 history다. DB 기록은 추가하지 않는다.

## 검증 인계
`conversation-evals.json`의 expected는 의미 기준이다. exact 문장 일치를 강요하지 않는다. `must_not_claim`는 문자열 금칙어 검사가 아니라 긍정 주장 금지이며 '예약을 확정할 수 없어요'를 오탐하면 안 된다. results는 실행 전 not_run으로 둔다. 모의·실제 모델·브라우저 결과를 분리한다.

fixture가 있는 오류 시험은 fixture의 HTTP 상태/호출 횟수를 우선 판정한다. 오류로 정상 응답 계약이 반환되지 않으면 expected.action/knowledge_ids는 검사하지 않는다. '아이 2명' 계산은 현재 1인 요금 설명까지가 필수이며 총액 계산은 별도 서버 산술 계약이 생기기 전 선택 기능으로도 추가하지 않는다. 인사/감사/작별의 clarify 분류는 모델 계획 호환을 위한 분류일 뿐 추가 질문을 강제하지 않는다.

아난티 구현/미리보기가 제출되면 벤이 GEO-007 실사용 평가를 수행한다. 현재 기존 라이브 성공을 새 캐릭터·다중 턴 성공으로 대체 보고하지 않는다.
