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
-- RPC 함수군 정의 (고정 search_path 및 100% 일치 계약)
-- ============================================================================

-- 1. 서약서 대기열 접수 (enqueue_consent_team) - 고객/익명 공개
-- - Advisory Lock 선취득으로 동시 동일 키 race condition 원천 차단
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
    v_lock_key BIGINT;
BEGIN
    -- 1. [Fix 4] 동시 접수 race condition 방지용 분산 락 (Advisory Lock)
    v_lock_key := ('x' || substr(md5(p_site_id || ':' || v_today::text || ':' || p_idempotency_key), 1, 15))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

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

    -- 4. 당일 최대 대기번호 및 order_key 원자적 조회
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
    INSERT INTO public.ticket_queue (
        id, site_id, queue_date, queue_number, order_key, customer_token, formatted_number,
        consent_id, guardian_name, guardian_phone, party_size,
        idempotency_key, status, enqueued_at, version
    ) VALUES (
        v_entry_id, p_site_id, v_today, v_next_num, v_next_order_key, v_cust_token, v_fmt_num,
        p_consent_id, p_guardian_name, p_guardian_phone, GREATEST(1, p_party_size),
        p_idempotency_key, 'waiting', v_now, 1
    );

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
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    -- 창구 정지 여부 확인
    SELECT * INTO v_desk_rec FROM public.ticket_queue_desks 
    WHERE site_id = p_site_id AND desk_no = p_desk_no;

    IF FOUND AND v_desk_rec.is_paused THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DESK_PAUSED', 'message', p_desk_no || '번 창구는 발권 일시 중지 상태입니다.');
    END IF;

    -- [Fix 4] 창구당 활성 1팀 제약: 이미 호출/처리 중인 팀이 있는지 검사
    IF EXISTS (
        SELECT 1 FROM public.ticket_queue
        WHERE site_id = p_site_id AND queue_date = v_today AND desk_no = p_desk_no AND status IN ('called', 'processing')
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DESK_ALREADY_OCCUPIED', 'message', p_desk_no || '번 창구에 이미 진행 중인 팀이 있습니다.');
    END IF;

    -- [Fix 5] order_key 오름차순으로 대기 1순위 선택 (SKIP LOCKED)
    SELECT * INTO v_target
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = v_today AND status = 'waiting'
    ORDER BY order_key ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'empty_queue', 'message', '대기 중인 팀이 없습니다.');
    END IF;

    UPDATE public.ticket_queue
    SET status = 'called',
        desk_no = p_desk_no,
        staff_id = p_staff_id,
        called_at = v_now,
        version = version + 1,
        updated_at = v_now
    WHERE id = v_target.id;

    UPDATE public.ticket_queue_desks
    SET current_queue_id = v_target.id,
        updated_at = v_now
    WHERE site_id = p_site_id AND desk_no = p_desk_no;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_target.id,
        'queue_number', v_target.queue_number,
        'formatted_number', v_target.formatted_number,
        'status', 'called',
        'desk_no', p_desk_no,
        'guardian_name', v_target.guardian_name,
        'party_size', v_target.party_size,
        'called_at', v_now
    );
END;
$$;

-- 3. 재호출 (recall_queue_team) - 직원 전용
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
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    IF v_rec.status NOT IN ('called', 'processing') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'message', '호출 또는 처리 중인 팀만 재호출할 수 있습니다.');
    END IF;

    UPDATE public.ticket_queue
    SET called_at = v_now,
        desk_no = COALESCE(p_desk_no, desk_no),
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'called_at', v_now);
END;
$$;

-- 4. 발권 처리 시작 (start_queue_processing) - 직원 전용
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
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    IF v_rec.status <> 'called' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'message', '호출(called) 상태인 팀만 발권 처리를 시작할 수 있습니다.');
    END IF;

    UPDATE public.ticket_queue
    SET status = 'processing',
        processing_started_at = v_now,
        desk_no = COALESCE(p_desk_no, desk_no),
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'processing', 'processing_started_at', v_now);
END;
$$;

-- 5. 부재 보류 (hold_queue_team) - 직원 전용
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
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
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

    IF v_rec.desk_no IS NOT NULL THEN
        UPDATE public.ticket_queue_desks
        SET current_queue_id = NULL,
            updated_at = v_now
        WHERE site_id = p_site_id AND desk_no = v_rec.desk_no AND current_queue_id = p_queue_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'no_show', 'hold_at', v_now);
END;
$$;

-- 6. 보류 복귀 (restore_queue_team) - 직원 전용
-- - [Fix 5] 복귀 시 order_key를 당일 최댓값 + 1로 재할당하여 맨 뒤로 배치 (새치기 원천 차단)
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
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_new_order_key BIGINT;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    IF v_rec.status <> 'no_show' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'message', '부재 보류(no_show) 상태인 팀만 복귀할 수 있습니다.');
    END IF;

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
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    -- [R2 Fix 3] 서버 직원·시설 권한 검증
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;

    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;

    -- [Fix 4] 발권 완료 건은 대기열에서 취소 불가
    IF v_rec.status = 'issued' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CANNOT_CANCEL_ISSUED', 'message', '이미 발권 완료된 건은 대기열에서 취소할 수 없습니다.');
    END IF;

    UPDATE public.ticket_queue
    SET status = 'canceled',
        canceled_at = v_now,
        cancel_reason = p_reason,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    IF v_rec.desk_no IS NOT NULL THEN
        UPDATE public.ticket_queue_desks
        SET current_queue_id = NULL,
            updated_at = v_now
        WHERE site_id = p_site_id AND desk_no = v_rec.desk_no AND current_queue_id = p_queue_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'canceled', 'canceled_at', v_now);
END;
$$;

-- 8. 발권 확정 완료 (complete_queue_issuance) - 직원 전용
-- - [R2 Fix 3] 서버 직원·시설 권한 검증
-- - [R2 Fix 4] 주문 결제 확정(order_payments), 서약서(safety_consents), 티켓(ticket_ledger) 전체 유효 상태 검증
-- - [R2 Fix 4] 동일 order_id 재시도 시 멱등 성공 결과 반환
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
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_duration INTEGER := 60;
    v_tickets_count INTEGER;
    v_matched_tickets INTEGER := 0;
    v_order_qty INTEGER := 0;
    v_order_total BIGINT := 0;
    v_paid_total BIGINT := 0;
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

    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id FOR UPDATE;
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
                'issued_at', v_rec.issued_at
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

    -- 7. [R3] 다른 팀 주문 연결 차단 (order_payments의 consent_id 대사)
    IF EXISTS (
        SELECT 1 FROM public.order_payments
        WHERE order_id = p_order_id
          AND consent_id IS NOT NULL
          AND v_rec.consent_id IS NOT NULL
          AND consent_id <> v_rec.consent_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_CONSENT_MISMATCH', 'message', '해당 주문의 서약서가 대기열 서약서와 일치하지 않습니다.');
    END IF;

    -- 8. [R3] 다른 팀 티켓 연결 차단 (ticket_ledger의 consent_id 대사)
    IF EXISTS (
        SELECT 1 FROM public.ticket_ledger
        WHERE ticket_id IN (SELECT jsonb_array_elements_text(p_ticket_ids))
          AND consent_id IS NOT NULL
          AND v_rec.consent_id IS NOT NULL
          AND consent_id <> v_rec.consent_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TICKET_CONSENT_MISMATCH', 'message', '다른 팀/서약서의 티켓이 포함되어 있습니다.');
    END IF;

    -- 9. [R3] 다른 주문의 티켓 포함 여부 검사
    IF EXISTS (
        SELECT 1 FROM public.ticket_ledger
        WHERE ticket_id IN (SELECT jsonb_array_elements_text(p_ticket_ids))
          AND order_id <> p_order_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TICKET_ORDER_MISMATCH', 'message', '다른 주문의 티켓이 포함되어 있습니다.');
    END IF;

    -- 10. [R3] 주문 품목 수량 대사 (order_items 수량 vs 발권 티켓 수)
    SELECT COALESCE(SUM(quantity), 0), COALESCE(SUM(total_price), 0)
    INTO v_order_qty, v_order_total
    FROM public.order_items
    WHERE order_id = p_order_id;

    IF v_order_qty <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_ITEMS_EMPTY', 'message', '주문 품목 원장이 없거나 수량이 0입니다.');
    END IF;

    IF v_tickets_count < v_order_qty THEN
        RETURN jsonb_build_object(
            'ok', false, 
            'error', 'TICKET_QUANTITY_MISMATCH', 
            'message', '발권된 티켓 수(' || v_tickets_count || ')가 주문 수량(' || v_order_qty || ')보다 적습니다.'
        );
    END IF;

    -- 11. [R3] 결제 확정 및 결제 금액 합계 대사 (order_payments vs order_items total_price)
    SELECT COALESCE(SUM(amount), 0) INTO v_paid_total
    FROM public.order_payments
    WHERE order_id = p_order_id
      AND (consent_id IS NULL OR consent_id = v_rec.consent_id)
      AND status = 'paid'
      AND cancelled_at IS NULL;

    IF v_paid_total <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYMENT_NOT_CONFIRMED', 'message', '결제가 확정되지 않았거나 유효한 결제 내역이 없습니다.');
    END IF;

    IF v_order_total > 0 AND v_paid_total < v_order_total THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'PARTIAL_PAYMENT_REJECTED',
            'message', '결제 수납 금액(' || v_paid_total || '원)이 주문 총액(' || v_order_total || '원)에 미달합니다.'
        );
    END IF;

    -- 12. [R2 Fix 4 / R3] 티켓 전체 유효 원장 검증 (ticket_ledger 에 전체 티켓 존재 및 취소 여부)
    SELECT COUNT(*) INTO v_matched_tickets
    FROM public.ticket_ledger
    WHERE order_id = p_order_id
      AND (consent_id IS NULL OR consent_id = v_rec.consent_id)
      AND cancelled_at IS NULL
      AND (status IS NULL OR status <> 'cancelled')
      AND ticket_id IN (SELECT jsonb_array_elements_text(p_ticket_ids));

    IF v_matched_tickets <> v_tickets_count THEN
        RETURN jsonb_build_object(
            'ok', false, 
            'error', 'TICKET_LEDGER_INCOMPLETE', 
            'message', '티켓 원장에 등록되지 않았거나 취소된 티켓이 포함되어 있습니다. (유효: ' || v_matched_tickets || '/' || v_tickets_count || ')'
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

    -- 15. 창구 슬롯 해제
    IF v_rec.desk_no IS NOT NULL THEN
        UPDATE public.ticket_queue_desks
        SET current_queue_id = NULL,
            updated_at = v_now
        WHERE site_id = p_site_id AND desk_no = v_rec.desk_no AND current_queue_id = p_queue_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'duplicate', false,
        'already_completed', false,
        'id', p_queue_id,
        'status', 'issued',
        'order_id', p_order_id,
        'ticket_ids', p_ticket_ids,
        'duration_seconds', v_duration,
        'issued_at', v_now
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
            'party_size', party_size,
            'hold_reason', hold_reason,
            'hold_at', hold_at,
            'status', status
        ) ORDER BY hold_at ASC
    ), '[]'::jsonb)
    INTO v_held
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = p_date AND status = 'no_show';

    -- 창구 상태
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'desk_no', desk_no,
            'is_active', is_active,
            'is_paused', is_paused,
            'current_queue_id', current_queue_id
        ) ORDER BY desk_no ASC
    ), '[]'::jsonb)
    INTO v_desks
    FROM public.ticket_queue_desks
    WHERE site_id = p_site_id;

    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'waiting_count', v_waiting_count,
        'waiting_teams', v_waiting,
        'called_teams', v_called,
        'held_teams', v_held,
        'desks', v_desks,
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
