-- ============================================================================
--  봉플레이 운영시스템 — 디스코드 경보 연동 (Additive Migration)
-- ----------------------------------------------------------------------------
--  대상: 리틀포레스트 봉플레이 / 봉화
--  목적: 사고·민원·마감·설비 이벤트를 디스코드 채널로 자동 통보
--
--  ▣ 실행 순서
--    1) supabase_setup.sql 을 먼저 실행했다면 그대로 진행
--    2) Supabase → SQL Editor → New query → 이 파일 전체 붙여넣기 → Run
--    3) "4. 웹훅 URL 등록" 의 주석을 풀고 실제 URL 4개를 넣어 재실행
--
--  ▣ 설계 원칙 (반드시 유지할 것)
--    [A] 웹훅 URL은 이 DB 안에만 존재한다. 프론트엔드(config.js)에 넣으면 안 된다.
--    [B] 브라우저가 아니라 DB가 쏜다. → 오프라인 대기열이 몰려 올라와도
--        중복 없이 1건으로 정리된다.
--    [C] 개인정보(person_name / person_phone / 서명)는 구조적으로 전송 불가.
--        자유서술(description 등)도 기본값은 전송하지 않는다.
--    [D] 채널별 발송량 상한을 코드로 강제한다. (디스코드 429 방지)
-- ============================================================================


-- ============================================================================
--  1. 확장 활성화
-- ============================================================================
-- pg_net / pg_cron 이 이미 있으면 아무 일도 일어나지 않는다.
-- 만약 권한 문제로 실패하면 Supabase → Database → Extensions 에서
-- pg_net, pg_cron 을 먼저 켜고 이 스크립트를 다시 실행하십시오.
create extension if not exists pg_net;    -- 비동기 HTTP 전송
create extension if not exists pg_cron;   -- 예약 실행 (브리핑, 점검 체크 등)


-- 1-1. 예약 작업 등록 도우미
--      pg_cron 이 아직 활성화되지 않았어도 스크립트 전체가 죽지 않게 감싼다.
--      (실패 시 경고만 남기고, 7절만 나중에 다시 실행하면 된다)
create or replace function public.ops_schedule_job(p_name text, p_sched text, p_cmd text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform cron.unschedule(p_name);
  exception when others then null;
  end;
  begin
    perform cron.schedule(p_name, p_sched, p_cmd);
  exception when others then
    raise warning '예약 작업 등록 실패(%) — pg_cron 활성화를 확인하십시오: %', p_name, sqlerrm;
  end;
end $$;


-- ============================================================================
--  2. 테이블 — 웹훅 설정 / 발송 큐
-- ----------------------------------------------------------------------------
--  ⚠ 이 두 테이블은 anon 키로 절대 읽을 수 없어야 한다.
--     RLS 활성 + 정책 0개 + 권한 회수 = API 역할 완전 차단
--     (트리거 함수는 security definer 라서 소유자 권한으로 정상 동작한다)
-- ============================================================================

create table if not exists public.ops_discord_webhooks (
  channel_key       text primary key,          -- emergency / complaint / daily / facility
  webhook_url       text not null,
  username          text not null default '봉플레이 운영시스템',
  enabled           boolean not null default true,
  mention           text not null default '',  -- 예: '@here' (비워두면 일반 메시지)
  include_free_text boolean not null default false, -- 자유서술 포함 여부 (기본 미포함)
  label             text,                      -- 사람이 읽는 이름
  updated_at        timestamptz not null default now()
);

alter table public.ops_discord_webhooks enable row level security;
-- 정책을 만들지 않는다 = 전면 거부(deny). 아래 revoke 로 이중 차단.
revoke all on public.ops_discord_webhooks from anon, authenticated;


create table if not exists public.ops_discord_queue (
  id           bigserial primary key,
  channel_key  text not null,
  source_table text not null,                  -- incident_logs 등 발생 원천
  source_id    text not null,                  -- 원천 행의 PK (멱등 키)
  dedupe_key   text not null default 'v1',     -- 같은 행에서 복수 알림 구분자
  priority     int  not null default 5,        -- 낮을수록 먼저 전송 (119 = 1)
  payload      jsonb not null,
  status       text not null default 'queued', -- queued/sending/sent/dead/skipped
  attempts     int  not null default 0,
  request_id   bigint,                         -- net.http_post 반환값
  available_at timestamptz not null default now(),
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ★ 멱등성의 핵심: 같은 원천 행 + 같은 알림 종류는 단 1건만 큐에 들어간다.
--   → 오프라인 대기열이 재전송돼도 디스코드에 중복 알림이 가지 않는다.
create unique index if not exists ux_ops_discord_dedupe
  on public.ops_discord_queue (channel_key, source_table, source_id, dedupe_key);

create index if not exists idx_ops_discord_pending
  on public.ops_discord_queue (status, available_at, priority, id)
  where status = 'queued';

create index if not exists idx_ops_discord_request
  on public.ops_discord_queue (request_id)
  where status = 'sending';

alter table public.ops_discord_queue enable row level security;
revoke all on public.ops_discord_queue from anon, authenticated;


-- ============================================================================
--  3. 헬퍼 함수
-- ============================================================================

-- 3-1. text → timestamptz 안전 변환
--      (원천 컬럼이 text 라서 값이 깨져 있어도 스크립트가 죽지 않게)
create or replace function public.ops_safe_ts(p text)
returns timestamptz
language plpgsql stable
set search_path = public
as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  return p::timestamptz;
exception when others then
  return null;
end $$;


-- 3-2. 개인정보 마스킹
--      자유서술을 켠 채널에 한해 사용. 이름·연락처를 지운다.
create or replace function public.ops_mask_pii(p text)
returns text
language plpgsql immutable
set search_path = public
as $$
declare v text;
begin
  if p is null then return null; end if;
  v := p;
  -- 휴대전화 / 유선
  v := regexp_replace(v, '(01[016789])[- .]?[0-9]{3,4}[- .]?[0-9]{4}', '[연락처]', 'g');
  v := regexp_replace(v, '(0[2-6][0-9])[- .]?[0-9]{3,4}[- .]?[0-9]{4}', '[연락처]', 'g');
  v := regexp_replace(v, '\y[0-9]{4}[- .]?[0-9]{4}\y', '[번호]', 'g');
  -- 주민등록번호 형태
  v := regexp_replace(v, '\y[0-9]{6}[- .]?[1-8][0-9]{6}\y', '[식별번호]', 'g');
  -- "홍길동(보호자)" / "김철수 학부모" 류
  v := regexp_replace(v, '([가-힣]{2,4})\s*(보호자|학부모|어머니|아버지|할머니|할아버지)', '[이름] \2', 'g');
  return v;
end $$;


-- 3-3. 큐 적재 (트리거가 호출하는 유일한 통로)
create or replace function public.ops_discord_enqueue(
  p_channel     text,
  p_source_tbl  text,
  p_source_id   text,
  p_dedupe_key  text,
  p_payload     jsonb,
  p_priority    int default 5
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ops_discord_queue
    (channel_key, source_table, source_id, dedupe_key, payload, priority)
  values
    (p_channel, p_source_tbl, p_source_id, p_dedupe_key, p_payload, p_priority)
  on conflict (channel_key, source_table, source_id, dedupe_key) do nothing;
exception when others then
  -- 알림 실패가 현장 입력(매표·동의서·점검)을 막아서는 안 된다.
  raise warning 'ops_discord_enqueue 실패(channel=%, src=%, id=%): %',
    p_channel, p_source_tbl, p_source_id, sqlerrm;
  return;
end $$;


-- 3-4. 공통 임베드 뼈대
create or replace function public.ops_embed(
  p_title  text,
  p_color  int,
  p_fields jsonb,
  p_footer text default '리틀포레스트 봉플레이 · 봉화'
) returns jsonb
language sql
as $$
  select jsonb_build_object(
    'embeds', jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'title',  p_title,
        'color',  p_color,
        'fields', p_fields,
        'footer', jsonb_build_object('text', p_footer),
        'timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      ))
    )
  );
$$;


-- ============================================================================
--  4. 웹훅 URL 등록   ★ 여기만 수정하십시오 ★
-- ----------------------------------------------------------------------------
--  아래 4줄의 '여기에_..._URL' 부분을 실제 웹훅 주소로 교체한 뒤 실행하십시오.
--  URL 이 아직 없으면 이 블록을 건너뛰고 나중에 다시 실행해도 됩니다.
--  (재실행해도 기존 값을 덮어쓸 뿐, 큐에 쌓인 알림은 사라지지 않습니다)
-- ============================================================================

-- insert into public.ops_discord_webhooks (channel_key, webhook_url, label, username) values
--   ('emergency', '여기에_비상_사고경보_URL', '🚨 비상·사고경보', '봉플레이 비상관제봇'),
--   ('complaint', '여기에_민원_리스크_URL',   '⚠️ 민원·리스크',    '봉플레이 민원관제봇'),
--   ('daily',     '여기에_일일_운영마감_URL', '📊 일일·운영마감',  '봉플레이 운영봇'),
--   ('facility',  '여기에_설비_안전일지_URL', '🔧 설비·안전일지',  '봉플레이 설비봇')
-- on conflict (channel_key) do update
--   set webhook_url = excluded.webhook_url,
--       label       = excluded.label,
--       username    = excluded.username,
--       updated_at  = now();
--
-- [선택] 비상 채널에서 사람을 강제 호출하려면 아래 주석 해제 (@here)
-- update public.ops_discord_webhooks set mention = '@here' where channel_key = 'emergency';
--
-- [선택] 자유서술까지 받으려면 (개인정보 마스킹 적용됨). 기본은 미포함.
-- update public.ops_discord_webhooks set include_free_text = true where channel_key = 'emergency';


-- ============================================================================
--  5. 발송 엔진 — 큐를 실제로 디스코드에 전송
-- ============================================================================

-- 5-1. 전송 (1분마다 실행)
--      채널별 상한을 코드로 강제한다 → 디스코드 분당 30건 제한에 여유를 남긴다.
create or replace function public.ops_discord_flush(p_per_channel int default 6)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r       record;
  v_body  jsonb;
  v_req   bigint;
  v_sent  int := 0;
begin
  for r in
    select q.id, q.payload, w.webhook_url, w.username, w.mention
    from (
      select q.*,
             row_number() over (partition by q.channel_key
                                order by q.priority, q.id) as rn
      from public.ops_discord_queue q
      where q.status = 'queued'
        and q.attempts < 5
        and q.available_at <= now()
    ) q
    join public.ops_discord_webhooks w
      on w.channel_key = q.channel_key
    where q.rn <= p_per_channel
      and w.enabled
    order by q.priority, q.id
  loop
    v_body := r.payload || jsonb_build_object(
      'username', r.username,
      -- 본문에 @everyone 류가 섞여 있어도 자동 호출되지 않게 차단
      'allowed_mentions', case
                             when r.mention = '' then jsonb_build_object('parse', '[]'::jsonb)
                             else jsonb_build_object('parse', jsonb_build_array('everyone'))
                          end
    );
    if r.mention <> '' then
      v_body := v_body || jsonb_build_object('content', r.mention);
    end if;

    begin
      v_req := net.http_post(
        url     := r.webhook_url,
        body    := v_body,
        headers := jsonb_build_object('Content-Type', 'application/json')
      );
      update public.ops_discord_queue
         set status = 'sending', request_id = v_req,
             attempts = attempts + 1, updated_at = now()
       where id = r.id;
      v_sent := v_sent + 1;
    exception when others then
      update public.ops_discord_queue
         set status = 'queued', attempts = attempts + 1,
             available_at = now() + interval '2 minutes',
             error = sqlerrm, updated_at = now()
       where id = r.id;
    end;
  end loop;
  return v_sent;
end $$;


-- 5-2. 결과 확인 / 재시도 (1분마다 실행)
--      성공 → sent / 영구 실패(404 등) → dead / 일시 실패(429·5xx) → 재시도
create or replace function public.ops_discord_reconcile()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  with res as (
    update public.ops_discord_queue q
       set status = case
                      when r.status_code between 200 and 299 then 'sent'
                      when r.status_code in (400, 401, 403, 404) then 'dead'
                      else 'queued'
                    end,
           available_at = case
                      when r.status_code between 200 and 299 then q.available_at
                      when r.status_code in (400, 401, 403, 404) then q.available_at
                      when r.status_code = 429 then now() + interval '3 minutes'
                      else now() + (interval '30 seconds' * greatest(q.attempts, 1))
                    end,
           error = coalesce(r.error_msg, 'HTTP ' || r.status_code::text),
           updated_at = now()
      from net._http_response r
     where r.id = q.request_id
       and q.status = 'sending'
    returning 1 as one
  )
  select count(*) into v_n from res;

  -- 5회 이상 시도했는데도 아직 queued = 영구 실패로 정리 (무한 재시도 방지)
  update public.ops_discord_queue
     set status = 'dead',
         error  = coalesce(error, '시도 횟수 초과'),
         updated_at = now()
   where status = 'queued' and attempts >= 5;

  return v_n;
end $$;


-- ============================================================================
--  6. 트리거 — 즉시 경보 대상
-- ============================================================================

-- 6-1. 사고 접수 → 🚨 비상·사고경보
--      발생조건: severity 가 moderate/serious 이거나 119 출동
--      전송필드: id / 등급 / 시각 / 장소 / 대상유형 / 시설 / 보호자통보
--      ★ 성명·연락처·자유서술은 전송하지 않는다
--        (include_free_text = true 인 경우에만 마스킹 후 포함)
create or replace function public.trg_ops_incident_discord()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level  text;
  v_color  int;
  v_prio   int := 3;
  v_free   boolean := false;
  v_delay  text := '';
  v_occ    timestamptz;
  v_fields jsonb;
  v_title  text;
begin
  -- 발동 조건 판정 (INSERT / 악화 UPDATE 만)
  if tg_op = 'UPDATE' then
    if not (
         (new.severity in ('moderate','serious')
            and coalesce(old.severity,'') is distinct from new.severity)
      or (coalesce(new.called_119,false) and not coalesce(old.called_119,false))
    ) then
      return new;
    end if;
  else
    if not (new.severity in ('moderate','serious') or coalesce(new.called_119,false)) then
      return new;
    end if;
  end if;

  -- 등급 결정
  if coalesce(new.called_119,false) then
    v_level := '119 출동'; v_color := 14753096; v_prio := 1;   -- 적색
  elsif new.severity = 'serious' then
    v_level := '중대사고'; v_color := 14753096; v_prio := 1;   -- 적색
  else
    v_level := '보통사고'; v_color := 16096779; v_prio := 3;   -- 주황
  end if;

  -- 오프라인 대기열로 늦게 올라온 건은 "지연 접수" 로 표시
  v_occ := public.ops_safe_ts(new.occurred_at);
  if v_occ is not null and now() - v_occ > interval '30 minutes' then
    v_delay := '⏱ 지연 접수 · ';
  end if;

  select coalesce(w.include_free_text, false) into v_free
    from public.ops_discord_webhooks w
   where w.channel_key = 'emergency';

  v_title := v_delay || case when coalesce(new.called_119,false)
                             then '🚨 119 출동 사고 접수'
                             else '🚨 사고 접수' end;

  v_fields := jsonb_build_array(
    jsonb_build_object('name','등급',      'value', v_level, 'inline', true),
    jsonb_build_object('name','접수시각',  'value', to_char(now() at time zone 'Asia/Seoul','MM-DD HH24:MI'), 'inline', true),
    jsonb_build_object('name','발생시각',  'value', coalesce(to_char(v_occ at time zone 'Asia/Seoul','MM-DD HH24:MI'),'미상'), 'inline', true),
    jsonb_build_object('name','기록ID',    'value', '`' || coalesce(new.id,'-') || '`', 'inline', true),
    jsonb_build_object('name','시설',      'value', coalesce(new.facility_id,'-'), 'inline', true),
    jsonb_build_object('name','장소',      'value', coalesce(new.location,'-'), 'inline', true),
    jsonb_build_object('name','대상',      'value', coalesce(new.target_type,'-'), 'inline', true),
    jsonb_build_object('name','보호자통보','value', case when coalesce(new.notified_guardian,false) then '완료' else '미완료' end, 'inline', true)
  );

  if v_free then
    v_fields := v_fields || jsonb_build_array(
      jsonb_build_object('name','경위(마스킹)', 'value',
        coalesce(left(public.ops_mask_pii(new.description), 280), '-')),
      jsonb_build_object('name','조치(마스킹)', 'value',
        coalesce(left(public.ops_mask_pii(new.action_taken), 280), '-'))
    );
  end if;

  perform public.ops_discord_enqueue(
    'emergency', 'incident_logs', new.id,
    'lvl:' || v_level,
    public.ops_embed(v_title, v_color, v_fields,
                     '리틀포레스트 봉플레이 · 사고 원장'),
    v_prio
  );
  return new;
end $$;

drop trigger if exists trg_incident_discord on public.incident_logs;
create trigger trg_incident_discord
  after insert or update on public.incident_logs
  for each row execute function public.trg_ops_incident_discord();


-- 6-2. 민원 접수 → ⚠️ 민원·리스크
--      발생조건: severity = serious  또는  status = escalated
--      ★ 중대민원 누적이 임계(2건)에 도달하면 "계약 해지 조건" 경보를 별도 발송
--        (bongplay-env.js 설계 원칙 3: 중대민원 2회는 사업 종료 조건)
create or replace function public.trg_ops_complaint_discord()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_serious   boolean;
  v_cnt       int;
  v_threshold int := 2;      -- ★ 총괄 확인 필요 (해지 조건 임계)
  v_window    int := 90;     -- ★ 총괄 확인 필요 (조회 기간, 일)
  v_color     int := 16096779;
  v_title     text;
  v_fields    jsonb;
  v_prio      int := 3;
begin
  v_serious := (new.severity = 'serious') or (new.status = 'escalated');
  if not v_serious then return new; end if;

  select count(*) into v_cnt
    from public.complaint_logs c
   where c.severity = 'serious'
     and c.id <> new.id
     -- received_at 이 text 라서 파싱 실패 시 'now' 로 보수적 처리
     and coalesce(public.ops_safe_ts(c.received_at), now())
         >= now() - (v_window || ' days')::interval;

  if v_cnt + 1 >= v_threshold then
    v_color := 14753096;
    v_prio  := 1;
    v_title := '🚨 중대민원 ' || (v_cnt + 1) || '건 — 계약 리스크 경보';
  else
    v_title := '⚠️ 중대민원 접수 (1건째)';
  end if;

  v_fields := jsonb_build_array(
    jsonb_build_object('name','심각도',   'value', coalesce(new.severity,'-'), 'inline', true),
    jsonb_build_object('name','상태',     'value', coalesce(new.status,'-'),   'inline', true),
    jsonb_build_object('name','접수경로', 'value', coalesce(new.channel,'-'),  'inline', true),
    jsonb_build_object('name','유형',     'value', coalesce(new.complaint_type,'-'), 'inline', true),
    jsonb_build_object('name','시설',     'value', coalesce(new.facility_id,'-'), 'inline', true),
    jsonb_build_object('name','최근 ' || v_window || '일 중대민원', 'value',
      (v_cnt + 1) || '건 (임계 ' || v_threshold || '건)', 'inline', true),
    jsonb_build_object('name','기록ID',   'value', '`' || coalesce(new.id,'-') || '`', 'inline', false)
  );

  perform public.ops_discord_enqueue(
    'complaint', 'complaint_logs', new.id,
    'lvl:' || coalesce(new.severity,'-') || ':' || coalesce(new.status,'-') || ':' || (v_cnt+1),
    public.ops_embed(v_title, v_color, v_fields,
                     '리틀포레스트 봉플레이 · 민원 원장'),
    v_prio
  );
  return new;
end $$;

drop trigger if exists trg_complaint_discord on public.complaint_logs;
create trigger trg_complaint_discord
  after insert or update on public.complaint_logs
  for each row execute function public.trg_ops_complaint_discord();


-- 6-3. 마감 정산 → 📊 일일·운영마감
--      일일 BEP 660,000원 대비 달성률과 현금 차액을 함께 보고
create or replace function public.trg_ops_closing_discord()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bep    bigint := 660000;      -- 일일 기준 손익분기 매출
  v_rev    bigint := 0;
  v_vis    int    := 0;
  v_rate   numeric;
  v_color  int;
  v_title  text;
  v_fields jsonb;
  v_s      record;
begin
  select s.total_revenue, s.total_visitors into v_s
    from public.sales_records s
   where s.date = new.date
   limit 1;

  v_rev := coalesce(v_s.total_revenue, 0);
  v_vis := coalesce(v_s.total_visitors, 0);
  v_rate := case when v_bep > 0 then round((v_rev::numeric / v_bep) * 100, 1) else 0 end;

  if v_rate >= 100 then
    v_color := 1096065;  v_title := '✅ 마감 정산 — BEP 달성';
  elsif v_rate >= 80 then
    v_color := 16096779; v_title := '📊 마감 정산 — BEP 근접';
  else
    v_color := 14753096; v_title := '📉 마감 정산 — BEP 미달';
  end if;

  v_fields := jsonb_build_array(
    jsonb_build_object('name','영업일',     'value', to_char(new.date,'YYYY-MM-DD'), 'inline', true),
    jsonb_build_object('name','총 매출',    'value', to_char(coalesce(v_rev,0),'FM999,999,999') || '원', 'inline', true),
    jsonb_build_object('name','BEP 달성률', 'value', v_rate || '% (기준 66만원)', 'inline', true),
    jsonb_build_object('name','방문객',     'value', coalesce(v_vis,0) || '명', 'inline', true),
    jsonb_build_object('name','현금 실사',  'value', to_char(coalesce(new.actual_cash,0),'FM999,999,999') || '원', 'inline', true),
    jsonb_build_object('name','차액',       'value',
        case when coalesce(new.diff,0) = 0 then '이상 없음'
             else '⚠ ' || to_char(new.diff,'FM999,999,999') || '원' end, 'inline', true),
    jsonb_build_object('name','마감자',     'value', coalesce(new.manager,'-'), 'inline', true),
    jsonb_build_object('name','기록ID',     'value', '`' || coalesce(new.id,'-') || '`', 'inline', true)
  );

  perform public.ops_discord_enqueue(
    'daily', 'closing_records', new.id, 'close',
    public.ops_embed(v_title, v_color, v_fields,
                     '리틀포레스트 봉플레이 · 마감 원장'),
    4
  );
  return new;
end $$;

drop trigger if exists trg_closing_discord on public.closing_records;
create trigger trg_closing_discord
  after insert on public.closing_records
  for each row execute function public.trg_ops_closing_discord();


-- 6-4. 기상 임계 → 🔧 설비·안전일지
--      wind_gust 12.0 m/s 이상 = 짚코스터 중단 기준
--      (weather_environment_telemetry 컬럼 주석에 정의된 실제 기준)
--      같은 시간대에는 1건만 발송 (dedupe_key 에 시간 버킷 포함)
create or replace function public.trg_ops_weather_discord()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_fields jsonb;
begin
  if not (coalesce(new.wind_gust,0) >= 12.0
          or coalesce(new.rainfall,0) >= 30.0
          or coalesce(new.weather_warning,'none') not in ('none','')) then
    return new;
  end if;

  v_fields := jsonb_build_array(
    jsonb_build_object('name','순간최대풍속','value', coalesce(new.wind_gust,0) || ' m/s (중단기준 12.0)', 'inline', true),
    jsonb_build_object('name','강수량',      'value', coalesce(new.rainfall,0) || ' mm', 'inline', true),
    jsonb_build_object('name','기온',        'value', coalesce(new.temperature,0) || ' ℃', 'inline', true),
    jsonb_build_object('name','특보',        'value', coalesce(new.weather_warning,'none'), 'inline', true),
    jsonb_build_object('name','관측시각',    'value', to_char(new.observed_at at time zone 'Asia/Seoul','MM-DD HH24:MI'), 'inline', true)
  );

  perform public.ops_discord_enqueue(
    'facility', 'weather_environment_telemetry', new.id,
    'wx:' || to_char(new.observed_at at time zone 'Asia/Seoul','YYYY-MM-DD-HH24'),
    public.ops_embed('🌪 기상 임계 도달 — 야외시설 가동 판단 필요', 16096779, v_fields,
                     '리틀포레스트 봉플레이 · 기상 텔레메트리'),
    2
  );
  return new;
end $$;

drop trigger if exists trg_weather_discord on public.weather_environment_telemetry;
create trigger trg_weather_discord
  after insert on public.weather_environment_telemetry
  for each row execute function public.trg_ops_weather_discord();


-- ============================================================================
--  7. 예약 작업 — 사람이 매번 챙겨야 했던 것들
--     ※ pg_cron 은 UTC 기준입니다. KST = UTC + 9
-- ============================================================================

-- 7-1. 발송 엔진 (매분)
do $$ begin perform cron.unschedule('bongplay_discord_flush');     exception when others then null; end $$;
do $$ begin perform cron.unschedule('bongplay_discord_reconcile'); exception when others then null; end $$;

select public.ops_schedule_job('bongplay_discord_flush',
                     '* * * * *',
                     $$select public.ops_discord_flush();$$);

select public.ops_schedule_job('bongplay_discord_reconcile',
                     '* * * * *',
                     $$select public.ops_discord_reconcile();$$);


-- 7-2. 개장 브리핑 — 매일 09:00 KST (00:00 UTC)
create or replace function public.ops_daily_briefing()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today  date := (now() at time zone 'Asia/Seoul')::date;
  v_yest   date := v_today - 1;
  v_rev    bigint := 0;
  v_vis    int := 0;
  v_book   int := 0;
  v_bk_cnt int := 0;
  v_wx     record;
  v_s      record;
  v_fields jsonb := '[]'::jsonb;
begin
  select s.total_revenue, s.total_visitors into v_s
    from public.sales_records s where s.date = v_yest limit 1;
  v_rev := coalesce(v_s.total_revenue, 0);
  v_vis := coalesce(v_s.total_visitors, 0);

  select coalesce(sum(b.headcount),0), count(*) into v_book, v_bk_cnt
    from public.group_bookings b
   where b.booking_date = v_today
     and coalesce(b.status,'') not in ('cancelled','no_show');

  select * into v_wx
    from public.weather_environment_telemetry w
   order by w.observed_at desc limit 1;

  v_fields := jsonb_build_array(
    jsonb_build_object('name','어제 매출(' || to_char(v_yest,'MM-DD') || ')',
      'value', to_char(v_rev,'FM999,999,999') || '원 · ' || v_vis || '명', 'inline', true),
    jsonb_build_object('name','어제 BEP 달성률',
      'value', case when v_rev > 0 then round((v_rev::numeric/660000)*100,1) || '%' else '-' end, 'inline', true),
    jsonb_build_object('name','오늘 단체예약',
      'value', v_bk_cnt || '건 / ' || v_book || '명', 'inline', true),
    jsonb_build_object('name','오늘 기상',
      'value', coalesce(v_wx.temperature::text,'-') || '℃ · 풍속 '
               || coalesce(v_wx.wind_speed::text,'-') || 'm/s · 강수 '
               || coalesce(v_wx.rainfall::text,'-') || 'mm', 'inline', false)
  );

  -- 요일 판정 (DB 로캘에 영향받지 않도록 ISO 요일번호 사용: 6=토, 7=일)
  if extract(isodow from v_today) in (6, 7) then
    v_fields := v_fields || jsonb_build_array(
      jsonb_build_object('name','주말 목표','value','148명 / 178만원','inline',true));
  else
    v_fields := v_fields || jsonb_build_array(
      jsonb_build_object('name','평일 목표','value','30명 / 36만원','inline',true));
  end if;

  perform public.ops_discord_enqueue(
    'daily', 'cron_briefing', to_char(v_today,'YYYY-MM-DD'), 'open',
    public.ops_embed('🌤 개장 브리핑 — ' || to_char(v_today,'YYYY-MM-DD (Dy)'),
                     6583435, v_fields,
                     '리틀포레스트 봉플레이 · 일일 브리핑'),
    4
  );
end $$;

do $$ begin perform cron.unschedule('bongplay_daily_briefing'); exception when others then null; end $$;
select public.ops_schedule_job('bongplay_daily_briefing', '0 0 * * *',
                     $$select public.ops_daily_briefing();$$);


-- 7-3. 개장 전 안전점검 미실시 경보 — 매일 09:40 KST (00:40 UTC)
create or replace function public.ops_safety_audit_check()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_cnt   int;
  v_fail  int;
begin
  select count(*), count(*) filter (where decision = 'fail')
    into v_cnt, v_fail
    from public.safety_audits a
   where a.audit_date = v_today;

  if v_cnt = 0 then
    perform public.ops_discord_enqueue(
      'facility', 'cron_safety_audit', to_char(v_today,'YYYY-MM-DD'), 'missing',
      public.ops_embed('⚠ 일일 안전점검 미실시', 14753096,
        jsonb_build_array(
          jsonb_build_object('name','영업일','value', to_char(v_today,'YYYY-MM-DD'),'inline',true),
          jsonb_build_object('name','기록','value','오늘 safety_audits 행이 없습니다','inline',false)),
        '리틀포레스트 봉플레이 · 안전점검'),
      1
    );
  elsif v_fail > 0 then
    perform public.ops_discord_enqueue(
      'facility', 'cron_safety_audit', to_char(v_today,'YYYY-MM-DD'), 'fail:' || v_fail,
      public.ops_embed('🚧 안전점검 부적합 ' || v_fail || '건', 16096779,
        jsonb_build_array(
          jsonb_build_object('name','영업일','value', to_char(v_today,'YYYY-MM-DD'),'inline',true),
          jsonb_build_object('name','점검','value', v_cnt || '건 중 부적합 ' || v_fail || '건','inline',true)),
        '리틀포레스트 봉플레이 · 안전점검'),
      2
    );
  end if;
end $$;

do $$ begin perform cron.unschedule('bongplay_safety_audit_check'); exception when others then null; end $$;
select public.ops_schedule_job('bongplay_safety_audit_check', '40 0 * * *',
                     $$select public.ops_safety_audit_check();$$);


-- 7-4. 설비 수명·정비 점검 — 매일 08:30 KST (전일 23:30 UTC)
create or replace function public.ops_asset_check()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_n     int;
  v_lines text := '';
  r       record;
begin
  -- (a) 수명 소진 90% 이상
  for r in
    select c.asset_id, c.current_cycles, c.max_lifespan_cycles
      from public.asset_usage_counters c
     where c.max_lifespan_cycles > 0
       and c.current_cycles::numeric / c.max_lifespan_cycles >= 0.9
     order by c.current_cycles::numeric / c.max_lifespan_cycles desc
     limit 10
  loop
    v_lines := v_lines || '• `' || r.asset_id || '` '
            || r.current_cycles || '/' || r.max_lifespan_cycles
            || ' (' || round((r.current_cycles::numeric/r.max_lifespan_cycles)*100,0) || '%)' || E'\n';
  end loop;

  if v_lines <> '' then
    perform public.ops_discord_enqueue(
      'facility', 'cron_asset', to_char(v_today,'YYYY-MM-DD'), 'lifespan',
      public.ops_embed('🔧 장비 수명 임계 도달 (90% 이상)', 16096779,
        jsonb_build_array(jsonb_build_object('name','대상','value', left(v_lines,900))),
        '리틀포레스트 봉플레이 · 설비 수명'),
      3
    );
  end if;

  -- (b) 상태 이상 / 점검 공백 30일 초과
  select count(*) into v_n
    from public.equipment_assets e
   where e.status in ('warn','repair')
      or (e.last_inspected_at is not null
          and e.last_inspected_at < v_today - 30);

  if v_n > 0 then
    perform public.ops_discord_enqueue(
      'facility', 'cron_asset', to_char(v_today,'YYYY-MM-DD'), 'status:' || v_n,
      public.ops_embed('🔧 점검 필요 설비 ' || v_n || '건', 16096779,
        jsonb_build_array(
          jsonb_build_object('name','기준','value','상태 warn/repair 또는 점검 공백 30일 초과','inline',false),
          jsonb_build_object('name','일자','value', to_char(v_today,'YYYY-MM-DD'),'inline',true)),
        '리틀포레스트 봉플레이 · 설비 점검'),
      5
    );
  end if;
end $$;

do $$ begin perform cron.unschedule('bongplay_asset_check'); exception when others then null; end $$;
select public.ops_schedule_job('bongplay_asset_check', '30 23 * * *',
                     $$select public.ops_asset_check();$$);


-- 7-5. 준사고·경미사고 다이제스트 — 매일 18:00 KST (09:00 UTC)
--      경보가 아니라 "일지" 성격이라 묶어서 1건만 보낸다 (알림 피로 방지)
create or replace function public.ops_nearmiss_digest()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_nm    int;
  v_min   int;
  v_lines text := '';
  r       record;
begin
  select count(*) filter (where severity = 'near_miss'),
         count(*) filter (where severity = 'minor')
    into v_nm, v_min
    from public.incident_logs i
   where public.ops_safe_ts(i.occurred_at)::date = v_today;

  if coalesce(v_nm,0) = 0 and coalesce(v_min,0) = 0 then return; end if;

  for r in
    select i.id, i.severity, i.location, i.occurred_at
      from public.incident_logs i
     where public.ops_safe_ts(i.occurred_at)::date = v_today
       and i.severity in ('near_miss','minor')
     order by i.occurred_at
     limit 15
  loop
    v_lines := v_lines || '• `' || r.id || '` ' || r.severity || ' · '
            || coalesce(r.location,'-') || E'\n';
  end loop;

  perform public.ops_discord_enqueue(
    'facility', 'cron_nearmiss', to_char(v_today,'YYYY-MM-DD'), 'digest',
    public.ops_embed('📋 오늘의 준사고·경미사고 일지', 6583435,
      jsonb_build_array(
        jsonb_build_object('name','준사고',   'value', coalesce(v_nm,0) || '건','inline',true),
        jsonb_build_object('name','경미사고', 'value', coalesce(v_min,0) || '건','inline',true),
        jsonb_build_object('name','내역',     'value', left(v_lines,900))),
      '리틀포레스트 봉플레이 · 안전일지'),
    6
  );
end $$;

do $$ begin perform cron.unschedule('bongplay_nearmiss_digest'); exception when others then null; end $$;
select public.ops_schedule_job('bongplay_nearmiss_digest', '0 9 * * *',
                     $$select public.ops_nearmiss_digest();$$);


-- ============================================================================
--  8. 운영 점검용 뷰
-- ----------------------------------------------------------------------------
--  ⚠ 뷰는 웹훅 URL 을 담고 있지 않지만, 큐 상태를 노출하므로 API 권한을 회수한다.
--     (security_invoker = true 로 두어 RLS 를 우회하지 못하게 한다)
-- ============================================================================

create or replace view public.ops_discord_health as
select w.channel_key,
       w.label,
       w.enabled,
       w.mention,
       count(q.id) filter (where q.status = 'queued')  as queued,
       count(q.id) filter (where q.status = 'sending') as sending,
       count(q.id) filter (where q.status = 'sent')    as sent,
       count(q.id) filter (where q.status = 'dead')    as dead,
       max(q.updated_at) as last_activity
  from public.ops_discord_webhooks w
  left join public.ops_discord_queue q on q.channel_key = w.channel_key
 group by w.channel_key, w.label, w.enabled, w.mention;

alter view public.ops_discord_health set (security_invoker = true);
revoke all on public.ops_discord_health from anon, authenticated;


-- ============================================================================
--  9. 마무리 확인 쿼리 (실행 후 주석을 풀어 눈으로 확인하십시오)
-- ============================================================================

-- (1) 웹훅 4개가 등록됐는가
-- select channel_key, label, enabled, left(webhook_url, 40) || '...' as url_head
--   from public.ops_discord_webhooks order by channel_key;

-- (2) 예약 작업이 걸렸는가
-- select jobname, schedule, active from cron.job order by jobname;

-- (3) 발송 상태 요약
-- select * from public.ops_discord_health;

-- (4) 영구 실패한 알림 (404 = 웹훅이 삭제됨 → URL 재발급 필요)
-- select id, channel_key, source_table, source_id, error, created_at
--   from public.ops_discord_queue where status = 'dead' order by id desc limit 20;

-- (5) 수동 테스트 발송 (파이프라인 전체 검증)
-- select public.ops_discord_enqueue(
--   'emergency', 'manual_test', 'test-' || to_char(now(),'YYYYMMDDHH24MISS'), 'v1',
--   public.ops_embed('🧪 연동 테스트', 6583435,
--     jsonb_build_array(jsonb_build_object('name','상태','value','정상 연동 확인','inline',true))),
--   1);
-- select public.ops_discord_flush();

-- (6) 큐 정리 (오래된 성공/실패 기록 삭제, 월 1회 권장)
-- delete from public.ops_discord_queue
--  where status in ('sent','dead','skipped') and created_at < now() - interval '90 days';
