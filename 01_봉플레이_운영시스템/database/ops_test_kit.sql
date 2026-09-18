-- ============================================================================
--  ops_test_kit.sql — 디스코드 경보 1개월 파일럿 테스트 키트
-- ----------------------------------------------------------------------------
--  ⚠ 테스트 전용입니다. 파일럿 종료 후 반드시 7절(정리)을 실행하십시오.
--  ⚠ 모든 테스트 행의 id 는 'TEST-' 로 시작합니다.
--     7절 정리 스크립트는 'TEST-%' 만 지우므로 실제 운영 데이터는 건드리지 않습니다.
--
--  사용법: 필요한 절의 주석을 풀고 SQL Editor 에서 Run
--  순서  : 0 → 1(1-1~1-7) → 2 → 3 → 4 → 5 → (한 달간 6 반복) → 7
-- ============================================================================


-- ============================================================================
--  0. 현재 상태 (테스트 시작 전 기준선)
-- ============================================================================
-- select * from public.ops_discord_health;
-- select jobname, schedule, active from cron.job where jobname like 'bongplay%' order by jobname;
-- select channel_key, label, enabled, include_free_text from public.ops_discord_webhooks order by channel_key;


-- ============================================================================
--  1. 트리거 단발 테스트 — "이 알림이 이 채널로 오는가"
--     각 항목: INSERT → select public.ops_discord_flush() → 디스코드 확인
--     ★ id 에 시각이 들어가므로 반복 실행해도 매번 새 알림이 나갑니다.
-- ============================================================================

-- 1-1. 보통 사고 → 🚨 비상 (주황 카드)
-- insert into public.incident_logs
--   (id, occurred_at, severity, location, target_type, facility_id,
--    description, action_taken, notified_guardian, called_119)
-- values
--   ('TEST-INC-' || to_char(now(),'MMDDHH24MISS'),
--    to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'), 'moderate',
--    '실내놀이동 입구', '이용 어린이', 'indoor_trampoline',
--    '테스트: 미끄럼틀 하단에서 넘어짐', '테스트: 냉찜질 후 보호자 인계', true, false);
-- select public.ops_discord_flush();

-- 1-2. 119 출동 → 🚨 비상 (적색, 최우선 순위 1)
-- insert into public.incident_logs
--   (id, occurred_at, severity, location, target_type, facility_id,
--    description, action_taken, notified_guardian, called_119)
-- values
--   ('TEST-119-' || to_char(now(),'MMDDHH24MISS'),
--    to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'), 'serious',
--    '야외 짚코스터 하차장', '이용 어린이', 'outdoor_coaster',
--    '테스트: 하차 중 발목 접질림', '테스트: 119 신고 및 응급처치', true, true);
-- select public.ops_discord_flush();

-- 1-3. 중대민원 1건 → ⚠️ 민원·리스크
-- insert into public.complaint_logs
--   (id, received_at, channel, complaint_type, severity, content, status)
-- values
--   ('TEST-CMP-' || to_char(now(),'MMDDHH24MISS'),
--    to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'), '현장', '응대', 'serious',
--    '테스트: 안전요원 응대 불친절', 'open');
-- select public.ops_discord_flush();

-- 1-4. 중대민원 2건째 → 🚨 계약 리스크 경보
--      (1-3 을 먼저 실행한 뒤 이걸 실행 → 누적 2건으로 계산되어 리스크 경보 발동)
--      ※ 이미 실제 중대민원이 1건 이상 있으면 1-3 만으로도 발동합니다.
-- insert into public.complaint_logs
--   (id, received_at, channel, complaint_type, severity, content, status)
-- values
--   ('TEST-CMP2-' || to_char(now(),'MMDDHH24MISS'),
--    to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'), '전화', '안전우려', 'serious',
--    '테스트: 대기줄 안전사고 우려 제기', 'escalated');
-- select public.ops_discord_flush();

-- 1-5. 마감 정산 → 📊 일일 (BEP 미달/근접/달성 판정)
--      먼저 그날 매출을 확인한다. do nothing 이라 기존 실데이터를 덮어쓰지 않는다.
-- insert into public.sales_records (id, date, total_revenue, total_visitors, op_mode)
-- values (to_char((now() at time zone 'Asia/Seoul'),'YYYY-MM-DD'),
--         (now() at time zone 'Asia/Seoul')::date, 420000, 35, 'weekday')
-- on conflict (id) do nothing;
--
-- insert into public.closing_records (id, date, manager, actual_cash, diff, notes)
-- values ('TEST-CLS-' || to_char(now(),'MMDDHH24MISS'),
--         (now() at time zone 'Asia/Seoul')::date, '테스트 마감자', 420000, 0, '테스트 마감');
-- select public.ops_discord_flush();

-- 1-6. 기상 임계 → 🔧 설비 (강풍 12.0 m/s 이상)
--      ※ dedupe 키에 '시(hour)' 가 들어가므로 같은 시간대엔 1건만 나갑니다.
-- insert into public.weather_environment_telemetry (id, wind_gust, rainfall, weather_warning)
-- values ('TEST-WX-' || to_char(now(),'MMDDHH24MISS'), 13.8, 0, 'none');
-- select public.ops_discord_flush();

-- 1-7. 준사고 → 🔧 설비 (즉시 발송 아님. 5절 다이제스트로 확인)
-- insert into public.incident_logs
--   (id, occurred_at, severity, location, description, action_taken)
-- values
--   ('TEST-NM-' || to_char(now(),'MMDDHH24MISS'),
--    to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'), 'near_miss',
--    '트램펄린 존', '테스트: 착지 직전 발이 걸릴 뻔함', '테스트: 매트 정렬 조치');


-- ============================================================================
--  2. 중복 방지 검증 — 오프라인 재전송 시뮬레이션
--     기대값: 디스코드에 1건만 도착. 큐에도 1행만 존재.
-- ============================================================================
-- select public.ops_discord_enqueue('emergency','dedupe_test','TEST-DUP-1','v1',
--   public.ops_embed('🧪 중복 테스트', 6583435,
--     jsonb_build_array(jsonb_build_object('name','회차','value','1회차','inline',true))));
-- select public.ops_discord_enqueue('emergency','dedupe_test','TEST-DUP-1','v1',
--   public.ops_embed('🧪 중복 테스트', 6583435,
--     jsonb_build_array(jsonb_build_object('name','회차','value','2회차','inline',true))));
-- select public.ops_discord_flush();
--
-- select count(*) as 큐행수, max(payload->'embeds'->0->>'description') as "설명"
--   from public.ops_discord_queue
--  where source_table = 'dedupe_test' and source_id = 'TEST-DUP-1';
-- → 큐행수 1 이면 정상. 2 가 나오면 멱등성 깨진 것이므로 즉시 보고.


-- ============================================================================
--  3. 개인정보 마스킹 검증  ★ 실제 고객 데이터 투입 전 필수 관문 ★
--     기대값: 디스코드 메시지에 전화번호·이름이 없어야 한다.
-- ============================================================================
-- update public.ops_discord_webhooks set include_free_text = true where channel_key = 'emergency';
--
-- insert into public.incident_logs
--   (id, occurred_at, severity, location, target_type, description, action_taken,
--    person_name, person_phone)
-- values
--   ('TEST-PII-' || to_char(now(),'MMDDHH24MISS'),
--    to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'), 'serious', '짚코스터',
--    '이용 어린이',
--    '테스트: 보호자 홍길동(010-1234-5678) 동반. 자녀 김민준 7세 낙상.',
--    '테스트: 보호자 홍길동에게 010-1234-5678 로 통보 완료',
--    '홍길동', '010-1234-5678');
-- select public.ops_discord_flush();
--
-- → 디스코드 카드에 [연락처] / [이름] 으로 치환되어 있어야 정상.
--   '010-1234-5678' 이나 '홍길동', '김민준' 이 보이면 즉시 중단하고 보고.
--
-- 검증 후 반드시 원상복구:
-- update public.ops_discord_webhooks set include_free_text = false where channel_key = 'emergency';


-- ============================================================================
--  4. 대기열 폭주 테스트 — 오프라인 복구 시 30건이 몰려 올라오는 상황
--     ★ 권장: 비상 웹훅을 임시로 "테스트 채널"로 돌려놓고 실행
--            (실제 비상 채널이 테스트 메시지로 오염되지 않게)
-- ============================================================================
-- update public.ops_discord_webhooks
--    set webhook_url = '여기에_테스트채널_웹훅_URL'
--  where channel_key = 'emergency';
--
-- insert into public.incident_logs
--   (id, occurred_at, severity, location, description, action_taken)
-- select 'TEST-FLOOD-' || to_char(now(),'MMDDHH24MISS') || '-' || g,
--        to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS'), 'moderate', '폭주 테스트 지점',
--        '폭주 테스트 ' || g, '폭주 테스트 조치'
--   from generate_series(1, 30) g;
--
-- select public.ops_discord_flush();   -- 채널당 상한 6 → 6건 전송, 24건 대기
-- select channel_key, status, count(*) from public.ops_discord_queue group by 1,2 order by 1,2;
-- → 기대: sent 6 / queued 24. 1분마다 자동으로 6건씩 소진됩니다.
-- → 디스코드에 429(속도 제한) 오류가 쌓이면 상한을 낮춥니다 (6 → 3).
--
-- 확인 후 원상복구:
-- update public.ops_discord_webhooks
--    set webhook_url = '여기에_비상_사고경보_URL'
--  where channel_key = 'emergency';


-- ============================================================================
--  5. 정기 알림 수동 호출 — 시계를 기다리지 않고 즉시 검증
--     ※ 같은 날 재실행하면 dedupe 에 막혀 안 나갑니다 (정상 동작).
--        다시 테스트하려면 아래 "재테스트용 삭제" 를 먼저 실행하십시오.
-- ============================================================================
-- select public.ops_daily_briefing();     -- 🌤 개장 브리핑 → 📊 daily
-- select public.ops_safety_audit_check(); -- ⚠ 점검 미실시 / 🚧 부적합 → 🔧 facility
-- select public.ops_asset_check();        -- 🔧 설비 수명·점검 공백 → 🔧 facility
-- select public.ops_nearmiss_digest();    -- 📋 준사고 일지 → 🔧 facility
-- select public.ops_discord_flush();
--
-- 재테스트용 삭제 (그날의 정기 알림만, 매우 좁은 범위):
-- delete from public.ops_discord_queue
--  where source_table in ('cron_briefing','cron_safety_audit','cron_asset','cron_nearmiss')
--    and source_id = to_char((now() at time zone 'Asia/Seoul')::date, 'YYYY-MM-DD');


-- ============================================================================
--  6. 측정 쿼리 — 한 달간 주 1회 실행해서 숫자로 남기십시오
-- ============================================================================

-- (a) 일별·채널별 발송량 (알림 피로의 원천 데이터)
-- select (created_at at time zone 'Asia/Seoul')::date as 일자,
--        channel_key,
--        count(*) as 건수,
--        count(*) filter (where status = 'sent') as 성공,
--        count(*) filter (where status = 'dead') as 실패
--   from public.ops_discord_queue
--  group by 1, 2 order by 1 desc, 2;

-- (b) 알림 지연 (생성 → 발송 완료까지 초)
-- select channel_key,
--        count(*) as 건수,
--        round(avg(extract(epoch from (updated_at - created_at)))) as 평균초,
--        max(round(extract(epoch from (updated_at - created_at)))) as 최대초
--   from public.ops_discord_queue
--  where status = 'sent' and created_at > now() - interval '30 days'
--  group by 1 order by 1;

-- (c) 채널별 일평균 (목표: 비상 ≤ 1, 민원 ≤ 1, 일일 2~3, 설비 2~3)
-- select channel_key,
--        count(*) as 총건수,
--        round(count(*)::numeric / 30, 1) as 일평균
--   from public.ops_discord_queue
--  where created_at > now() - interval '30 days'
--  group by 1 order by 2 desc;

-- (d) 영구 실패 목록 (비어 있어야 정상)
-- select id, channel_key, source_table, source_id, error, created_at
--   from public.ops_discord_queue where status = 'dead' order by id desc limit 50;


-- ============================================================================
--  7. 정리 — 파일럿 종료 시 실행
-- ----------------------------------------------------------------------------
--  ★ 반드시 (A) 미리보기로 개수를 확인한 뒤 (B) 삭제를 실행하십시오.
--     'TEST-%' 접두어 행만 지웁니다. 실제 운영 데이터는 삭제되지 않습니다.
-- ============================================================================

-- (A) 미리보기 — 무엇이 몇 건 지워지는지 먼저 확인
-- select 'incident_logs' as 테이블, count(*) as 건수 from public.incident_logs where id like 'TEST-%'
-- union all select 'complaint_logs',  count(*) from public.complaint_logs where id like 'TEST-%'
-- union all select 'closing_records', count(*) from public.closing_records where id like 'TEST-%'
-- union all select 'safety_audits',   count(*) from public.safety_audits where id like 'TEST-%'
-- union all select 'weather_environment_telemetry', count(*) from public.weather_environment_telemetry where id like 'TEST-%'
-- union all select 'equipment_assets', count(*) from public.equipment_assets where asset_id like 'TEST-%'
-- union all select 'asset_usage_counters', count(*) from public.asset_usage_counters where asset_id like 'TEST-%'
-- union all select 'ops_discord_queue', count(*) from public.ops_discord_queue where source_id like 'TEST-%'
-- order by 1;

-- (B) 삭제
-- begin;
-- delete from public.ops_discord_queue            where source_id like 'TEST-%';
-- delete from public.incident_logs                where id like 'TEST-%';
-- delete from public.complaint_logs               where id like 'TEST-%';
-- delete from public.closing_records              where id like 'TEST-%';
-- delete from public.safety_audits                where id like 'TEST-%';
-- delete from public.weather_environment_telemetry where id like 'TEST-%';
-- delete from public.equipment_assets             where asset_id like 'TEST-%';
-- delete from public.asset_usage_counters         where asset_id like 'TEST-%';
-- commit;

-- (C) 테스트로 생성된 큐 기록 정리 (원천 알림 큐만)
-- delete from public.ops_discord_queue
--  where source_table in ('dedupe_test','manual_test',
--                         'cron_briefing','cron_safety_audit','cron_asset','cron_nearmiss');

-- (D) 90일 지난 성공/실패 기록 정리 (월 1회 상시 운영 규칙)
-- delete from public.ops_discord_queue
--  where status in ('sent','dead','skipped') and created_at < now() - interval '90 days';
