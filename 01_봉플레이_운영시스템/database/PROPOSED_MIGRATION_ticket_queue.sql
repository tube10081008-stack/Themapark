-- ============================================================================
-- PROPOSED MIGRATION: ticket_queue (발권 대기열 시스템 — R1 보완 반영)
-- 
-- 태스크: ANT-006 / 지시서: BEN-022 (R1 검토 반영)
-- 목적: QR 안전동의서 서버 접수 시 당일 대기번호 부여, 고객 순서·예상시간 안내,
--       매표소 호출 및 발권 완료 시 대기열 제외 파이프라인 구축.
-- 주요 보완 (R1 검토 6대 필수 수정 반영):
-- 1. 서버 접수 실패 시 로컬 번호 발급 원천 차단
-- 2. SECURITY DEFINER 권한(REVOKE PUBLIC, search_path 고정, anon 직원RPC 차단) 및 128비트 고객 비밀 토큰 도입
-- 3. 서버 발권 확정 시 order_id / ticket_ids 원장 정합성 및 상태 전이 검증
-- 4. 멱등키 조회 전 advisory lock 선취득, 멱등키 재사용 차단, 동의서 중복 제약, 단일 창구 다중 호출 차단
-- 5. 보류 복귀 시 order_key를 대기열 맨 뒤로 재할당 (새치기 원천 차단)
-- 6. 절대시각 NOW() (TIMESTAMPTZ)와 KST 영업일 분리, 창구 상태(정지/활성) 테이블 및 범위형 ETA 통합
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
-- RPC 함수군 정의 (고정 search_path 및 권한 검증 탑재)
-- ============================================================================

-- 1. 서약서 대기열 접수 (enqueue_consent_team)
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
SET search_path = public, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_existing RECORD;
    v_next_num INTEGER;
    v_next_order_key BIGINT;
    v_entry_id TEXT;
    v_fmt_num TEXT;
    v_cust_token VARCHAR(64);
    v_now TIMESTAMPTZ := NOW();
    v_lock_key BIGINT;
BEGIN
    IF p_consent_id IS NULL OR trim(p_consent_id) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CONSENT_ID_REQUIRED', 'message', '동의서 ID가 필요합니다.');
    END IF;
    IF p_idempotency_key IS NULL OR trim(p_idempotency_key) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'IDEMPOTENCY_KEY_REQUIRED', 'message', '멱등키가 필요합니다.');
    END IF;

    -- [Fix 4] 동시 동일 키 및 번호 채번 경합 방지를 위해 배타적 Advisory Lock 선취득
    v_lock_key := hashtext(p_site_id || ':' || v_today::TEXT);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- 멱등성 검사: 동일 사이트/영업일 내 동일 멱등키 조회
    SELECT * INTO v_existing 
    FROM public.ticket_queue 
    WHERE site_id = p_site_id AND queue_date = v_today AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        -- [Fix 4] 멱등키가 다른 동의서에 재사용된 경우 명시적 거부
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
            'desk_no', v_existing.desk_no,
            'enqueued_at', v_existing.enqueued_at
        );
    END IF;

    -- 동의서 중복 검사: 동일 동의서가 다른 멱등키로 다시 접수되는 경우 기존 레코드 반환
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
            'desk_no', v_existing.desk_no,
            'enqueued_at', v_existing.enqueued_at
        );
    END IF;

    -- 당일 일련번호 및 초기 order_key 채번
    SELECT COALESCE(MAX(queue_number), 0) + 1 INTO v_next_num
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = v_today;

    SELECT COALESCE(MAX(order_key), 0) + 1 INTO v_next_order_key
    FROM public.ticket_queue
    WHERE site_id = p_site_id AND queue_date = v_today;

    v_fmt_num := '#' || LPAD(v_next_num::TEXT, 3, '0');
    v_entry_id := 'q_' || TO_CHAR(v_today, 'YYYYMMDD') || '_' || LPAD(v_next_num::TEXT, 4, '0') || '_' || SUBSTRING(MD5(RANDOM()::TEXT), 1, 6);
    
    -- [Fix 2] 128비트 난수 고객 조회 토큰 발급
    v_cust_token := encode(gen_random_bytes(16), 'hex');

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
-- - anon 호출 차단
-- - 단일 창구 다중 호출(이중 호출) 방지
-- - order_key 오름차순 호출 (보류 복귀 팀은 맨 뒤)
CREATE OR REPLACE FUNCTION public.call_next_queue_team(
    p_desk_no INTEGER,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_today DATE := ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE);
    v_now TIMESTAMPTZ := NOW();
    v_target RECORD;
    v_desk_rec RECORD;
BEGIN
    -- [Fix 2] 익명 사용자(anon) 실행 거부
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
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
    p_queue_id TEXT,
    p_desk_no INTEGER DEFAULT NULL,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
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
    p_queue_id TEXT,
    p_desk_no INTEGER DEFAULT NULL,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
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
    p_queue_id TEXT,
    p_reason TEXT DEFAULT '고객 부재',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
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
-- - 복귀 사유, 복귀 직원, 복귀 시각 기록
CREATE OR REPLACE FUNCTION public.restore_queue_team(
    p_queue_id TEXT,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_reason TEXT DEFAULT '고객 창구 방문 복귀',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_new_order_key BIGINT;
BEGIN
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
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
    p_queue_id TEXT,
    p_reason TEXT DEFAULT '고객 취소',
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
BEGIN
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
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
-- - [Fix 3] order_id / ticket_ids 필수 검증 및 상태 전이 검증
-- - ticket_ledger 테이블 존재 시 원장 존재 대조 검증
CREATE OR REPLACE FUNCTION public.complete_queue_issuance(
    p_queue_id TEXT,
    p_order_id TEXT,
    p_ticket_ids JSONB DEFAULT '[]'::jsonb,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_duration INTEGER := 60;
    v_tickets_count INTEGER;
BEGIN
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
    END IF;

    -- [Fix 3] order_id 및 ticket_ids 유효성 검사
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

    -- [Fix 3] 호출 또는 처리 중 상태에서만 완료 가능 (waiting/canceled/issued/no_show 차단)
    IF v_rec.status NOT IN ('called', 'processing') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS', 'message', '호출 또는 처리 중인 팀만 발권 완료할 수 있습니다.');
    END IF;

    -- [Fix 3] ticket_ledger 테이블이 존재하는 경우 원장 일치 여부 대조
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ticket_ledger') THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.ticket_ledger 
            WHERE order_id = p_order_id AND (consent_id = v_rec.consent_id OR v_rec.consent_id IS NULL)
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'LEDGER_VERIFICATION_FAILED', 'message', '발권 원장(ticket_ledger)과 일치하지 않습니다.');
        END IF;
    END IF;

    -- 처리 시간 산출 (processing_started_at 우선, 없으면 called_at 기준)
    IF v_rec.processing_started_at IS NOT NULL THEN
        v_duration := GREATEST(10, EXTRACT(EPOCH FROM (v_now - v_rec.processing_started_at))::INTEGER);
    ELSIF v_rec.called_at IS NOT NULL THEN
        v_duration := GREATEST(10, EXTRACT(EPOCH FROM (v_now - v_rec.called_at))::INTEGER);
    END IF;

    UPDATE public.ticket_queue
    SET status = 'issued',
        issued_at = v_now,
        order_id = p_order_id,
        ticket_ids = p_ticket_ids,
        duration_seconds = v_duration,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    IF v_rec.desk_no IS NOT NULL THEN
        UPDATE public.ticket_queue_desks
        SET current_queue_id = NULL,
            updated_at = v_now
        WHERE site_id = p_site_id AND desk_no = v_rec.desk_no AND current_queue_id = p_queue_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_queue_id,
        'status', 'issued',
        'duration_seconds', v_duration,
        'issued_at', v_now
    );
END;
$$;

-- 9. 고객용 대기 상태 조회 (get_customer_queue_status) - 고객/익명 공개
-- - [Fix 2] customer_token 기반 조회 지원
-- - [Fix 5] order_key 기반 앞선 팀 수 계산 (보류 복귀 팀은 맨 뒤)
-- - [Fix 6] 창구 정지/활성 수 반영 및 범위형(P25~P75) ETA 산출
CREATE OR REPLACE FUNCTION public.get_customer_queue_status(
    p_customer_token TEXT,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rec RECORD;
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
    -- customer_token 우선 조회, 없으면 id로 fallback
    SELECT * INTO v_rec FROM public.ticket_queue 
    WHERE site_id = p_site_id AND (customer_token = p_customer_token OR id = p_customer_token);

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 접수 정보를 찾을 수 없습니다.');
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
        'id', v_rec.id,
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
-- - [Fix 2] Zero PII: 내부 id 및 토큰 일체 제거 (번호, 창구, 상태, 호출시각만 표출)
CREATE OR REPLACE FUNCTION public.get_queue_public_display(
    p_date DATE DEFAULT ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE),
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_called JSONB;
    v_waiting_count INTEGER;
BEGIN
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'queue_number', queue_number,
            'formatted_number', formatted_number,
            'desk_no', desk_no,
            'status', status,
            'called_at', called_at
        ) ORDER BY called_at DESC NULLS LAST
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
-- - [Fix 6] 클라이언트 로컬 메모리 대신 서버 상태를 직접 조회하여 다중 단말 실시간 동기화
CREATE OR REPLACE FUNCTION public.get_staff_queue_list(
    p_site_id TEXT DEFAULT 'bongplay_bonghwa',
    p_date DATE DEFAULT ((NOW() AT TIME ZONE 'Asia/Seoul')::DATE)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_waiting JSONB;
    v_called JSONB;
    v_held JSONB;
    v_desks JSONB;
    v_waiting_count INTEGER := 0;
BEGIN
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
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
CREATE OR REPLACE FUNCTION public.set_desk_pause_status(
    p_desk_no INTEGER,
    p_is_paused BOOLEAN,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
BEGIN
    IF current_setting('request.jwt.claim.role', true) = 'anon' OR auth.role() = 'anon' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED', 'message', '직원 권한이 필요합니다.');
    END IF;

    UPDATE public.ticket_queue_desks
    SET is_paused = p_is_paused,
        updated_at = v_now
    WHERE site_id = p_site_id AND desk_no = p_desk_no;

    RETURN jsonb_build_object('ok', true, 'desk_no', p_desk_no, 'is_paused', p_is_paused, 'updated_at', v_now);
END;
$$;

-- ============================================================================
-- RLS 및 최소 권한(Least Privilege) 설정 (Fix 2 반영)
-- ============================================================================
ALTER TABLE public.ticket_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ticket_queue_desks ENABLE ROW LEVEL SECURITY;

-- 1) ticket_queue 테이블 직접 조회 차단
DROP POLICY IF EXISTS "Deny direct anon select on ticket_queue" ON public.ticket_queue;
CREATE POLICY "Deny direct anon select on ticket_queue"
    ON public.ticket_queue FOR SELECT
    TO anon
    USING (false);

-- 2) 모든 RPC 함수의 PUBLIC 기본 실행 권한 철회 (보안 홀 차단)
REVOKE ALL ON FUNCTION public.enqueue_consent_team FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_queue_status FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_queue_public_display FROM PUBLIC;
REVOKE ALL ON FUNCTION public.call_next_queue_team FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recall_queue_team FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_queue_processing FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hold_queue_team FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_queue_team FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_queue_team FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_queue_issuance FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_staff_queue_list FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_desk_pause_status FROM PUBLIC;

-- 3) 고객 및 공개 엔드포인트: anon, authenticated에게만 최소 권한 부여
GRANT EXECUTE ON FUNCTION public.enqueue_consent_team TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_queue_status TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_queue_public_display TO anon, authenticated;

-- 4) 직원 데스크 엔드포인트: authenticated에게만 허용 (anon 접근 차단)
GRANT EXECUTE ON FUNCTION public.call_next_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.recall_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_queue_processing TO authenticated;
GRANT EXECUTE ON FUNCTION public.hold_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_queue_issuance TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_staff_queue_list TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_desk_pause_status TO authenticated;
