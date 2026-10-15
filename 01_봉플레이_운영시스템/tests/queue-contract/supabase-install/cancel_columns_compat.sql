-- ============================================================================
-- 시험 전용: 서약서 취소 3열 마이그레이션(C1) 호환 점검 (CLAUDE-011)
-- ----------------------------------------------------------------------------
-- run_local_install_check.sh H 단계가 호출한다. 3열 없이 설치·운영되던 DB(기존 행 포함)를 전제로
-- PROPOSED_MIGRATION_safety_consents_cancellation.sql 을 두 번 적용하고 다음을 단언한다.
--   1) 반복 적용 오류 없음, 열·인덱스 중복 없음
--   2) 기존 행: 개수 불변, 기존 열 값 불변(새 3열을 뺀 행 전체 해시 비교), status='active'·나머지 null
--   3) 기존 보안 RPC(get_today_consents_secure)가 새 열을 포함해 돌려줌
--   4) anon(앱): 당일 행에 취소 기록 → null 로 해제 모두 허용, 과거 행 수정은 여전히 거부(정책 불변)
-- psql 변수: code(시험 직원 암호), cancel_sql(마이그레이션 파일 경로). 합성 값만 쓴다.
-- ============================================================================
\set ON_ERROR_STOP 1
select set_config('compat.code', :'code', false);

-- 기존 행 흉내: 과거 발권 완료 행, 개인정보 마스킹된 과거 행 (50 단계의 당일 합성 서약서 3건은 이미 있음)
insert into public.safety_consents (id, site_id, created_date, arrival_at, guardian_name, guardian_phone, is_issued, ticket_ids, children)
values
  ('SYN-LEGACY-OLD', 'bongplay_bonghwa', (now() at time zone 'Asia/Seoul')::date - 10, now() - interval '10 days',
   'SYN 과거 보호자', '010-0000-0099', true, '["tkt_SYN_OLD_01"]'::jsonb, '[{"name":"SYN 과거 아동"}]'::jsonb),
  ('SYN-LEGACY-MASKED', 'bongplay_bonghwa', (now() at time zone 'Asia/Seoul')::date - 120, now() - interval '120 days',
   '홍*', '010-****-0098', true, null, null)
on conflict (id) do nothing;
update public.safety_consents set pii_masked_at = now() - interval '30 days' where id = 'SYN-LEGACY-MASKED';

do $pre$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'safety_consents'
             and column_name in ('status', 'cancelled_at', 'cancel_reason')) then
    raise exception 'COMPAT: 전제 위반 — 마이그레이션 전에 이미 취소 열이 있음';
  end if;
end
$pre$;

create temp table compat_before as
  select id, md5(to_jsonb(c)::text) as h from public.safety_consents c;

\i :cancel_sql
\i :cancel_sql

do $check$
declare
  v_before int; v_after int; v_changed int; v_bad int; v_idx int; v_cols int; v_rpc int; v_n int;
  v_today_id text := 'SYN-CST-' || to_char((now() at time zone 'Asia/Seoul')::date, 'YYYYMMDD') || '-1';
  r record;
begin
  select count(*) into v_before from compat_before;
  select count(*) into v_after from public.safety_consents;
  if v_before <> v_after then raise exception 'COMPAT: 행 수 변화 % → %', v_before, v_after; end if;

  select count(*) into v_changed
  from public.safety_consents c join compat_before b using (id)
  where md5((to_jsonb(c) - 'status' - 'cancelled_at' - 'cancel_reason')::text) <> b.h;
  if v_changed > 0 then raise exception 'COMPAT: 기존 열 값이 바뀐 행 %건', v_changed; end if;

  select count(*) into v_bad from public.safety_consents
  where status is distinct from 'active' or cancelled_at is not null or cancel_reason is not null;
  if v_bad > 0 then raise exception 'COMPAT: 기존 행 기본값 불일치 %건', v_bad; end if;

  select count(*) into v_cols from information_schema.columns
  where table_schema = 'public' and table_name = 'safety_consents' and column_name in ('status', 'cancelled_at', 'cancel_reason');
  select count(*) into v_idx from pg_indexes where schemaname = 'public' and indexname = 'idx_safety_consents_cancelled';
  if v_cols <> 3 or v_idx <> 1 then raise exception 'COMPAT: 열 % / 인덱스 % (기대 3 / 1)', v_cols, v_idx; end if;
  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'safety_consents'
      and column_name = 'status') not like '''active''%' then
    raise exception 'COMPAT: status 기본값이 active 가 아님';
  end if;

  -- 기존 보안 RPC 는 마이그레이션 전에 만들어졌다 (setof safety_consents). 새 열을 함께 돌려주는지
  select count(*) into v_rpc from public.get_today_consents_secure(current_setting('compat.code')) where status = 'active';
  if v_rpc < 3 then raise exception 'COMPAT: get_today_consents_secure 가 status 를 포함한 당일 행을 돌려주지 않음 (%건)', v_rpc; end if;

  raise notice 'COMPAT 기존 행 %건 값 불변, status=active 기본값, 열 3·인덱스 1 (2회 적용), 보안 RPC 당일 %건 반환', v_after, v_rpc;

  -- 앱(anon) 권한: 당일 행 취소 기록 → null 해제, 과거 행 수정 거부
  execute 'set local role anon';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  update public.safety_consents set status = 'cancelled', cancelled_at = now(), cancel_reason = 'SYN 취소 시험' where id = v_today_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'COMPAT: anon 당일 취소 기록 % 행 (기대 1)', v_n; end if;
  update public.safety_consents set status = 'active', cancelled_at = null, cancel_reason = null where id = v_today_id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'COMPAT: anon 당일 취소 해제(null) % 행 (기대 1)', v_n; end if;
  update public.safety_consents set status = 'cancelled' where id = 'SYN-LEGACY-OLD';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'COMPAT: anon 이 과거 행을 수정함 (% 행)', v_n; end if;
  execute 'reset role';

  select * into r from public.safety_consents where id = v_today_id;
  if r.status <> 'active' or r.cancelled_at is not null or r.cancel_reason is not null then
    raise exception 'COMPAT: null 해제 결과가 저장되지 않음 (%, %, %)', r.status, r.cancelled_at, r.cancel_reason;
  end if;
  raise notice 'COMPAT anon 당일 취소 기록·null 해제 허용, 과거 행 수정 거부 (정책 불변)';
end
$check$;
