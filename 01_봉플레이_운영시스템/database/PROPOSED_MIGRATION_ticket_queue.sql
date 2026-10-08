-- ============================================================================
-- PROPOSED MIGRATION: ticket_queue (발권 대기열 시스템)
-- 
-- 태스크: ANT-006 / 지시서: BEN-022
-- 목적: QR 안전동의서 서버 접수 시 당일 대기번호 부여, 고객 순서·예상시간 안내,
--       매표소 호출 및 발권 완료 시 대기열 제외 파이프라인 구축.
-- 주의: 본 파일은 제안 마이그레이션(Proposed SQL)으로 운영 DB에 자동 적용하지 않으며,
--       벤(Ben) 검토 및 관리자 승인 후 수동 반영합니다.
-- ============================================================================

-- 1. 대기열 테이블 생성
CREATE TABLE IF NOT EXISTS public.ticket_queue (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL DEFAULT 'bongplay_bonghwa',
    queue_date DATE NOT NULL DEFAULT CURRENT_DATE,
    queue_number INTEGER NOT NULL,
    formatted_number TEXT NOT NULL,
    consent_id TEXT NOT NULL REFERENCES public.safety_consents(id) ON DELETE CASCADE,
    visit_id TEXT,
    household_id TEXT,
    guardian_name TEXT NOT NULL,
    guardian_phone TEXT NOT NULL,
    party_size INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'called', 'processing', 'issued', 'no_show', 'canceled')),
    desk_no INTEGER,
    staff_id TEXT,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('Asia/Seoul', NOW()),
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
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('Asia/Seoul', NOW()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT TIMEZONE('Asia/Seoul', NOW()),
    CONSTRAINT uq_ticket_queue_date_number UNIQUE (queue_date, queue_number)
);

-- 인덱스 생성
CREATE INDEX IF NOT EXISTS idx_ticket_queue_date_status_num 
    ON public.ticket_queue (queue_date, status, queue_number);

CREATE INDEX IF NOT EXISTS idx_ticket_queue_consent_id 
    ON public.ticket_queue (consent_id);

CREATE INDEX IF NOT EXISTS idx_ticket_queue_idempotency 
    ON public.ticket_queue (idempotency_key);

-- 2. 접수 함수 (enqueue_consent_team)
-- - 멱등성 보장 (idempotency_key 중복 시 기존 대기정보 반환)
-- - 원자적 당일 일련번호 채번
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
AS $$
DECLARE
    v_today DATE := (TIMEZONE('Asia/Seoul', NOW()))::DATE;
    v_existing RECORD;
    v_next_num INTEGER;
    v_entry_id TEXT;
    v_fmt_num TEXT;
    v_now TIMESTAMPTZ := TIMEZONE('Asia/Seoul', NOW());
BEGIN
    -- 멱등성 검사: 이미 동일 멱등성 키가 존재하면 기존 레코드 반환
    SELECT * INTO v_existing 
    FROM public.ticket_queue 
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'ok', true,
            'duplicate', true,
            'id', v_existing.id,
            'queue_number', v_existing.queue_number,
            'formatted_number', v_existing.formatted_number,
            'status', v_existing.status,
            'desk_no', v_existing.desk_no,
            'enqueued_at', v_existing.enqueued_at
        );
    END IF;

    -- 당일 일련번호 배타적 락을 통한 안전 채번
    PERFORM pg_advisory_xact_lock(hashtext('ticket_queue_' || v_today::TEXT));

    SELECT COALESCE(MAX(queue_number), 0) + 1 INTO v_next_num
    FROM public.ticket_queue
    WHERE queue_date = v_today;

    v_fmt_num := '#' || LPAD(v_next_num::TEXT, 3, '0');
    v_entry_id := 'q_' || TO_CHAR(v_today, 'YYYYMMDD') || '_' || LPAD(v_next_num::TEXT, 4, '0') || '_' || SUBSTRING(MD5(RANDOM()::TEXT), 1, 6);

    INSERT INTO public.ticket_queue (
        id, site_id, queue_date, queue_number, formatted_number,
        consent_id, guardian_name, guardian_phone, party_size,
        idempotency_key, status, enqueued_at, version
    ) VALUES (
        v_entry_id, p_site_id, v_today, v_next_num, v_fmt_num,
        p_consent_id, p_guardian_name, p_guardian_phone, GREATEST(1, p_party_size),
        p_idempotency_key, 'waiting', v_now, 1
    );

    RETURN jsonb_build_object(
        'ok', true,
        'duplicate', false,
        'id', v_entry_id,
        'queue_number', v_next_num,
        'formatted_number', v_fmt_num,
        'status', 'waiting',
        'enqueued_at', v_now
    );
END;
$$;

-- 3. 다음 대기팀 호출 (call_next_queue_team)
-- - 다중 단말 경합 차단 (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.call_next_queue_team(
    p_desk_no INTEGER,
    p_staff_id TEXT DEFAULT 'desk_staff'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_today DATE := (TIMEZONE('Asia/Seoul', NOW()))::DATE;
    v_now TIMESTAMPTZ := TIMEZONE('Asia/Seoul', NOW());
    v_target RECORD;
BEGIN
    SELECT * INTO v_target
    FROM public.ticket_queue
    WHERE queue_date = v_today AND status = 'waiting'
    ORDER BY queue_number ASC
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

-- 4. 재호출 (recall_queue_team)
CREATE OR REPLACE FUNCTION public.recall_queue_team(
    p_queue_id TEXT,
    p_desk_no INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now TIMESTAMPTZ := TIMEZONE('Asia/Seoul', NOW());
    v_rec RECORD;
BEGIN
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_rec.status NOT IN ('called', 'processing') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status', 'message', '호출 중인 상태만 재호출 가능합니다.');
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

-- 5. 발권 처리 시작 (start_queue_processing)
CREATE OR REPLACE FUNCTION public.start_queue_processing(
    p_queue_id TEXT,
    p_desk_no INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now TIMESTAMPTZ := TIMEZONE('Asia/Seoul', NOW());
BEGIN
    UPDATE public.ticket_queue
    SET status = 'processing',
        processing_started_at = v_now,
        desk_no = COALESCE(p_desk_no, desk_no),
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id AND status = 'called';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status_or_not_found');
    END IF;

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'processing', 'processing_started_at', v_now);
END;
$$;

-- 6. 부재 보류 (hold_queue_team)
CREATE OR REPLACE FUNCTION public.hold_queue_team(
    p_queue_id TEXT,
    p_reason TEXT DEFAULT '고객 부재'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now TIMESTAMPTZ := TIMEZONE('Asia/Seoul', NOW());
BEGIN
    UPDATE public.ticket_queue
    SET status = 'no_show',
        hold_at = v_now,
        hold_reason = p_reason,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id AND status IN ('called', 'processing');

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status_or_not_found');
    END IF;

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'no_show', 'hold_at', v_now);
END;
$$;

-- 7. 보류 복귀 (restore_queue_team)
CREATE OR REPLACE FUNCTION public.restore_queue_team(
    p_queue_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now TIMESTAMPTZ := TIMEZONE('Asia/Seoul', NOW());
BEGIN
    UPDATE public.ticket_queue
    SET status = 'waiting',
        restored_at = v_now,
        desk_no = NULL,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id AND status = 'no_show';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_status_or_not_found');
    END IF;

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'waiting', 'restored_at', v_now);
END;
$$;

-- 8. 접수 취소 (cancel_queue_team)
CREATE OR REPLACE FUNCTION public.cancel_queue_team(
    p_queue_id TEXT,
    p_reason TEXT DEFAULT '고객 취소'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now TIMESTAMPTZ := TIMEZONE('Asia/Seoul', NOW());
BEGIN
    UPDATE public.ticket_queue
    SET status = 'canceled',
        canceled_at = v_now,
        cancel_reason = p_reason,
        version = version + 1,
        updated_at = v_now
    WHERE id = p_queue_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    RETURN jsonb_build_object('ok', true, 'id', p_queue_id, 'status', 'canceled', 'canceled_at', v_now);
END;
$$;

-- 9. 발권 확정 완료 (complete_queue_issuance)
-- - 서버 발권 확정 후 호출되며 대기열에서 제외
-- - 실패 시 호출되지 않음
CREATE OR REPLACE FUNCTION public.complete_queue_issuance(
    p_queue_id TEXT,
    p_order_id TEXT,
    p_ticket_ids JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now TIMESTAMPTZ := TIMEZONE('Asia/Seoul', NOW());
    v_rec RECORD;
    v_duration INTEGER := 60;
BEGIN
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    IF v_rec.called_at IS NOT NULL THEN
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

    RETURN jsonb_build_object(
        'ok', true,
        'id', p_queue_id,
        'status', 'issued',
        'duration_seconds', v_duration,
        'issued_at', v_now
    );
END;
$$;

-- 10. 고객용 대기 상태 조회 (get_customer_queue_status)
-- - 내 앞선 팀 수 및 예상 시간 집계
CREATE OR REPLACE FUNCTION public.get_customer_queue_status(
    p_queue_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_rec RECORD;
    v_ahead INTEGER := 0;
    v_samples_count INTEGER := 0;
    v_avg_sec NUMERIC := 120;
    v_est_min INTEGER;
    v_wait_text TEXT := '집계 중';
    v_wait_code TEXT := 'CALCULATING';
BEGIN
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    -- 앞선 미발권 팀 수 (동일 일자, 번호 < 내 번호, waiting/called/processing 상태)
    SELECT COUNT(*) INTO v_ahead
    FROM public.ticket_queue
    WHERE queue_date = v_rec.queue_date
      AND queue_number < v_rec.queue_number
      AND status IN ('waiting', 'called', 'processing');

    -- 금일 완료 표본 집계
    SELECT COUNT(*), COALESCE(AVG(duration_seconds), 120)
    INTO v_samples_count, v_avg_sec
    FROM public.ticket_queue
    WHERE queue_date = v_rec.queue_date
      AND status = 'issued'
      AND duration_seconds BETWEEN 20 AND 1800;

    IF v_ahead = 0 THEN
        v_wait_code := 'IMMEDIATE';
        v_wait_text := '곧 호출 예정';
        v_est_min := 0;
    ELSIF v_samples_count < 3 THEN
        v_wait_code := 'CALCULATING';
        v_wait_text := '집계 중';
        v_est_min := NULL;
    ELSE
        v_wait_code := 'ESTIMATED';
        v_est_min := GREATEST(1, CEIL((v_ahead * v_avg_sec) / 60)::INTEGER);
        v_wait_text := '약 ' || v_est_min || '분';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'id', v_rec.id,
        'queue_number', v_rec.queue_number,
        'formatted_number', v_rec.formatted_number,
        'status', v_rec.status,
        'desk_no', v_rec.desk_no,
        'ahead_count', v_ahead,
        'wait_time', jsonb_build_object(
            'code', v_wait_code,
            'text', v_wait_text,
            'minutes', v_est_min,
            'sampleCount', v_samples_count
        ),
        'updated_at', TIMEZONE('Asia/Seoul', NOW())
    );
END;
$$;

-- 11. 공개 호출판 데이터 조회 (get_queue_public_display)
-- - Zero PII: 번호, 창구, 상태만 반환 (성명/연락처 일체 미포함)
CREATE OR REPLACE FUNCTION public.get_queue_public_display(
    p_date DATE DEFAULT (TIMEZONE('Asia/Seoul', NOW()))::DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_called JSONB;
    v_waiting_count INTEGER;
BEGIN
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', id,
            'queue_number', queue_number,
            'formatted_number', formatted_number,
            'desk_no', desk_no,
            'status', status,
            'called_at', called_at
        ) ORDER BY called_at DESC NULLS LAST
    ), '[]'::jsonb)
    INTO v_called
    FROM public.ticket_queue
    WHERE queue_date = p_date AND status IN ('called', 'processing');

    SELECT COUNT(*) INTO v_waiting_count
    FROM public.ticket_queue
    WHERE queue_date = p_date AND status = 'waiting';

    RETURN jsonb_build_object(
        'ok', true,
        'date', p_date,
        'called_teams', v_called,
        'waiting_teams_count', v_waiting_count,
        'updated_at', TIMEZONE('Asia/Seoul', NOW())
    );
END;
$$;

-- 12. RLS 및 권한 설정
ALTER TABLE public.ticket_queue ENABLE ROW LEVEL SECURITY;

-- 익명 사용자(anon)는 개인정보를 포함한 ticket_queue 전체를 직접 SELECT 할 수 없도록 차단 (보안 강화)
DROP POLICY IF EXISTS "Deny direct anon select on ticket_queue" ON public.ticket_queue;
CREATE POLICY "Deny direct anon select on ticket_queue"
    ON public.ticket_queue FOR SELECT
    TO anon
    USING (false);

-- RPC 실행 권한 부여
GRANT EXECUTE ON FUNCTION public.enqueue_consent_team TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_queue_status TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_queue_public_display TO anon, authenticated;

-- 매표소 관리 RPC는 운영자(authenticated)에게만 허용
GRANT EXECUTE ON FUNCTION public.call_next_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.recall_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_queue_processing TO authenticated;
GRANT EXECUTE ON FUNCTION public.hold_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_queue_team TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_queue_issuance TO authenticated;
