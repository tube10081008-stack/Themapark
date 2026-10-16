-- ============================================================================
-- PROPOSED MIGRATION: ticket_queue (발권 대기열 시스템 — R2 보완 반영)
-- 
-- 태스크: ANT-006 / 지시서: BEN-022 (R2 검토 반영)
-- 목적: QR 안전동의서 서버 접수 시 당일 대기번호 부여, 고객 순서·예상시간 안내,
--       매표소 호출 및 발권 완료 시 대기열 제외 파이프라인 구축.
-- 주요 보완 (R2 검토 4대 필수 수정 반영):
-- 1. [고객 보안] 공개 queue ID 우회 원천 차단 (customer_token 전용 조회), 24시간 만료 및 분당 60회 요청 제한
-- 2. [RPC 계약] 클라이언트-SQL 서명 100% 일치 (getCustomerStatus 불필요 인자 p_token/p_queue_id 제거)
-- 3. [직원 권한] 공용 키 전송과 연결 가능한 서버 검증 (private.verify_staff_permission 연동, anon/직원명 우회 차단)
-- 4. [발권 검증] order_payments(결제 확정), safety_consents, ticket_ledger 전체 원장 대사 및 동일 order_id 멱등 재시도 보장
-- 주의: 본 파일은 제안 마이그레이션(Proposed SQL)으로 운영 DB에 자동 적용하지 않으며,
--       벤(Ben) 검토 및 관리자 승인 후 수동 반영합니다.
-- ============================================================================

-- 1. 대기열 테이블 생성
CREATE TABLE IF NOT EXISTS public.ticket_queue (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL DEFAULT 'bongplay_bonghwa',
    queue_date DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE),
    queue_number INTEGER NOT NULL,
    order_key BIGINT NOT NULL, -- 호출 순서 정렬키 (표시번호와 분리: 복귀 시 맨 뒤로 재할당)
    customer_token VARCHAR(64) UNIQUE NOT NULL, -- 고객 조회용 128비트 암호화 토큰 (공개 id와 분리)
    formatted_number TEXT NOT NULL,
    consent_id TEXT NOT NULL REFERENCES public.safety_consents(id) ON DELETE CASCADE,
    visit_id TEXT,
    household_id TEXT,
    guardian_name TEXT NOT NULL,
    guardian_phone TEXT NOT NULL,
    party_size INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'called', 'processing', 'issued', 'no_show', 'canceled')),
    desk_no INTEGER,
    staff_id TEXT,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    called_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ,
    issued_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    hold_at TIMESTAMPTZ,
    restored_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    order_id TEXT,
    ticket_ids JSONB DEFAULT '[]'::jsonb,
    hold_reason TEXT,
    cancel_reason TEXT,
    restore_reason TEXT,
    restored_by TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    last_request_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ticket_queue_site_date_number UNIQUE (site_id, queue_date, queue_number),
    CONSTRAINT uq_ticket_queue_site_date_consent UNIQUE (site_id, queue_date, consent_id),
    CONSTRAINT uq_ticket_queue_site_date_idempotency UNIQUE (site_id, queue_date, idempotency_key)
);

-- 2. 매표 창구 관제 테이블 생성 (서버 창구 상태 및 정지 여부 관리)
CREATE TABLE IF NOT EXISTS public.ticket_queue_desks (
    site_id TEXT NOT NULL DEFAULT 'bongplay_bonghwa',
    desk_no INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_paused BOOLEAN NOT NULL DEFAULT false,
    current_queue_id TEXT,
    pause_reason TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (site_id, desk_no)
);

-- 기본 창구 슬롯 시드 (1번, 2번 창구)
INSERT INTO public.ticket_queue_desks (site_id, desk_no, is_active, is_paused)
VALUES ('bongplay_bonghwa', 1, true, false), ('bongplay_bonghwa', 2, true, false)
ON CONFLICT (site_id, desk_no) DO NOTHING;

-- 3. [R2 Fix 1] 고객 조회 요청 제한 테이블 (토큰당 분당 60회 초과 차단)
CREATE TABLE IF NOT EXISTS public.ticket_queue_rate_limits (
    customer_token VARCHAR(64) PRIMARY KEY,
    request_count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_request_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_queue_rate_limits_window ON public.ticket_queue_rate_limits (window_start);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_ticket_queue_calling_order 
    ON public.ticket_queue (site_id, queue_date, status, order_key);

CREATE INDEX IF NOT EXISTS idx_ticket_queue_customer_token 
    ON public.ticket_queue (customer_token);

CREATE INDEX IF NOT EXISTS idx_ticket_queue_consent_lookup 
    ON public.ticket_queue (site_id, queue_date, consent_id);

CREATE INDEX IF NOT EXISTS idx_ticket_queue_idempotency_lookup 
    ON public.ticket_queue (site_id, queue_date, idempotency_key);

-- ============================================================================
-- [R2 Fix 3] 직원 권한 및 시설 접근 검증 헬퍼 (공용 키 전송 환경용 내부 보안 검증)
-- ============================================================================
CREATE OR REPLACE FUNCTION private.verify_staff_permission(
    p_access_code TEXT,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, extensions, public, pg_temp
AS $$
DECLARE
    v_hash TEXT;
BEGIN
    -- 1. 암호 기본 유효성 검사 (최소 4자 이상)
    IF p_access_code IS NULL OR length(trim(p_access_code)) < 4 THEN
        RETURN false;
    END IF;

    -- 2. 시설(site_id) 인가 검사
    IF p_site_id IS NULL OR trim(p_site_id) = '' THEN
        RETURN false;
    END IF;
    IF p_site_id NOT IN ('bongplay_bonghwa', 'gijang-main') THEN
        RETURN false;
    END IF;

    -- 3. 기존 공통 운영 인증 RPC(private.verify_access_code) 연동 (브루트포스 락아웃 및 bcrypt 해시 검증)
    IF EXISTS (
        SELECT 1 FROM pg_proc p 
        JOIN pg_namespace n ON p.pronamespace = n.oid 
        WHERE n.nspname = 'private' AND p.proname = 'verify_access_code'
    ) THEN
        RETURN private.verify_access_code(p_access_code);
    END IF;

    -- 4. 단독 환경 폴백 검증 (private.app_settings)
    SELECT value INTO v_hash FROM private.app_settings WHERE key = 'access_code';
    IF v_hash IS NOT NULL AND v_hash LIKE '$2%' THEN
        RETURN extensions.crypt(p_access_code, v_hash) = v_hash;
    END IF;

    RETURN false;
END;
$$;

-- ============================================================================
-- [CLAUDE-011 후속] 시설·영업일 단위 대기열 직렬화 잠금
-- - 번호(queue_number)·정렬키(order_key)를 MAX+1 로 정하는 접수·복귀, 창구 점유를 검사하는 호출이
--   같은 시설·같은 영업일 안에서 한 번에 하나씩 실행되도록 트랜잭션 범위 advisory lock 을 건다.
-- - 이전에는 접수 잠금이 멱등키 단위라, 서로 다른 고객이 동시에 접수하면 같은 번호를 계산해
--   uq_ticket_queue_site_date_number 고유 제약 오류(23505)로 한쪽이 접수되지 않았다 (로컬 PostgreSQL 재현).
-- ============================================================================
CREATE OR REPLACE FUNCTION private.lock_ticket_queue_day(p_site_id TEXT, p_queue_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('ticket_queue:' || p_site_id || ':' || p_queue_date::text, 0));
END;
$$;
REVOKE ALL ON FUNCTION private.lock_ticket_queue_day(TEXT, DATE) FROM PUBLIC;

-- ============================================================================
-- [CLAUDE-011 R4] 전날 미정리 팀·창구 점유 포인터 (계약: database/CONTRACT_ticket_queue_past_day.md)
-- - 직원 변경 RPC 는 모두 시설 단위 잠금을 먼저 잡는다 (자정을 사이에 둔 두 요청도 직렬화). 잠금 순서: 시설 → 날짜.
-- - 오늘 창구 점유의 진실은 ticket_queue 의 오늘 행이다. ticket_queue_desks.current_queue_id 는 변경 RPC 가 관리하는 캐시.
-- - 과거 행은 창구를 점유하지 않고, 자동으로 취소·완료되지 않는다. 원장 표는 어떤 대기열 RPC 도 쓰지 않는다.
-- ============================================================================
CREATE OR REPLACE FUNCTION private.lock_ticket_queue_site(p_site_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('ticket_queue_site:' || COALESCE(p_site_id, ''), 0));
END;
$$;
REVOKE ALL ON FUNCTION private.lock_ticket_queue_site(TEXT) FROM PUBLIC;

-- 서약서에 연결된 기록된 주문 (활성 품목·유효 결제·활성 티켓 중 하나라도 있는 주문). 읽기 전용.
CREATE OR REPLACE FUNCTION private.ticket_queue_recorded_orders(p_consent_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    WITH ids AS (
        SELECT order_id FROM public.order_items
         WHERE consent_id = p_consent_id AND COALESCE(status, 'paid') <> 'cancelled' AND cancelled_at IS NULL
        UNION
        SELECT order_id FROM public.order_payments
         WHERE consent_id = p_consent_id AND status = 'paid' AND cancelled_at IS NULL
        UNION
        SELECT order_id FROM public.ticket_ledger
         WHERE consent_id = p_consent_id AND cancelled_at IS NULL AND COALESCE(status, 'active') <> 'cancelled'
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'order_id', ids.order_id,
        'item_total', (SELECT COALESCE(SUM(CASE WHEN COALESCE(i.paid_amount, 0) > 0 THEN i.paid_amount ELSE COALESCE(i.total_price, 0) END), 0)
                         FROM public.order_items i
                        WHERE i.order_id = ids.order_id AND COALESCE(i.status, 'paid') <> 'cancelled' AND i.cancelled_at IS NULL),
        'paid_total', (SELECT COALESCE(SUM(p.amount), 0) FROM public.order_payments p
                        WHERE p.order_id = ids.order_id AND p.consent_id = p_consent_id AND p.status = 'paid' AND p.cancelled_at IS NULL),
        'active_tickets', (SELECT COUNT(*) FROM public.ticket_ledger t
                            WHERE t.order_id = ids.order_id AND t.cancelled_at IS NULL AND COALESCE(t.status, 'active') <> 'cancelled')
    ) ORDER BY ids.order_id), '[]'::jsonb)
    FROM ids
    WHERE ids.order_id IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION private.ticket_queue_recorded_orders(TEXT) FROM PUBLIC;

-- 과거 미정리 팀에 직원이 할 수 있는 명시적 동작 (계약 §4 표)
CREATE OR REPLACE FUNCTION private.ticket_queue_past_actions(p_status TEXT, p_recorded JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN jsonb_array_length(COALESCE(p_recorded, '[]'::jsonb)) = 0 THEN
            CASE WHEN p_status IN ('waiting', 'called', 'processing', 'no_show') THEN '["cancel_queue_team"]'::jsonb ELSE '[]'::jsonb END
        WHEN p_status = 'processing' THEN '["complete_queue_issuance"]'::jsonb
        ELSE '[]'::jsonb
    END;
$$;
REVOKE ALL ON FUNCTION private.ticket_queue_past_actions(TEXT, JSONB) FROM PUBLIC;

-- 과거 행 변경 거부 응답 (PAST_QUEUE_DATE)
CREATE OR REPLACE FUNCTION private.ticket_queue_past_rejection(p_queue_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'ok', false,
        'error', 'PAST_QUEUE_DATE',
        'id', q.id,
        'queue_date', q.queue_date,
        'status', q.status,
        'allowed_actions', private.ticket_queue_past_actions(q.status, private.ticket_queue_recorded_orders(q.consent_id)),
        'message', '지난 영업일(' || q.queue_date || ')의 대기표입니다. 오늘 창구 동작에 쓸 수 없습니다. 직원 목록의 과거 미정리 팀에서 완료 또는 취소로 정리해 주세요.'
    )
    FROM public.ticket_queue q WHERE q.id = p_queue_id;
$$;
REVOKE ALL ON FUNCTION private.ticket_queue_past_rejection(TEXT) FROM PUBLIC;

-- 창구 포인터 동기화 (변경 RPC 안에서만 쓴다)
-- - p_desk_no 가 null 이면 이 대기 id 를 가리키는 모든 창구 포인터를 지운다 (창구가 옮겨진 팀의 옛 포인터 포함).
-- - p_desk_no 가 있으면 다른 창구의 이 id 포인터를 지우고, 그 창구 포인터를 이 id 로 둔다 (이미 같으면 쓰지 않음).
CREATE OR REPLACE FUNCTION private.ticket_queue_sync_pointer(p_site_id TEXT, p_queue_id TEXT, p_desk_no INTEGER, p_now TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.ticket_queue_desks
       SET current_queue_id = NULL, updated_at = p_now
     WHERE site_id = p_site_id AND current_queue_id = p_queue_id
       AND (p_desk_no IS NULL OR desk_no <> p_desk_no);
    IF p_desk_no IS NOT NULL THEN
        UPDATE public.ticket_queue_desks
           SET current_queue_id = p_queue_id, updated_at = p_now
         WHERE site_id = p_site_id AND desk_no = p_desk_no
           AND current_queue_id IS DISTINCT FROM p_queue_id;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.ticket_queue_sync_pointer(TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC;

-- 창구 오늘 점유 팀 (진실 = 오늘 행). 읽기 전용.
CREATE OR REPLACE FUNCTION private.ticket_queue_desk_occupant(p_site_id TEXT, p_desk_no INTEGER, p_today DATE, p_except_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object('id', q.id, 'formatted_number', q.formatted_number, 'status', q.status, 'consent_id', q.consent_id)
      FROM public.ticket_queue q
     WHERE q.site_id = p_site_id AND q.queue_date = p_today AND q.desk_no = p_desk_no
       AND q.status IN ('called', 'processing')
       AND (p_except_id IS NULL OR q.id <> p_except_id)
     ORDER BY q.called_at NULLS LAST, q.id
     LIMIT 1;
$$;
REVOKE ALL ON FUNCTION private.ticket_queue_desk_occupant(TEXT, INTEGER, DATE, TEXT) FROM PUBLIC;

-- 저장된 포인터가 오늘 점유가 아닐 때 그 사유 (null = 문제 없음 또는 포인터 없음). 읽기 전용.
CREATE OR REPLACE FUNCTION private.ticket_queue_pointer_stale(p_site_id TEXT, p_desk_no INTEGER, p_pointer TEXT, p_today DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_pointer IS NULL THEN NULL
        WHEN q.id IS NULL OR q.site_id <> p_site_id THEN
            jsonb_build_object('queue_id', p_pointer, 'reason', 'not_found', 'queue_date', NULL, 'status', NULL)
        WHEN q.queue_date < p_today THEN
            jsonb_build_object('queue_id', q.id, 'reason', 'past_day', 'queue_date', q.queue_date, 'status', q.status)
        WHEN q.queue_date > p_today OR q.status NOT IN ('called', 'processing') THEN
            jsonb_build_object('queue_id', q.id, 'reason', 'inactive', 'queue_date', q.queue_date, 'status', q.status)
        WHEN q.desk_no IS DISTINCT FROM p_desk_no THEN
            jsonb_build_object('queue_id', q.id, 'reason', 'other_desk', 'queue_date', q.queue_date, 'status', q.status)
        ELSE NULL
    END
    FROM (SELECT 1) one
    LEFT JOIN public.ticket_queue q ON q.id = p_pointer;
$$;
REVOKE ALL ON FUNCTION private.ticket_queue_pointer_stale(TEXT, INTEGER, TEXT, DATE) FROM PUBLIC;

-- ============================================================================
-- RPC 함수군 정의 (고정 search_path 및 100% 일치 계약)
-- ============================================================================

-- 1. 서약서 대기열 접수 (enqueue_consent_team) - 고객/익명 공개
-- - [CLAUDE-011 후속] 시설·영업일 잠금 선취득: 서로 다른 고객의 동시 접수도 번호가 겹치지 않음
-- - 서약서가 서버에 없으면 CONSENT_NOT_FOUND (재시도 가능), 고유 제약 충돌은 ENQUEUE_CONFLICT (재시도 가능)
-- - 멱등키 재사용 검사 (다른 동의서에 동일 키 재사용 시 거부)
-- - 128비트 난수 고객 조회 토큰(customer_token) 생성 및 반환
CREATE OR REPLACE FUNCTION public.enqueue_consent_team(
    p_consent_id TEXT,
    p_idempotency_key TEXT,
    p_party_size INTEGER DEFAULT 1,
    p_guardian_name TEXT DEFAULT '',
    p_guardian_phone TEXT DEFAULT '',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_existing RECORD;
    v_next_num INTEGER;
    v_next_order_key BIGINT;
    v_entry_id TEXT;
    v_cust_token VARCHAR(64);
    v_fmt_num TEXT;
    v_now TIMESTAMPTZ := NOW();
BEGIN
    -- 1. [CLAUDE-011 후속] 시설·영업일 단위 직렬화 잠금
    --    (이전: 멱등키 단위 잠금 → 다른 고객끼리는 직렬화되지 않아 같은 번호 계산 → 고유 제약 오류)
    PERFORM private.lock_ticket_queue_day(p_site_id, v_today);

    -- 2. 멱등키 중복 여부 확인
    SELECT * INTO v_existing 
    FROM public.ticket_queue 
    WHERE site_id = p_site_id AND queue_date = v_today AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        -- [Fix 4] 멱등키가 다른 동의서에 재사용된 경우 보안 거부
        IF v_existing.consent_id <> p_consent_id THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'IDEMPOTENCY_KEY_REUSED',
                'message', '동일 멱등키가 다른 동의서에 이미 사용되었습니다.'
            );
        END IF;

        RETURN jsonb_build_object(
            'ok', true,
            'duplicate', true,
            'id', v_existing.id,
            'queue_number', v_existing.queue_number,
            'formatted_number', v_existing.formatted_number,
            'customer_token', v_existing.customer_token,
            'status', v_existing.status,
            'enqueued_at', v_existing.enqueued_at
        );
    END IF;

    -- 3. 동의서 1건당 당일 1회 대기열 제약
    SELECT * INTO v_existing 
    FROM public.ticket_queue 
    WHERE site_id = p_site_id AND queue_date = v_today AND consent_id = p_consent_id;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'ok', true,
            'duplicate', true,
            'id', v_existing.id,
            'queue_number', v_existing.queue_number,
            'formatted_number', v_existing.formatted_number,
            'customer_token', v_existing.customer_token,
            'status', v_existing.status,
            'enqueued_at', v_existing.enqueued_at
        );
    END IF;

    -- 3-1. [CLAUDE-011 후속] 서약서가 서버에 확정되어 있어야 접수 (외래키 오류 대신 재시도 가능한 오류 코드)
    IF NOT EXISTS (SELECT 1 FROM public.safety_consents WHERE id = p_consent_id) THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'CONSENT_NOT_FOUND',
            'retryable', true,
            'message', '서약서 저장이 서버에 확정되지 않았습니다. 잠시 후 다시 시도해 주세요.'
        );
    END IF;

    -- 4. 당일 최대 대기번호 및 order_key 조회 (1단계 잠금 안에서 실행되므로 동시 접수와 겹치지 않음)
    SELECT COALESCE(MAX(queue_number), 0) + 1,
           COALESCE(MAX(order_key), 0) + 1
    INTO v_next_num, v_next_order_key
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = v_today;

    -- 5. ID 및 128비트 암호화 고객 비밀 토큰 생성
    v_entry_id := 'q_' || to_char(v_today, 'YYYYMMDD') || '_' || lpad(v_next_num::text, 4, '0') || '_' || substr(md5(random()::text), 1, 4);
    v_cust_token := 'bpq_' || encode(gen_random_bytes(16), 'hex');
    v_fmt_num := '#' || lpad(v_next_num::text, 3, '0');

    -- 6. 레코드 삽입
    --    잠금 덕분에 고유 제약 충돌은 생기지 않아야 한다. 생기면(토큰 난수 충돌 등) SQL 오류 대신 재시도 가능 코드로 돌려준다.
    BEGIN
        INSERT INTO public.ticket_queue (
            id, site_id, queue_date, queue_number, order_key, customer_token, formatted_number,
            consent_id, guardian_name, guardian_phone, party_size,
            idempotency_key, status, enqueued_at, version
        ) VALUES (
            v_entry_id, p_site_id, v_today, v_next_num, v_next_order_key, v_cust_token, v_fmt_num,
            p_consent_id, p_guardian_name, p_guardian_phone, GREATEST(1, p_party_size),
            p_idempotency_key, 'waiting', v_now, 1
        );
    EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'ENQUEUE_CONFLICT',
            'retryable', true,
            'message', '동시 접수 충돌입니다. 같은 요청을 다시 보내 주세요.'
        );
    END;

    RETURN jsonb_build_object(
        'ok', true,
        'duplicate', false,
        'id', v_entry_id,
        'queue_number', v_next_num,
        'formatted_number', v_fmt_num,
        'customer_token', v_cust_token,
        'status', 'waiting',
        'enqueued_at', v_now
    );
END;
$$;

-- 2. 다음 대기팀 호출 (call_next_queue_team) - 직원 전용
-- - [R2 Fix 3] 서버 직원·시설 권한 검증
-- - 단일 창구 다중 호출(이중 호출) 방지
-- - order_key 오름차순 호출 (보류 복귀 팀은 맨 뒤)
-- - [R4] 시설 잠금 안에서 창구 행을 다시 읽어 정지·점유 판정. 점유는 오늘 행 기준 (과거 미정리 팀은 막지 않고 바꾸지도 않음)
CREATE OR REPLACE FUNCTION public.call_next_queue_team(
    p_access_code TEXT,
    p_desk_no INTEGER,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_now TIMESTAMPTZ := NOW();
    v_target RECORD;
    v_desk_rec RECORD;
    v_desk_found BOOLEAN;
    v_occupant JSONB;
    v_replaced JSONB;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- [R4] 시설 잠금 (자정을 사이에 둔 요청·다른 직원 변경 RPC 와 직렬화)
    PERFORM private.lock_ticket_queue_site(p_site_id);

    -- [R4] 창구 정지 여부를 잠금 안에서 다시 읽는다 (정지와 호출이 겹치면 정지가 이긴다)
    SELECT * INTO v_desk_rec FROM public.ticket_queue_desks
    WHERE site_id = p_site_id AND desk_no = p_desk_no
    FOR UPDATE;
    v_desk_found := FOUND;

    IF v_desk_found AND v_desk_rec.is_paused THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DESK_PAUSED', 'message', p_desk_no || '번 창구는 발권 일시 중지 상태입니다.');
    END IF;

    -- [Fix 4] 창구당 활성 1팀 제약: 오늘 이 창구에 호출/처리 중인 팀 (포인터가 아니라 오늘 행으로 판정)
    v_occupant := private.ticket_queue_desk_occupant(p_site_id, p_desk_no, v_today);
    IF v_occupant IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DESK_ALREADY_OCCUPIED', 'occupant', v_occupant,
            'message', p_desk_no || '번 창구에 이미 진행 중인 팀이 있습니다.');
    END IF;

    -- [Fix 5] order_key 오름차순으로 대기 1순위 선택 (시설 잠금 안이라 순서를 건너뛰지 않는다)
    SELECT * INTO v_target
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = v_today AND status = 'waiting'
    ORDER BY order_key ASC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'empty_queue', 'message', '대기 중인 팀이 없습니다.');
    END IF;

    -- [R4] 바꾸기 전 포인터가 오늘 점유가 아니면(전날 팀 등) 응답에 남긴다. 그 행 자체는 바꾸지 않는다
    v_replaced := CASE WHEN v_desk_found
        THEN private.ticket_queue_pointer_stale(p_site_id, p_desk_no, v_desk_rec.current_queue_id, v_today) END;

    UPDATE public.ticket_queue
    SET status = 'called',
        desk_no = p_desk_no,
        staff_id = p_staff_id,
        called_at = v_now,
        version = version + 1,
        updated_at = v_now
    WHERE id = v_target.id;

    PERFORM private.ticket_queue_sync_pointer(p_site_id, v_target.id, p_desk_no, v_now);

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_target.id,
        'queue_number', v_target.queue_number,
        'formatted_number', v_target.formatted_number,
        'status', 'called',
        'desk_no', p_desk_no,
        'guardian_name', v_target.guardian_name,
        'consent_id', v_target.consent_id,   -- [CLAUDE-011 후속] 직원 인증 뒤에만 반환: 매표 화면이 호출 팀의 서약서로 결제 창을 연다
        'party_size', v_target.party_size,
        'called_at', v_now,
        'replaced_pointer', v_replaced
    );
END;
$$;

-- 3. 재호출 (recall_queue_team) - 직원 전용
-- - [R4] 지난 영업일 행 거부, 창구 이동 시 점유 검사·포인터 동기화
CREATE OR REPLACE FUNCTION public.recall_queue_team(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_desk_no INTEGER DEFAULT NULL,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_target_desk INTEGER;
    v_occupant JSONB;
    v_moved_from INTEGER := NULL;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- [R4] 시설 잠금 → 대상 행 재조회 (다른 시설 행은 없는 것으로 본다)
    PERFORM private.lock_ticket_queue_site(p_site_id);
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id AND site_id = p_site_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    -- [R4] 지난 영업일 행은 오늘 창구 동작에 쓰지 않는다 (자동 정리도 하지 않음)
    IF v_rec.queue_date < v_today THEN
        RETURN private.ticket_queue_past_rejection(p_queue_id);
    END IF;

    IF v_rec.status NOT IN ('called', 'processing') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'message', '호출 또는 처리 중인 팀만 재호출할 수 있습니다.');
    END IF;

    -- [R4] 창구 이동: 대상 창구에 다른 오늘 활성 팀이 있으면 거부. 포인터는 잠금 안에서 동기화
    v_target_desk := COALESCE(p_desk_no, v_rec.desk_no);
    IF v_target_desk IS DISTINCT FROM v_rec.desk_no THEN
        v_occupant := private.ticket_queue_desk_occupant(p_site_id, v_target_desk, v_today, p_queue_id);
        IF v_occupant IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'error', 'DESK_ALREADY_OCCUPIED', 'occupant', v_occupant,
                'message', v_target_desk || '번 창구에 이미 진행 중인 팀이 있습니다.');
        END IF;
        v_moved_from := v_rec.desk_no;
    END IF;

    UPDATE public.ticket_queue
    SET called_at = v_now,
        desk_no = v_target_desk,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    PERFORM private.ticket_queue_sync_pointer(p_site_id, p_queue_id, v_target_desk, v_now);

    -- [CLAUDE-011 후속] 화면이 응답으로 현재 팀 정보를 교체하므로 식별 필드를 함께 돌려준다
    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'called_at', v_now, 'status', v_rec.status,
        'queue_number', v_rec.queue_number, 'formatted_number', v_rec.formatted_number,
        'desk_no', v_target_desk, 'consent_id', v_rec.consent_id,
        'guardian_name', v_rec.guardian_name, 'party_size', v_rec.party_size,
        'moved_from_desk', v_moved_from);
END;
$$;

-- 4. 발권 처리 시작 (start_queue_processing) - 직원 전용
-- - [R4] 지난 영업일 행 거부, 창구 이동 시 점유 검사·포인터 동기화
CREATE OR REPLACE FUNCTION public.start_queue_processing(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_desk_no INTEGER DEFAULT NULL,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_target_desk INTEGER;
    v_occupant JSONB;
    v_moved_from INTEGER := NULL;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- [R4] 시설 잠금 → 대상 행 재조회 (다른 시설 행은 없는 것으로 본다)
    PERFORM private.lock_ticket_queue_site(p_site_id);
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id AND site_id = p_site_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    -- [R4] 지난 영업일 행은 오늘 창구 동작에 쓰지 않는다 (자동 정리도 하지 않음)
    IF v_rec.queue_date < v_today THEN
        RETURN private.ticket_queue_past_rejection(p_queue_id);
    END IF;

    IF v_rec.status <> 'called' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'message', '호출(called) 상태인 팀만 발권 처리를 시작할 수 있습니다.');
    END IF;

    -- [R4] 창구 이동: 대상 창구에 다른 오늘 활성 팀이 있으면 거부. 포인터는 잠금 안에서 동기화
    v_target_desk := COALESCE(p_desk_no, v_rec.desk_no);
    IF v_target_desk IS DISTINCT FROM v_rec.desk_no THEN
        v_occupant := private.ticket_queue_desk_occupant(p_site_id, v_target_desk, v_today, p_queue_id);
        IF v_occupant IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'error', 'DESK_ALREADY_OCCUPIED', 'occupant', v_occupant,
                'message', v_target_desk || '번 창구에 이미 진행 중인 팀이 있습니다.');
        END IF;
        v_moved_from := v_rec.desk_no;
    END IF;

    UPDATE public.ticket_queue
    SET status = 'processing',
        processing_started_at = v_now,
        desk_no = v_target_desk,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    PERFORM private.ticket_queue_sync_pointer(p_site_id, p_queue_id, v_target_desk, v_now);

    -- [CLAUDE-011 후속] 화면이 응답으로 현재 팀 정보를 교체하므로 식별 필드를 함께 돌려준다
    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'processing', 'processing_started_at', v_now,
        'queue_number', v_rec.queue_number, 'formatted_number', v_rec.formatted_number,
        'desk_no', v_target_desk, 'consent_id', v_rec.consent_id,
        'guardian_name', v_rec.guardian_name, 'party_size', v_rec.party_size, 'called_at', v_rec.called_at,
        'moved_from_desk', v_moved_from);
END;
$$;

-- 5. 부재 보류 (hold_queue_team) - 직원 전용
-- - [R4] 지난 영업일 행 거부, 이 팀을 가리키는 모든 창구 포인터 해제
CREATE OR REPLACE FUNCTION public.hold_queue_team(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_reason TEXT DEFAULT '고객 부재',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- [R4] 시설 잠금 → 대상 행 재조회 (다른 시설 행은 없는 것으로 본다)
    PERFORM private.lock_ticket_queue_site(p_site_id);
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id AND site_id = p_site_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    -- [R4] 지난 영업일 행은 오늘 창구 동작에 쓰지 않는다 (자동 정리도 하지 않음)
    IF v_rec.queue_date < v_today THEN
        RETURN private.ticket_queue_past_rejection(p_queue_id);
    END IF;

    IF v_rec.status NOT IN ('called', 'processing') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'message', '호출 또는 처리 중인 팀만 부재 보류할 수 있습니다.');
    END IF;

    UPDATE public.ticket_queue
    SET status = 'no_show',
        hold_at = v_now,
        hold_reason = p_reason,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    PERFORM private.ticket_queue_sync_pointer(p_site_id, p_queue_id, NULL, v_now);

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'no_show', 'hold_at', v_now);
END;
$$;

-- 6. 보류 복귀 (restore_queue_team) - 직원 전용
-- - [Fix 5] 복귀 시 order_key를 당일 최댓값 + 1로 재할당하여 맨 뒤로 배치 (새치기 원천 차단)
-- - [R4] 지난 영업일 행 거부 (전날 날짜의 waiting 이 되어 다시는 호출되지 않는 일을 막음). 잠금 순서: 시설 → 날짜
CREATE OR REPLACE FUNCTION public.restore_queue_team(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_reason TEXT DEFAULT '고객 창구 방문 복귀',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_new_order_key BIGINT;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- [R4] 시설 잠금 → 대상 행 재조회 (다른 시설 행은 없는 것으로 본다)
    PERFORM private.lock_ticket_queue_site(p_site_id);
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id AND site_id = p_site_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    -- [R4] 지난 영업일 행은 오늘 창구 동작에 쓰지 않는다 (자동 정리도 하지 않음)
    IF v_rec.queue_date < v_today THEN
        RETURN private.ticket_queue_past_rejection(p_queue_id);
    END IF;

    IF v_rec.status <> 'no_show' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'message', '부재 보류(no_show) 상태인 팀만 복귀할 수 있습니다.');
    END IF;

    -- [CLAUDE-011 후속] 시설·영업일 잠금: 동시 접수·복귀와 order_key 가 겹치지 않게 직렬화
    PERFORM private.lock_ticket_queue_day(v_rec.site_id, v_rec.queue_date);

    -- [Fix 5] 대기열 맨 뒤로 보내기 위해 현재 당일 order_key 최댓값 + 1 할당
    SELECT COALESCE(MAX(order_key), 0) + 1 INTO v_new_order_key
    FROM public.ticket_queue
    WHERE site_id = v_rec.site_id AND queue_date = v_rec.queue_date;

    UPDATE public.ticket_queue
    SET status = 'waiting',
        order_key = v_new_order_key,
        desk_no = NULL,
        restored_at = v_now,
        restored_by = p_staff_id,
        restore_reason = p_reason,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    PERFORM private.ticket_queue_sync_pointer(p_site_id, p_queue_id, NULL, v_now);

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_queue_id,
        'status', 'waiting',
        'order_key', v_new_order_key,
        'restored_at', v_now
    );
END;
$$;

-- 7. 접수 취소 (cancel_queue_team) - 직원 전용
-- - [Fix 4] 이미 발권 완료(issued)된 건은 취소 불가 가드
-- - [R4] 지난 영업일 행은 기록된 주문(활성 원장)이 있으면 ORDER_RECORDED 로 거부 (원장·order_id 보존, 같은 주문으로 완료해야 함)
CREATE OR REPLACE FUNCTION public.cancel_queue_team(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_reason TEXT DEFAULT '고객 취소',
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_recorded JSONB;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- [R4] 시설 잠금 → 대상 행 재조회 (다른 시설 행은 없는 것으로 본다)
    PERFORM private.lock_ticket_queue_site(p_site_id);
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id AND site_id = p_site_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    -- [Fix 4] 발권 완료 건은 대기열에서 취소 불가
    IF v_rec.status = 'issued' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CANNOT_CANCEL_ISSUED', 'message', '이미 발권 완료된 건은 대기열에서 취소할 수 없습니다.');
    END IF;

    -- [R4] 지난 영업일 미정리 팀: 기록된 주문이 있으면 취소 대신 같은 주문으로 완료해야 한다
    IF v_rec.queue_date < v_today AND v_rec.status <> 'canceled' THEN
        v_recorded := private.ticket_queue_recorded_orders(v_rec.consent_id);
        IF jsonb_array_length(v_recorded) > 0 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'ORDER_RECORDED',
                'id', p_queue_id, 'queue_date', v_rec.queue_date, 'status', v_rec.status,
                'recorded_orders', v_recorded,
                'allowed_actions', private.ticket_queue_past_actions(v_rec.status, v_recorded),
                'message', '이 팀은 결제·티켓 원장이 저장되어 있어 대기열만 취소할 수 없습니다. 같은 주문번호로 발권 완료하거나 원장을 먼저 정리해 주세요.');
        END IF;
    END IF;

    UPDATE public.ticket_queue
    SET status = 'canceled',
        canceled_at = v_now,
        cancel_reason = p_reason,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    PERFORM private.ticket_queue_sync_pointer(p_site_id, p_queue_id, NULL, v_now);

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'canceled', 'canceled_at', v_now,
        'queue_date', v_rec.queue_date, 'past_queue_date', v_rec.queue_date < v_today);
END;
$$;

-- 8. 발권 확정 완료 (complete_queue_issuance) - 직원 전용
-- - [R2 Fix 3] 서버 직원·시설 권한 검증
-- - [R2 Fix 4] 주문 결제 확정(order_payments), 서약서(safety_consents), 티켓(ticket_ledger) 전체 유효 상태 검증
-- - [R2 Fix 4] 동일 order_id 재시도 시 멱등 성공 결과 반환
-- - [R4] 지난 영업일 processing 팀도 직원이 같은 주문 id 로 명시적으로 완료할 수 있다 (원장을 새로 만들지 않음, 자동 완료 없음)
CREATE OR REPLACE FUNCTION public.complete_queue_issuance(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_order_id TEXT,
    p_ticket_ids JSONB DEFAULT '[]'::jsonb,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_duration INTEGER := 60;
    v_tickets_count INTEGER;
    v_matched_tickets INTEGER := 0;
    v_order_qty INTEGER := 0;
    v_order_total BIGINT := 0;
    v_paid_total BIGINT := 0;
    v_item_count INTEGER := 0;
    v_item_foreign INTEGER := 0;
    v_distinct_tickets INTEGER := 0;
    v_ledger_active INTEGER := 0;
BEGIN
    -- 1. [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- 2. [Fix 3] order_id 및 ticket_ids 유효성 검사
    IF p_order_id IS NULL OR trim(p_order_id) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_ID_REQUIRED', 'message', '유효한 주문번호가 필요합니다.');
    END IF;

    v_tickets_count := COALESCE(jsonb_array_length(p_ticket_ids), 0);
    IF v_tickets_count = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TICKETS_REQUIRED', 'message', '발권된 팔찌 티켓 목록이 필요합니다.');
    END IF;

    -- [R4] 시설 잠금 → 대상 행 재조회 (다른 시설 행은 없는 것으로 본다)
    PERFORM private.lock_ticket_queue_site(p_site_id);
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id AND site_id = p_site_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    -- 3. [R2 Fix 4] 멱등성 재시도 검증: 동일 order_id로 이미 완료된 경우 동일 성공 결과 반환
    IF v_rec.status = 'issued' THEN
        IF v_rec.order_id = p_order_id THEN
            RETURN jsonb_build_object(
                'ok', true,
                'duplicate', true,
                'already_completed', true,
                'id', v_rec.id,
                'status', 'issued',
                'order_id', v_rec.order_id,
                'ticket_ids', v_rec.ticket_ids,
                'duration_seconds', v_rec.duration_seconds,
                'issued_at', v_rec.issued_at,
                'queue_date', v_rec.queue_date,
                'past_queue_date', v_rec.queue_date < v_today
            );
        ELSE
            RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_ISSUED_OTHER_ORDER', 'message', '이미 다른 주문번호로 발권 완료된 대기표입니다.');
        END IF;
    END IF;

    -- 4. [R3] 계약 §2.1: 처리 중(processing) 상태인 팀만 발권 완료 가능 (호출된 called 상태 완료 불가)
    IF v_rec.status <> 'processing' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS', 'message', '처리 중(processing) 상태인 팀만 발권 완료할 수 있습니다.');
    END IF;

    -- 5. [R3] 원장 테이블 부재 시 실패 강제 (order_payments, ticket_ledger, order_items, safety_consents)
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'order_payments')
       OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ticket_ledger')
       OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'order_items')
       OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'safety_consents') THEN
        RETURN jsonb_build_object(
            'ok', false, 
            'error', 'LEDGER_TABLE_MISSING', 
            'message', '필수 원장 테이블(order_payments, ticket_ledger, order_items, safety_consents)이 누락되어 발권을 완료할 수 없습니다.'
        );
    END IF;

    -- 6. [R2 Fix 4 / R3] 안전 서약서 유효 상태 검증
    IF v_rec.consent_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.safety_consents
        WHERE id = v_rec.consent_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CONSENT_INVALID', 'message', '유효한 서약서 원장이 확인되지 않습니다.');
    END IF;

    -- 7~12. [CLAUDE-011 R3 보완: F1~F4] 매표 데스크 createOrder(bongplay-id.js) 저장 구조 기준 원장 대사
    --   활성 품목 = 해당 주문의 order_items 중 취소되지 않은 행 (status <> 'cancelled' AND cancelled_at IS NULL)
    --   · F3 소속: 활성 품목·결제·요청 티켓의 consent_id 가 대기 팀 서약서와 "같아야" 한다 (NULL·불일치 모두 거부)
    --   · F2/F4 수량: 입장권(product_category = 'ticket') 활성 수량 = 요청 티켓 수(중복 제외) = 해당 주문 활성 티켓 원장 수
    --   · F1 금액: 유효 결제 합계(status = 'paid', 미취소, 같은 서약서) >= 활성 품목 할인 후 금액(paid_amount) 합계
    --     (createOrder 는 total_price 를 쓰지 않는다. paid_amount 가 0 인 구 형식 행만 total_price 로 보완)

    -- 7. 주문 품목 소속 (양성 일치): 활성 품목이 있어야 하고 전부 이 서약서 소속이어야 한다
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE consent_id IS DISTINCT FROM v_rec.consent_id),
           COALESCE(SUM(quantity) FILTER (WHERE product_category = 'ticket'), 0),
           COALESCE(SUM(CASE WHEN COALESCE(paid_amount, 0) > 0 THEN paid_amount ELSE COALESCE(total_price, 0) END), 0)
    INTO v_item_count, v_item_foreign, v_order_qty, v_order_total
    FROM public.order_items
    WHERE order_id = p_order_id
      AND COALESCE(status, 'paid') <> 'cancelled'
      AND cancelled_at IS NULL;

    IF v_item_count = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_ITEMS_EMPTY', 'message', '주문 품목 원장이 없거나 모두 취소되었습니다.');
    END IF;
    IF v_item_foreign > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_CONSENT_MISMATCH', 'message', '주문 품목이 대기 팀 서약서에 연결되어 있지 않습니다.');
    END IF;

    -- 8. 결제 소속 (양성 일치): 이 주문의 결제 행은 전부 이 서약서 소속이어야 한다
    IF EXISTS (
        SELECT 1 FROM public.order_payments
        WHERE order_id = p_order_id
          AND consent_id IS DISTINCT FROM v_rec.consent_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_CONSENT_MISMATCH', 'message', '주문 결제가 대기 팀 서약서에 연결되어 있지 않습니다.');
    END IF;

    -- 9. 요청 티켓 중복 금지
    SELECT COUNT(DISTINCT t) INTO v_distinct_tickets FROM jsonb_array_elements_text(p_ticket_ids) AS t;
    IF v_distinct_tickets <> v_tickets_count THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_TICKET_IDS', 'message', '요청 티켓 목록에 중복이 있습니다.');
    END IF;

    -- 10. 입장권 수량 정확 일치: 입장권 품목 수량 = 요청 티켓 수
    IF v_order_qty <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_TICKET_ITEMS_EMPTY', 'message', '주문에 입장권 품목이 없습니다.');
    END IF;
    IF v_tickets_count <> v_order_qty THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TICKET_QUANTITY_MISMATCH',
            'message', '요청 티켓 수(' || v_tickets_count || ')가 주문 입장권 수량(' || v_order_qty || ')과 다릅니다.'
        );
    END IF;

    -- 11. 티켓 원장 대사: 요청 티켓 전부가 이 주문·이 서약서의 활성 티켓이고, 주문의 활성 티켓 수도 입장권 수량과 같아야 한다
    SELECT COUNT(*) INTO v_matched_tickets
    FROM public.ticket_ledger
    WHERE ticket_id IN (SELECT jsonb_array_elements_text(p_ticket_ids))
      AND order_id = p_order_id
      AND consent_id = v_rec.consent_id
      AND cancelled_at IS NULL
      AND COALESCE(status, 'active') <> 'cancelled';

    SELECT COUNT(*) INTO v_ledger_active
    FROM public.ticket_ledger
    WHERE order_id = p_order_id
      AND cancelled_at IS NULL
      AND COALESCE(status, 'active') <> 'cancelled';

    IF v_matched_tickets <> v_tickets_count OR v_ledger_active <> v_order_qty THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'TICKET_LEDGER_INCOMPLETE',
            'message', '티켓 원장이 주문과 일치하지 않습니다. (요청 일치: ' || v_matched_tickets || '/' || v_tickets_count
                       || ', 주문 활성 티켓: ' || v_ledger_active || '/' || v_order_qty || ')'
        );
    END IF;

    -- 12. 결제 확정·금액 대사: 유효 결제 합계 >= 할인 후 주문 금액 (금액 0 주문은 결제 없이 허용)
    SELECT COALESCE(SUM(amount), 0) INTO v_paid_total
    FROM public.order_payments
    WHERE order_id = p_order_id
      AND consent_id = v_rec.consent_id
      AND status = 'paid'
      AND cancelled_at IS NULL;

    IF v_order_total > 0 AND v_paid_total <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYMENT_NOT_CONFIRMED', 'message', '결제가 확정되지 않았거나 유효한 결제 내역이 없습니다.');
    END IF;
    IF v_paid_total < v_order_total THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'PARTIAL_PAYMENT_REJECTED',
            'message', '결제 수납 금액(' || v_paid_total || '원)이 주문 금액(' || v_order_total || '원)에 미달합니다.'
        );
    END IF;

    -- 13. 처리 시간 산출 (processing_started_at 우선, 없으면 called_at 기준)
    IF v_rec.processing_started_at IS NOT NULL THEN
        v_duration := GREATEST(10, EXTRACT(EPOCH FROM (v_now - v_rec.processing_started_at))::INTEGER);
    ELSIF v_rec.called_at IS NOT NULL THEN
        v_duration := GREATEST(10, EXTRACT(EPOCH FROM (v_now - v_rec.called_at))::INTEGER);
    END IF;

    -- 14. 대기열 상태 갱신 (issued)
    UPDATE public.ticket_queue
    SET status = 'issued',
        issued_at = v_now,
        order_id = p_order_id,
        ticket_ids = p_ticket_ids,
        duration_seconds = v_duration,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    -- 15. 창구 슬롯 해제 — [R4] 이 팀을 가리키는 포인터만 (오늘 다른 팀을 가리키는 포인터는 그대로)
    PERFORM private.ticket_queue_sync_pointer(p_site_id, p_queue_id, NULL, v_now);

    RETURN jsonb_build_object(
        'ok', true,
        'duplicate', false,
        'already_completed', false,
        'id', p_queue_id,
        'status', 'issued',
        'order_id', p_order_id,
        'ticket_ids', p_ticket_ids,
        'duration_seconds', v_duration,
        'issued_at', v_now,
        'queue_date', v_rec.queue_date,
        'past_queue_date', v_rec.queue_date < v_today
    );
END;
$$;

-- 9. 고객용 대기 상태 조회 (get_customer_queue_status) - 고객/익명 공개
-- - [R2 Fix 1] 공개 queue ID 우회 원천 차단 (customer_token 전용 조회)
-- - [R2 Fix 1] 24시간 만료(TOKEN_EXPIRED) 및 분당 60회 요청 제한(RATE_LIMIT_EXCEEDED)
-- - [R2 Fix 2] 호출 계약: (p_customer_token, p_site_id) 100% 일치
CREATE OR REPLACE FUNCTION public.get_customer_queue_status(
    p_customer_token TEXT,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_limit_rec RECORD;
    v_ahead INTEGER := 0;
    v_samples_count INTEGER := 0;
    v_avg_sec NUMERIC := 120;
    v_min_sec NUMERIC;
    v_max_sec NUMERIC;
    v_active_desks INTEGER := 0;
    v_is_paused BOOLEAN := false;
    v_est_min INTEGER;
    v_est_max INTEGER;
    v_wait_text TEXT := '집계 중';
    v_wait_code TEXT := 'CALCULATING';
BEGIN
    -- [R2 Fix 1] 토큰 유효성 검사 (빈 값 거부)
    IF p_customer_token IS NULL OR trim(p_customer_token) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TOKEN', 'message', '고객 비밀 토큰이 필요합니다.');
    END IF;

    -- [R2 Fix 1] 요청 빈도 제한 (Rate Limiting: 분당 60회 초과 시 차단)
    SELECT * INTO v_limit_rec FROM public.ticket_queue_rate_limits
    WHERE customer_token = p_customer_token FOR UPDATE;

    IF FOUND THEN
        IF v_limit_rec.window_start > (v_now - INTERVAL '1 minute') THEN
            IF v_limit_rec.request_count >= 60 THEN
                RETURN jsonb_build_object('ok', false, 'error', 'RATE_LIMIT_EXCEEDED', 'message', '요청 빈도가 너무 높습니다. 잠시 후 다시 시도해 주세요.');
            ELSE
                UPDATE public.ticket_queue_rate_limits
                SET request_count = request_count + 1,
                    last_request_at = v_now
                WHERE customer_token = p_customer_token;
            END IF;
        ELSE
            UPDATE public.ticket_queue_rate_limits
            SET request_count = 1,
                window_start = v_now,
                last_request_at = v_now
            WHERE customer_token = p_customer_token;
        END IF;
    ELSE
        INSERT INTO public.ticket_queue_rate_limits (customer_token, request_count, window_start, last_request_at)
        VALUES (p_customer_token, 1, v_now, v_now)
        ON CONFLICT (customer_token) DO UPDATE
        SET request_count = public.ticket_queue_rate_limits.request_count + 1,
            last_request_at = v_now;
    END IF;

    -- [R2 Fix 1] 공개 queue ID 우회 원천 제거: 오직 customer_token 으로만 조회
    SELECT * INTO v_rec FROM public.ticket_queue 
    WHERE site_id = p_site_id AND customer_token = p_customer_token;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_TOKEN', 'message', '대기 접수 정보를 찾을 수 없거나 유효하지 않은 토큰입니다.');
    END IF;

    -- [R2 Fix 1] 토큰 만료 검사 (접수 후 24시간 경과 시 만료 처리)
    IF v_rec.enqueued_at < (v_now - INTERVAL '24 hours') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TOKEN_EXPIRED', 'message', '만료된 대기표 토큰입니다. 다시 접수해 주세요.');
    END IF;

    -- [Fix 5] 앞선 미발권 팀 수: order_key < 내 order_key 기준
    SELECT COUNT(*) INTO v_ahead
    FROM public.ticket_queue
    WHERE site_id = v_rec.site_id
      AND queue_date = v_rec.queue_date
      AND order_key < v_rec.order_key
      AND status IN ('waiting', 'called', 'processing');

    -- [Fix 6] 창구 활성 및 정지 상태 확인
    SELECT COUNT(*), bool_or(is_paused) INTO v_active_desks, v_is_paused
    FROM public.ticket_queue_desks
    WHERE site_id = v_rec.site_id AND is_active = true;

    v_active_desks := GREATEST(1, COALESCE(v_active_desks, 1));

    -- 금일 완료 표본 집계 (20초 ~ 1800초 유효 표본만)
    SELECT COUNT(*), COALESCE(AVG(duration_seconds), 120),
           COALESCE(percentile_cont(0.25) WITHIN GROUP (ORDER BY duration_seconds), 90),
           COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_seconds), 150)
    INTO v_samples_count, v_avg_sec, v_min_sec, v_max_sec
    FROM public.ticket_queue
    WHERE site_id = v_rec.site_id
      AND queue_date = v_rec.queue_date
      AND status = 'issued'
      AND duration_seconds BETWEEN 20 AND 1800;

    -- 상태별 예상 시간 산출
    IF v_is_paused THEN
        v_wait_code := 'PAUSED';
        v_wait_text := '발권 일시 중지';
        v_est_min := NULL;
        v_est_max := NULL;
    ELSIF v_ahead = 0 THEN
        v_wait_code := 'IMMEDIATE';
        v_wait_text := '곧 호출 예정';
        v_est_min := 0;
        v_est_max := 2;
    ELSIF v_samples_count < 3 THEN
        v_wait_code := 'CALCULATING';
        v_wait_text := '집계 중';
        v_est_min := NULL;
        v_est_max := NULL;
    ELSE
        v_wait_code := 'ESTIMATED';
        v_est_min := GREATEST(1, CEIL((v_ahead * v_min_sec) / (v_active_desks * 60))::INTEGER);
        v_est_max := GREATEST(v_est_min, CEIL((v_ahead * v_max_sec) / (v_active_desks * 60))::INTEGER);
        IF v_est_min = v_est_max THEN
            v_wait_text := '약 ' || v_est_min || '분';
        ELSE
            v_wait_text := '약 ' || v_est_min || '~' || v_est_max || '분';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'queue_number', v_rec.queue_number,
        'formatted_number', v_rec.formatted_number,
        'customer_token', v_rec.customer_token,
        'status', v_rec.status,
        'desk_no', v_rec.desk_no,
        'ahead_count', v_ahead,
        'wait_time', jsonb_build_object(
            'code', v_wait_code,
            'text', v_wait_text,
            'minutes', v_est_max,
            'min_minutes', v_est_min,
            'max_minutes', v_est_max,
            'sampleCount', v_samples_count,
            'activeDesks', v_active_desks,
            'isPaused', v_is_paused
        ),
        'updated_at', NOW()
    );
END;
$$;

-- 10. 공개 호출판 데이터 조회 (get_queue_public_display) - 공개/익명 허용
-- - Zero PII: 내부 id 및 토큰 일체 제거 (번호, 창구, 상태, 호출시각만 표출)
CREATE OR REPLACE FUNCTION public.get_queue_public_display(
    p_date DATE DEFAULT ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE),
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_called JSONB;
    v_waiting_count INTEGER;
BEGIN
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'desk_no', desk_no,
            'queue_number', queue_number,
            'formatted_number', formatted_number,
            'status', status,
            'called_at', called_at
        ) ORDER BY desk_no ASC
    ), '[]'::jsonb)
    INTO v_called
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = p_date AND status IN ('called', 'processing');

    SELECT COUNT(*) INTO v_waiting_count
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = p_date AND status = 'waiting';

    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'called_teams', v_called,
        'waiting_teams_count', v_waiting_count,
        'updated_at', NOW()
    );
END;
$$;

-- 11. 직원 대기열 관제 목록 조회 (get_staff_queue_list) - 직원 전용
-- - [R2 Fix 3] 서버 직원·시설 권한 검증
CREATE OR REPLACE FUNCTION public.get_staff_queue_list(
    p_access_code TEXT,
    p_date DATE DEFAULT ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE),
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_waiting JSONB;
    v_called JSONB;
    v_held JSONB;
    v_desks JSONB;
    v_waiting_count INTEGER := 0;
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_past JSONB;
    v_past_total INTEGER := 0;
    v_past_open JSONB;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- 대기 중인 팀 목록
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', id,
            'queue_number', queue_number,
            'order_key', order_key,
            'formatted_number', formatted_number,
            'guardian_name', guardian_name,
            'consent_id', consent_id,
            'party_size', party_size,
            'enqueued_at', enqueued_at,
            'status', status
        ) ORDER BY order_key ASC
    ), '[]'::jsonb), COUNT(*)
    INTO v_waiting, v_waiting_count
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = p_date AND status = 'waiting';

    -- 호출 / 처리 중인 팀 목록
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', id,
            'queue_number', queue_number,
            'formatted_number', formatted_number,
            'guardian_name', guardian_name,
            'consent_id', consent_id,
            'party_size', party_size,
            'desk_no', desk_no,
            'status', status,
            'called_at', called_at,
            'processing_started_at', processing_started_at
        ) ORDER BY desk_no ASC
    ), '[]'::jsonb)
    INTO v_called
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = p_date AND status IN ('called', 'processing');

    -- 부재 보류 중인 팀 목록
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', id,
            'queue_number', queue_number,
            'formatted_number', formatted_number,
            'guardian_name', guardian_name,
            'consent_id', consent_id,
            'party_size', party_size,
            'hold_reason', hold_reason,
            'hold_at', hold_at,
            'status', status
        ) ORDER BY hold_at ASC
    ), '[]'::jsonb)
    INTO v_held
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = p_date AND status = 'no_show';

    -- 창구 상태 — [R4] 오늘 점유(오늘 행 기준)와 저장된 포인터를 구분해 보고한다. 포인터를 고치지 않는다 (조회 RPC 는 쓰지 않음)
    SELECT COALESCE(jsonb_agg(d.obj ORDER BY d.desk_no), '[]'::jsonb)
    INTO v_desks
    FROM (
        SELECT k.desk_no, jsonb_build_object(
            'desk_no', k.desk_no,
            'is_active', k.is_active,
            'is_paused', k.is_paused,
            'current_queue_id', CASE WHEN k.current_queue_id IS NOT NULL AND st.stale IS NULL THEN k.current_queue_id ELSE o.occ->>'id' END,
            'occupant', CASE WHEN k.current_queue_id IS NOT NULL AND st.stale IS NULL THEN pt.pobj ELSE o.occ END,
            'occupancy_count', c.cnt,
            'pointer_queue_id', k.current_queue_id,
            'pointer_state', CASE
                WHEN k.current_queue_id IS NULL AND o.occ IS NULL THEN 'empty'
                WHEN k.current_queue_id IS NOT NULL AND st.stale IS NULL THEN 'ok'
                WHEN o.occ IS NOT NULL THEN 'missing'
                ELSE 'stale' END,
            'pointer_stale', st.stale
        ) AS obj
        FROM public.ticket_queue_desks k
        CROSS JOIN LATERAL (SELECT private.ticket_queue_desk_occupant(k.site_id, k.desk_no, v_today) AS occ) o
        CROSS JOIN LATERAL (SELECT private.ticket_queue_pointer_stale(k.site_id, k.desk_no, k.current_queue_id, v_today) AS stale) st
        LEFT JOIN LATERAL (
            SELECT jsonb_build_object('id', q.id, 'formatted_number', q.formatted_number, 'status', q.status, 'consent_id', q.consent_id) AS pobj
              FROM public.ticket_queue q WHERE q.id = k.current_queue_id
        ) pt ON true
        CROSS JOIN LATERAL (
            SELECT COUNT(*)::INTEGER AS cnt FROM public.ticket_queue q
             WHERE q.site_id = k.site_id AND q.queue_date = v_today AND q.desk_no = k.desk_no AND q.status IN ('called', 'processing')
        ) c
        WHERE k.site_id = p_site_id
    ) d;

    -- [R4] 과거 미정리 팀 (지난 영업일 called/processing). 기록된 주문과 직원이 할 수 있는 명시적 동작을 함께 돌려준다
    SELECT COUNT(*) INTO v_past_total
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date < v_today AND status IN ('called', 'processing');

    SELECT COALESCE(jsonb_agg(x.obj ORDER BY x.queue_date, x.desk_no NULLS LAST, x.queue_number), '[]'::jsonb)
    INTO v_past
    FROM (
        SELECT q.queue_date, q.desk_no, q.queue_number, jsonb_build_object(
            'id', q.id,
            'queue_date', q.queue_date,
            'queue_number', q.queue_number,
            'formatted_number', q.formatted_number,
            'status', q.status,
            'desk_no', q.desk_no,
            'consent_id', q.consent_id,
            'guardian_name', q.guardian_name,
            'party_size', q.party_size,
            'called_at', q.called_at,
            'processing_started_at', q.processing_started_at,
            'recorded_orders', r.rec,
            'allowed_actions', private.ticket_queue_past_actions(q.status, r.rec),
            'blocked_reason', CASE WHEN jsonb_array_length(private.ticket_queue_past_actions(q.status, r.rec)) = 0
                                   THEN 'LEDGER_REVIEW_REQUIRED' END
        ) AS obj
        FROM public.ticket_queue q
        CROSS JOIN LATERAL (SELECT private.ticket_queue_recorded_orders(q.consent_id) AS rec) r
        WHERE q.site_id = p_site_id AND q.queue_date < v_today AND q.status IN ('called', 'processing')
        ORDER BY q.queue_date, q.desk_no NULLS LAST, q.queue_number
        LIMIT 100
    ) x;

    SELECT jsonb_build_object(
        'waiting', COUNT(*) FILTER (WHERE status = 'waiting'),
        'no_show', COUNT(*) FILTER (WHERE status = 'no_show'))
    INTO v_past_open
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date < v_today AND status IN ('waiting', 'no_show');

    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'waiting_count', v_waiting_count,
        'waiting_teams', v_waiting,
        'called_teams', v_called,
        'held_teams', v_held,
        'desks', v_desks,
        'queue_day', v_today,
        'past_unresolved_total', v_past_total,
        'past_unresolved_teams', v_past,
        'past_open_counts', v_past_open,
        'server_time', NOW()
    );
END;
$$;

-- 12. 창구 일시 정지 토글 (set_desk_pause_status) - 직원 전용
-- - [R2 Fix 3] 서버 직원·시설 권한 검증
CREATE OR REPLACE FUNCTION public.set_desk_pause_status(
    p_access_code TEXT,
    p_desk_no INTEGER,
    p_is_paused BOOLEAN,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- [R4] 시설 잠금 (호출과 정지가 겹칠 때 순서를 정한다)
    PERFORM private.lock_ticket_queue_site(p_site_id);

    UPDATE public.ticket_queue_desks
    SET is_paused = p_is_paused,
        updated_at = v_now
    WHERE site_id = p_site_id AND desk_no = p_desk_no;

    RETURN jsonb_build_object('ok', true, 'desk_no', p_desk_no, 'is_paused', p_is_paused, 'updated_at', v_now);
END;
$$;

-- ============================================================================
-- RLS 및 최소 권한(Least Privilege) 설정 (R2 보안 강화 반영)
-- ============================================================================
ALTER TABLE public.ticket_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_queue_desks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_queue_rate_limits ENABLE ROW LEVEL SECURITY;

-- 1) ticket_queue / ticket_queue_rate_limits 테이블 직접 조회 차단
DROP POLICY IF EXISTS "Deny direct anon select on ticket_queue" ON public.ticket_queue;
CREATE POLICY "Deny direct anon select on ticket_queue"
    ON public.ticket_queue FOR SELECT
    TO anon
    USING (false);

DROP POLICY IF EXISTS "Deny direct anon on ticket_queue_rate_limits" ON public.ticket_queue_rate_limits;
CREATE POLICY "Deny direct anon on ticket_queue_rate_limits"
    ON public.ticket_queue_rate_limits FOR ALL
    TO anon
    USING (false);

-- 2) 모든 RPC 함수의 PUBLIC 기본 실행 권한 철회 (보안 홀 차단)
REVOKE ALL ON FUNCTION public.enqueue_consent_team(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_queue_status(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_queue_public_display(DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.call_next_queue_team(TEXT, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recall_queue_team(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_queue_processing(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hold_queue_team(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_queue_team(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_queue_team(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_queue_issuance(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_staff_queue_list(TEXT, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_desk_pause_status(TEXT, INTEGER, BOOLEAN, TEXT) FROM PUBLIC;

-- 3) 고객 및 공개 엔드포인트: anon, authenticated에게만 최소 권한 부여
GRANT EXECUTE ON FUNCTION public.enqueue_consent_team(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_queue_status(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_queue_public_display(DATE, TEXT) TO anon, authenticated;

-- 4) 직원 데스크 엔드포인트: anon, authenticated에게 실행 권한 부여
--    (클라이언트 공용 anon 키 전송 경로를 지원하되, 함수 내부에서 private.verify_staff_permission 을 통해 
--     운영자 암호 해시 검증 및 시설 권한을 철저히 확인하여 무단 호출을 원천 차단함)
GRANT EXECUTE ON FUNCTION public.call_next_queue_team(TEXT, INTEGER, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recall_queue_team(TEXT, TEXT, INTEGER, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_queue_processing(TEXT, TEXT, INTEGER, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_queue_team(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_queue_team(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_queue_team(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_queue_issuance(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_staff_queue_list(TEXT, DATE, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_desk_pause_status(TEXT, INTEGER, BOOLEAN, TEXT) TO anon, authenticated;

-- 5) [CLAUDE-011 후속] Supabase 기본 권한에 대비한 최소 권한 이중화
--    Supabase 는 public 스키마에 새로 만든 테이블·함수에 anon·authenticated 권한을 기본으로 준다(default privileges).
--    대기열 테이블은 위 RPC(SECURITY DEFINER)로만 다루므로 표 권한을 모두 회수한다.
--    RLS(1)와 이중으로 막아, 정책을 실수로 열어도 표가 직접 노출되지 않게 한다.
REVOKE ALL ON TABLE public.ticket_queue, public.ticket_queue_desks, public.ticket_queue_rate_limits FROM PUBLIC, anon, authenticated;
--    내부 함수는 PostgreSQL 기본 PUBLIC 실행 권한까지 회수한다 (private 스키마 USAGE 회수와 이중 차단).
REVOKE ALL ON FUNCTION private.verify_staff_permission(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.lock_ticket_queue_day(TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.lock_ticket_queue_site(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ticket_queue_recorded_orders(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ticket_queue_past_actions(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ticket_queue_past_rejection(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ticket_queue_sync_pointer(TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ticket_queue_desk_occupant(TEXT, INTEGER, DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ticket_queue_pointer_stale(TEXT, INTEGER, TEXT, DATE) FROM PUBLIC, anon, authenticated;
