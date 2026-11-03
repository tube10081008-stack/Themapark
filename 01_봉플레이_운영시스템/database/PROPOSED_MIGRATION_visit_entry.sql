-- ============================================================================
-- PROPOSED MIGRATION: visit_entry — 게이트 없는 발권·입장·반납 (BEN-ENTRY-01, 클로이)
-- 계약: database/CONTRACT_gateless_entry.md
--
-- 전제: FINAL_SUPABASE_SETUP.sql → PROPOSED_MIGRATION_safety_consents_cancellation.sql
--       → PROPOSED_MIGRATION_ticket_queue.sql 가 먼저 적용되어 있어야 한다.
-- 원칙:
--   · 기존 함수·원장 표(order_items, order_payments, ticket_ledger, ticket_queue 정의)는 바꾸지 않는다.
--     입장 확정은 원장을 "읽고 대사"만 한다. 대기열 행은 기존 발권 완료와 같은 issued 전환만 한다.
--   · 입장은 직원 인증 + 오늘 뒷번호 일치 + 안전점검 PASS + 결제·발권 원장 대사를 모두 통과해야 확정된다.
--   · 변경 RPC 는 시설 잠금(private.lock_ticket_queue_site) 안에서 행을 다시 읽고, request_id 로 멱등이다.
--   · 호출 알림은 별도 발송 원장이다. 기록 실패·발송 실패는 대기열 동작에 영향이 없다.
--   · 운영 DB 에 자동 적용하지 않는다. 벤 검토·관리자 승인 후 수동 반영한다.
-- 다시 실행해도 안전하다 (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS).
-- ============================================================================

-- ── 1. 표 ───────────────────────────────────────────────────────────────────

-- 1-1. 뒷번호 대조 기록 (일치·불일치 모두, 연속 불일치 잠금 판정용). 전화번호·입력값은 저장하지 않는다.
CREATE TABLE IF NOT EXISTS public.visit_identity_checks (
    id BIGSERIAL PRIMARY KEY,
    site_id TEXT NOT NULL,
    queue_id TEXT NOT NULL,
    business_date DATE NOT NULL,
    matched BOOLEAN NOT NULL,
    staff_id TEXT,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visit_identity_checks_queue ON public.visit_identity_checks (queue_id, checked_at DESC);

-- 1-2. 입장 원장 (팀 단위). 대기 1건·주문 1건당 최대 1행. 반납해도 지우지 않는다.
CREATE TABLE IF NOT EXISTS public.visit_entries (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    business_date DATE NOT NULL,
    queue_id TEXT NOT NULL,
    consent_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    ticket_count INTEGER NOT NULL CHECK (ticket_count > 0),
    status TEXT NOT NULL DEFAULT 'inside' CHECK (status IN ('inside', 'partial', 'exited')),
    entered_at TIMESTAMPTZ NOT NULL,
    exited_at TIMESTAMPTZ,
    entered_by TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_visit_entries_queue UNIQUE (queue_id),
    CONSTRAINT uq_visit_entries_site_order UNIQUE (site_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_visit_entries_site_date ON public.visit_entries (site_id, business_date, status);

-- 1-3. 입장 티켓 (팔찌 1개 = 티켓 1장 = 1명). 티켓은 평생 한 번만 입장한다 (재입장 불가).
CREATE TABLE IF NOT EXISTS public.visit_entry_tickets (
    ticket_id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES public.visit_entries(id),
    site_id TEXT NOT NULL,
    product_id TEXT,
    product_name TEXT,
    entered_at TIMESTAMPTZ NOT NULL,
    returned_at TIMESTAMPTZ,
    returned_by TEXT,
    return_request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_visit_entry_tickets_entry ON public.visit_entry_tickets (entry_id);

-- 1-4. 변경 요청 멱등 기록 (성공 응답만 저장)
CREATE TABLE IF NOT EXISTS public.visit_entry_requests (
    site_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    op TEXT NOT NULL,
    params JSONB NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (site_id, request_id)
);

-- 1-5. 호출 알림 발송 원장 (대기열과 분리)
CREATE TABLE IF NOT EXISTS public.queue_call_notifications (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    queue_id TEXT NOT NULL,
    business_date DATE NOT NULL,
    called_at TIMESTAMPTZ NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL DEFAULT 'alimtalk',
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'expired', 'suppressed')),
    suppress_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_attempt_at TIMESTAMPTZ,
    claim_token TEXT,
    lease_until TIMESTAMPTZ,
    provider_message_id TEXT,
    last_error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_queue_call_notifications_queue ON public.queue_call_notifications (queue_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_queue_call_notifications_work ON public.queue_call_notifications (status, next_attempt_at);

-- ── 2. 내부 헬퍼 (private, 실행 권한 회수) ─────────────────────────────────

CREATE OR REPLACE FUNCTION private.visit_today()
RETURNS DATE LANGUAGE sql STABLE AS $$ SELECT (NOW() AT TIME ZONE 'Asia/Seoul')::DATE $$;

-- 기존 인터록 트리거(private.trg_safety_interlock)와 같은 조건: 오늘(KST) decision='pass' 점검이 있는가
CREATE OR REPLACE FUNCTION private.visit_safety_pass()
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM public.safety_audits
                    WHERE audit_date = (NOW() AT TIME ZONE 'Asia/Seoul')::DATE AND decision = 'pass')
$$;

-- 전화번호 숫자 끝 4자리 (4자리 미만이면 null)
CREATE OR REPLACE FUNCTION private.visit_last4(p_phone TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN length(d) >= 4 THEN right(d, 4) END
      FROM (SELECT regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g') AS d) s
$$;

-- 정렬된 문자열 배열 (요청 비교용)
CREATE OR REPLACE FUNCTION private.visit_sorted_ids(p_ids JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(jsonb_agg(t ORDER BY t), '[]'::jsonb)
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_ids) = 'array' THEN p_ids ELSE '[]'::jsonb END) AS t
$$;

-- 같은 request_id 재전송 판정: null = 처음, 아니면 응답(재생 또는 REQUEST_ID_CONFLICT)
CREATE OR REPLACE FUNCTION private.visit_request_replay(p_site_id TEXT, p_request_id TEXT, p_op TEXT, p_params JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE r RECORD;
BEGIN
    SELECT * INTO r FROM public.visit_entry_requests WHERE site_id = p_site_id AND request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF r.op = p_op AND r.params = p_params THEN
        RETURN r.response || jsonb_build_object('replayed', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'REQUEST_ID_CONFLICT',
        'message', '같은 요청 번호가 다른 동작이나 다른 입력에 이미 쓰였습니다. 새 동작이면 새 요청 번호를 쓰세요.');
END;
$$;

-- 방문 미정산 주문 (반납 차단 근거, 읽기 전용).
-- 대상 주문: 이 방문 서약서에 연결된 주문 — order_items·order_payments 의 consent_id 가 서약서 id 이거나,
--   visit_id 가 서약서의 visit_id 또는 서약서 id (매점 POS 가 방문 연동 시 쓰는 값)인 주문.
-- 주문별 활성 품목 금액(paid_amount, 0 이면 total_price)과 유효 결제 합계(status='paid', 미취소)가 다르면 미정산이다.
--   balance > 0 : 받을 돈 (품목만 있고 결제가 없거나 모자람)
--   balance < 0 : 돌려줄 돈 (품목은 취소됐는데 결제가 남음)
-- 서버에 아직 올라오지 않은 단말 아웃박스 건은 보이지 않는다 (계약 E6 한계).
CREATE OR REPLACE FUNCTION private.visit_unsettled_orders(p_consent_id TEXT)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    WITH keys AS (
        SELECT DISTINCT k FROM (
            SELECT p_consent_id AS k
            UNION ALL
            SELECT c.visit_id FROM public.safety_consents c WHERE c.id = p_consent_id AND c.visit_id IS NOT NULL
        ) x WHERE k IS NOT NULL
    ), orders AS (
        SELECT order_id FROM public.order_items
         WHERE order_id IS NOT NULL AND (consent_id = p_consent_id OR visit_id IN (SELECT k FROM keys))
        UNION
        SELECT order_id FROM public.order_payments
         WHERE order_id IS NOT NULL AND (consent_id = p_consent_id OR visit_id IN (SELECT k FROM keys))
    ), sums AS (
        SELECT o.order_id,
               (SELECT COALESCE(SUM(CASE WHEN COALESCE(i.paid_amount, 0) > 0 THEN i.paid_amount ELSE COALESCE(i.total_price, 0) END), 0)
                  FROM public.order_items i
                 WHERE i.order_id = o.order_id AND COALESCE(i.status, 'paid') <> 'cancelled' AND i.cancelled_at IS NULL) AS item_total,
               (SELECT COALESCE(SUM(p.amount), 0)
                  FROM public.order_payments p
                 WHERE p.order_id = o.order_id AND p.status = 'paid' AND p.cancelled_at IS NULL) AS paid_total
          FROM orders o
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('order_id', order_id, 'item_total', item_total, 'paid_total', paid_total,
                                                  'balance', item_total - paid_total) ORDER BY order_id), '[]'::jsonb)
      FROM sums WHERE item_total <> paid_total
$$;

-- 입장 기록 1건의 직원용 표현 (전화번호 전체·실명·자녀·consent_id 없음)
CREATE OR REPLACE FUNCTION private.visit_entry_json(p_entry_id TEXT, p_today DATE)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
    SELECT jsonb_build_object(
        'entry_id', e.id,
        'queue_id', e.queue_id,
        'formatted_number', q.formatted_number,
        'guardian_masked', private.mask_name(q.guardian_name),
        'last4', private.visit_last4(q.guardian_phone),
        'business_date', e.business_date,
        'past_business_date', e.business_date < p_today,
        'entered_at', e.entered_at,
        'exited_at', e.exited_at,
        'status', e.status,
        'ticket_count', e.ticket_count,
        'inside_count', (SELECT COUNT(*) FROM public.visit_entry_tickets t WHERE t.entry_id = e.id AND t.returned_at IS NULL),
        'returned_count', (SELECT COUNT(*) FROM public.visit_entry_tickets t WHERE t.entry_id = e.id AND t.returned_at IS NOT NULL),
        'tickets', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                        'ticket_id', t.ticket_id, 'product_name', t.product_name,
                        'returned', t.returned_at IS NOT NULL, 'returned_at', t.returned_at) ORDER BY t.ticket_id), '[]'::jsonb)
                      FROM public.visit_entry_tickets t WHERE t.entry_id = e.id),
        'settlement', (SELECT jsonb_build_object('settled', jsonb_array_length(u.v) = 0, 'unsettled_orders', u.v)
                         FROM (SELECT private.visit_unsettled_orders(e.consent_id) AS v) u)
    )
    FROM public.visit_entries e
    LEFT JOIN public.ticket_queue q ON q.id = e.queue_id
    WHERE e.id = p_entry_id
$$;

-- 결제·발권 원장 대사 (complete_queue_issuance 7~12단계와 같은 규칙·같은 오류 코드). 통과면 null.
CREATE OR REPLACE FUNCTION private.visit_reconcile_order(p_consent_id TEXT, p_order_id TEXT, p_ticket_ids JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
    v_tickets_count INTEGER := jsonb_array_length(p_ticket_ids);
    v_item_count INTEGER; v_item_foreign INTEGER; v_order_qty INTEGER; v_order_total BIGINT;
    v_matched INTEGER; v_ledger_active INTEGER; v_paid_total BIGINT;
BEGIN
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE consent_id IS DISTINCT FROM p_consent_id),
           COALESCE(SUM(quantity) FILTER (WHERE product_category = 'ticket'), 0),
           COALESCE(SUM(CASE WHEN COALESCE(paid_amount, 0) > 0 THEN paid_amount ELSE COALESCE(total_price, 0) END), 0)
      INTO v_item_count, v_item_foreign, v_order_qty, v_order_total
      FROM public.order_items
     WHERE order_id = p_order_id AND COALESCE(status, 'paid') <> 'cancelled' AND cancelled_at IS NULL;

    IF v_item_count = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_ITEMS_EMPTY', 'message', '주문 품목 원장이 없거나 모두 취소되었습니다.');
    END IF;
    IF v_item_foreign > 0 OR EXISTS (SELECT 1 FROM public.order_payments
                                      WHERE order_id = p_order_id AND consent_id IS DISTINCT FROM p_consent_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_CONSENT_MISMATCH', 'message', '주문 품목·결제가 이 팀의 서약서에 연결되어 있지 않습니다.');
    END IF;
    IF v_order_qty <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_TICKET_ITEMS_EMPTY', 'message', '주문에 입장권 품목이 없습니다. (매점 단독 주문은 입장 기록을 만들지 않습니다)');
    END IF;
    IF v_tickets_count <> v_order_qty THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TICKET_QUANTITY_MISMATCH',
            'message', '요청 티켓 수(' || v_tickets_count || ')가 주문 입장권 수량(' || v_order_qty || ')과 다릅니다.');
    END IF;

    SELECT COUNT(*) INTO v_matched FROM public.ticket_ledger
     WHERE ticket_id IN (SELECT jsonb_array_elements_text(p_ticket_ids))
       AND order_id = p_order_id AND consent_id = p_consent_id
       AND cancelled_at IS NULL AND COALESCE(status, 'active') <> 'cancelled';
    SELECT COUNT(*) INTO v_ledger_active FROM public.ticket_ledger
     WHERE order_id = p_order_id AND cancelled_at IS NULL AND COALESCE(status, 'active') <> 'cancelled';
    IF v_matched <> v_tickets_count OR v_ledger_active <> v_order_qty THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TICKET_LEDGER_INCOMPLETE',
            'message', '티켓 원장이 주문과 일치하지 않습니다. (요청 일치: ' || v_matched || '/' || v_tickets_count
                       || ', 주문 활성 티켓: ' || v_ledger_active || '/' || v_order_qty || ')');
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_paid_total FROM public.order_payments
     WHERE order_id = p_order_id AND consent_id = p_consent_id AND status = 'paid' AND cancelled_at IS NULL;
    IF v_order_total > 0 AND v_paid_total <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAYMENT_NOT_CONFIRMED', 'message', '결제가 확정되지 않았거나 유효한 결제 내역이 없습니다.');
    END IF;
    IF v_paid_total < v_order_total THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PARTIAL_PAYMENT_REJECTED',
            'message', '결제 수납 금액(' || v_paid_total || '원)이 주문 금액(' || v_order_total || '원)에 미달합니다.');
    END IF;
    RETURN NULL;
END;
$$;

-- ── 3. 직원 RPC ─────────────────────────────────────────────────────────────

-- E2. 뒷번호 대조
CREATE OR REPLACE FUNCTION public.verify_visit_guardian_last4(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_last4 TEXT,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := private.visit_today();
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_expected TEXT;
    v_last_match TIMESTAMPTZ;
    v_fails INTEGER;
    v_last_fail TIMESTAMPTZ;
BEGIN
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;
    IF p_last4 IS NULL OR p_last4 !~ '^[0-9]{4}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'LAST4_FORMAT', 'message', '전화번호 뒤 4자리 숫자를 입력해 주세요.');
    END IF;

    PERFORM private.lock_ticket_queue_site(p_site_id);
    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id AND site_id = p_site_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;
    IF v_rec.queue_date < v_today THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAST_QUEUE_DATE', 'queue_date', v_rec.queue_date,
            'message', '지난 영업일의 대기표입니다. 오늘 새로 접수해 주세요.');
    END IF;
    IF v_rec.status NOT IN ('called', 'processing') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS', 'status', v_rec.status,
            'message', '호출되었거나 처리 중인 팀만 확인할 수 있습니다.');
    END IF;
    v_expected := private.visit_last4(v_rec.guardian_phone);
    IF v_expected IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'LAST4_UNAVAILABLE', 'message', '대기 정보에 확인할 전화번호가 없습니다. 현장에서 서약서를 확인해 주세요.');
    END IF;

    -- 잠금 판정: 마지막 일치 이후 + 최근 10분 안의 불일치 수
    SELECT MAX(checked_at) INTO v_last_match FROM public.visit_identity_checks
     WHERE queue_id = p_queue_id AND business_date = v_today AND matched;
    SELECT COUNT(*), MAX(checked_at) INTO v_fails, v_last_fail FROM public.visit_identity_checks
     WHERE queue_id = p_queue_id AND business_date = v_today AND NOT matched
       AND checked_at > GREATEST(COALESCE(v_last_match, '-infinity'::timestamptz), v_now - INTERVAL '10 minutes');
    IF v_fails >= 5 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'LAST4_LOCKED', 'locked_until', v_last_fail + INTERVAL '10 minutes',
            'message', '연속 5회 불일치로 10분간 확인이 잠겼습니다. 보호자 서약서를 직접 확인해 주세요.');
    END IF;

    INSERT INTO public.visit_identity_checks (site_id, queue_id, business_date, matched, staff_id, checked_at)
    VALUES (p_site_id, p_queue_id, v_today, p_last4 = v_expected, p_staff_id, v_now);

    IF p_last4 = v_expected THEN
        RETURN jsonb_build_object('ok', true, 'matched', true, 'queue_id', p_queue_id, 'verified_at', v_now);
    END IF;
    RETURN jsonb_build_object('ok', true, 'matched', false, 'queue_id', p_queue_id, 'attempts_left', GREATEST(0, 4 - v_fails));
END;
$$;

-- E3. 발권 확정 = 입장 기록
CREATE OR REPLACE FUNCTION public.confirm_visit_entry(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_order_id TEXT,
    p_ticket_ids JSONB,
    p_request_id TEXT,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := private.visit_today();
    v_now TIMESTAMPTZ := NOW();
    v_rec RECORD;
    v_entry RECORD;
    v_consent JSONB;
    v_params JSONB;
    v_replay JSONB;
    v_err JSONB;
    v_count INTEGER;
    v_duration INTEGER := 60;
    v_entry_id TEXT;
    v_resp JSONB;
BEGIN
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;
    IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 8 AND 64 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'REQUEST_ID_REQUIRED', 'message', '요청 번호(request_id, 8~64자)가 필요합니다.');
    END IF;
    IF p_order_id IS NULL OR trim(p_order_id) = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'ORDER_ID_REQUIRED', 'message', '유효한 주문번호가 필요합니다.');
    END IF;
    IF p_ticket_ids IS NULL OR jsonb_typeof(p_ticket_ids) <> 'array' OR jsonb_array_length(p_ticket_ids) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TICKETS_REQUIRED', 'message', '발권된 팔찌 티켓 목록이 필요합니다.');
    END IF;
    v_count := jsonb_array_length(p_ticket_ids);
    IF (SELECT COUNT(DISTINCT t) FROM jsonb_array_elements_text(p_ticket_ids) t) <> v_count THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_TICKET_IDS', 'message', '요청 티켓 목록에 중복이 있습니다.');
    END IF;

    PERFORM private.lock_ticket_queue_site(p_site_id);

    v_params := jsonb_build_object('queue_id', p_queue_id, 'order_id', p_order_id, 'ticket_ids', private.visit_sorted_ids(p_ticket_ids));
    v_replay := private.visit_request_replay(p_site_id, p_request_id, 'confirm_visit_entry', v_params);
    IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

    SELECT * INTO v_rec FROM public.ticket_queue WHERE id = p_queue_id AND site_id = p_site_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '대기 정보를 찾을 수 없습니다.');
    END IF;
    IF v_rec.queue_date < v_today THEN
        RETURN jsonb_build_object('ok', false, 'error', 'PAST_QUEUE_DATE', 'queue_date', v_rec.queue_date,
            'message', '지난 영업일의 대기표로는 입장을 기록할 수 없습니다.');
    END IF;

    -- 이미 입장 기록이 있는 팀: 같은 주문·같은 티켓이면 같은 결과 (다른 단말·다른 request_id 재처리)
    SELECT * INTO v_entry FROM public.visit_entries WHERE queue_id = p_queue_id;
    IF FOUND THEN
        IF v_entry.order_id = p_order_id AND
           (SELECT private.visit_sorted_ids(COALESCE(jsonb_agg(ticket_id), '[]'::jsonb)) FROM public.visit_entry_tickets WHERE entry_id = v_entry.id)
             = private.visit_sorted_ids(p_ticket_ids) THEN
            RETURN private.visit_entry_json(v_entry.id, v_today) - 'tickets' - 'guardian_masked' - 'last4' - 'formatted_number'
                   || jsonb_build_object('ok', true, 'order_id', v_entry.order_id, 'already_entered', true, 'replayed', false);
        END IF;
        RETURN jsonb_build_object('ok', false, 'error', 'ENTRY_EXISTS_OTHER_ORDER', 'entry_id', v_entry.id,
            'message', '이 팀은 다른 주문·티켓으로 이미 입장 기록이 있습니다.');
    END IF;

    IF v_rec.status = 'issued' THEN
        IF v_rec.order_id IS DISTINCT FROM p_order_id THEN
            RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_ISSUED_OTHER_ORDER', 'message', '이미 다른 주문번호로 발권 완료된 대기표입니다.');
        END IF;
        -- 호환: 구 경로(complete_queue_issuance)로 발권 완료된 팀의 입장 기록
    ELSIF v_rec.status <> 'processing' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_STATUS', 'status', v_rec.status,
            'message', '처리 중(processing) 상태인 팀만 입장을 확정할 수 있습니다.');
    END IF;

    SELECT to_jsonb(c) - 'signature_data' - 'children' INTO v_consent FROM public.safety_consents c WHERE c.id = v_rec.consent_id;
    IF v_consent IS NULL OR COALESCE(v_consent->>'site_id', p_site_id) <> p_site_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CONSENT_INVALID', 'message', '유효한 서약서 원장이 확인되지 않습니다.');
    END IF;
    IF COALESCE(v_consent->>'status', 'active') = 'cancelled' OR (v_consent->>'cancelled_at') IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'CONSENT_CANCELLED', 'message', '취소된 서약서입니다.');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.visit_identity_checks
                    WHERE queue_id = p_queue_id AND business_date = v_today AND matched) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'LAST4_NOT_VERIFIED', 'message', '보호자 전화번호 뒤 4자리를 먼저 확인해 주세요.');
    END IF;

    IF NOT private.visit_safety_pass() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'SAFETY_INTERLOCK_BLOCKED',
            'message', '금일 안전점검 PASS 승인 전에는 입장을 확정할 수 없습니다.');
    END IF;

    v_err := private.visit_reconcile_order(v_rec.consent_id, p_order_id, p_ticket_ids);
    IF v_err IS NOT NULL THEN RETURN v_err; END IF;

    IF EXISTS (SELECT 1 FROM public.visit_entry_tickets WHERE ticket_id IN (SELECT jsonb_array_elements_text(p_ticket_ids))) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'TICKET_ALREADY_ENTERED', 'message', '이미 입장 기록에 쓰인 티켓이 있습니다.');
    END IF;

    -- 쓰기 (한 트랜잭션)
    IF v_rec.status = 'processing' THEN
        IF v_rec.processing_started_at IS NOT NULL THEN
            v_duration := GREATEST(10, EXTRACT(EPOCH FROM (v_now - v_rec.processing_started_at))::INTEGER);
        ELSIF v_rec.called_at IS NOT NULL THEN
            v_duration := GREATEST(10, EXTRACT(EPOCH FROM (v_now - v_rec.called_at))::INTEGER);
        END IF;
        UPDATE public.ticket_queue
           SET status = 'issued', issued_at = v_now, order_id = p_order_id, ticket_ids = p_ticket_ids,
               duration_seconds = v_duration, version = version + 1, updated_at = v_now
         WHERE id = p_queue_id;
        PERFORM private.ticket_queue_sync_pointer(p_site_id, p_queue_id, NULL, v_now);
    END IF;

    v_entry_id := 've_' || encode(extensions.gen_random_bytes(12), 'hex');
    INSERT INTO public.visit_entries (id, site_id, business_date, queue_id, consent_id, order_id, ticket_count,
                                      status, entered_at, entered_by, created_at, updated_at)
    VALUES (v_entry_id, p_site_id, v_today, p_queue_id, v_rec.consent_id, p_order_id, v_count,
            'inside', v_now, p_staff_id, v_now, v_now);
    INSERT INTO public.visit_entry_tickets (ticket_id, entry_id, site_id, product_id, product_name, entered_at)
    SELECT l.ticket_id, v_entry_id, p_site_id, l.product_id, l.product_name, v_now
      FROM public.ticket_ledger l
     WHERE l.ticket_id IN (SELECT jsonb_array_elements_text(p_ticket_ids));

    -- 호환 거울: 오늘 접수 서약서의 빈 entry_at 만 채운다 (기존 값 보존)
    UPDATE public.safety_consents SET entry_at = v_now, updated_at = v_now
     WHERE id = v_rec.consent_id AND entry_at IS NULL AND created_date = v_today;

    v_resp := jsonb_build_object('ok', true, 'entry_id', v_entry_id, 'queue_id', p_queue_id, 'order_id', p_order_id,
        'business_date', v_today, 'entered_at', v_now, 'ticket_count', v_count, 'inside_count', v_count,
        'returned_count', 0, 'status', 'inside', 'already_entered', false, 'replayed', false);
    INSERT INTO public.visit_entry_requests (site_id, request_id, op, params, response)
    VALUES (p_site_id, p_request_id, 'confirm_visit_entry', v_params, v_resp);
    RETURN v_resp;
END;
$$;

-- E4. 체류 중 팀 검색
CREATE OR REPLACE FUNCTION public.search_visit_entries(
    p_access_code TEXT,
    p_last4 TEXT DEFAULT NULL,
    p_include_exited BOOLEAN DEFAULT false,
    p_include_past_unreturned BOOLEAN DEFAULT false,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := private.visit_today();
BEGIN
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;
    IF p_last4 IS NOT NULL AND p_last4 !~ '^[0-9]{4}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'LAST4_FORMAT', 'message', '전화번호 뒤 4자리 숫자를 입력해 주세요.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'business_date', v_today, 'entries', COALESCE((
        SELECT jsonb_agg(private.visit_entry_json(x.id, v_today) ORDER BY x.entered_at DESC, x.id)
          FROM (
            SELECT e.id, e.entered_at
              FROM public.visit_entries e
              LEFT JOIN public.ticket_queue q ON q.id = e.queue_id
             WHERE e.site_id = p_site_id
               AND (p_last4 IS NULL OR private.visit_last4(q.guardian_phone) = p_last4)
               AND (
                    (e.business_date = v_today AND (e.status IN ('inside', 'partial') OR (p_include_exited AND e.status = 'exited')))
                 OR (p_include_past_unreturned AND e.business_date < v_today AND e.status IN ('inside', 'partial'))
               )
             ORDER BY e.entered_at DESC, e.id
             LIMIT 50
          ) x), '[]'::jsonb));
END;
$$;

-- E5. 입장 기록 단건
CREATE OR REPLACE FUNCTION public.get_visit_entry(
    p_access_code TEXT,
    p_entry_id TEXT,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.visit_entries WHERE id = p_entry_id AND site_id = p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '입장 기록을 찾을 수 없습니다.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'entry', private.visit_entry_json(p_entry_id, private.visit_today()));
END;
$$;

-- E6. 팔찌 반납 = 부분·전체 퇴장
CREATE OR REPLACE FUNCTION public.return_visit_wristbands(
    p_access_code TEXT,
    p_entry_id TEXT,
    p_ticket_ids JSONB DEFAULT NULL,
    p_return_all BOOLEAN DEFAULT false,
    p_request_id TEXT DEFAULT NULL,
    p_staff_id TEXT DEFAULT 'desk_staff',
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_today DATE := private.visit_today();
    v_now TIMESTAMPTZ := NOW();
    v_entry RECORD;
    v_has_list BOOLEAN := p_ticket_ids IS NOT NULL AND jsonb_typeof(p_ticket_ids) = 'array' AND jsonb_array_length(p_ticket_ids) > 0;
    v_all BOOLEAN := COALESCE(p_return_all, false);
    v_params JSONB;
    v_replay JSONB;
    v_targets TEXT[];
    v_bad JSONB;
    v_inside INTEGER;
    v_returned INTEGER;
    v_status TEXT;
    v_resp JSONB;
    v_unsettled JSONB;
BEGIN
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;
    IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 8 AND 64 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'REQUEST_ID_REQUIRED', 'message', '요청 번호(request_id, 8~64자)가 필요합니다.');
    END IF;
    IF NOT v_has_list AND NOT v_all THEN
        RETURN jsonb_build_object('ok', false, 'error', 'RETURN_TARGET_REQUIRED', 'message', '반납할 티켓 목록 또는 전체 반납을 지정해 주세요.');
    END IF;
    IF v_has_list AND v_all THEN
        RETURN jsonb_build_object('ok', false, 'error', 'RETURN_TARGET_AMBIGUOUS', 'message', '티켓 목록과 전체 반납을 함께 지정할 수 없습니다.');
    END IF;
    IF v_has_list AND (SELECT COUNT(DISTINCT t) FROM jsonb_array_elements_text(p_ticket_ids) t) <> jsonb_array_length(p_ticket_ids) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_TICKET_IDS', 'message', '반납 티켓 목록에 중복이 있습니다.');
    END IF;

    PERFORM private.lock_ticket_queue_site(p_site_id);

    v_params := jsonb_build_object('entry_id', p_entry_id, 'return_all', v_all,
                                   'ticket_ids', CASE WHEN v_has_list THEN private.visit_sorted_ids(p_ticket_ids) ELSE '[]'::jsonb END);
    v_replay := private.visit_request_replay(p_site_id, p_request_id, 'return_visit_wristbands', v_params);
    IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

    SELECT * INTO v_entry FROM public.visit_entries WHERE id = p_entry_id AND site_id = p_site_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', '입장 기록을 찾을 수 없습니다.');
    END IF;

    IF v_has_list THEN
        SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_bad
          FROM jsonb_array_elements_text(p_ticket_ids) t
         WHERE NOT EXISTS (SELECT 1 FROM public.visit_entry_tickets x WHERE x.ticket_id = t AND x.entry_id = p_entry_id);
        IF jsonb_array_length(v_bad) > 0 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'TICKET_NOT_IN_ENTRY', 'ticket_ids', v_bad,
                'message', '이 입장 기록에 없는 티켓이 있습니다.');
        END IF;
        SELECT COALESCE(jsonb_agg(ticket_id ORDER BY ticket_id), '[]'::jsonb) INTO v_bad
          FROM public.visit_entry_tickets
         WHERE entry_id = p_entry_id AND returned_at IS NOT NULL
           AND ticket_id IN (SELECT jsonb_array_elements_text(p_ticket_ids));
        IF jsonb_array_length(v_bad) > 0 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'TICKET_ALREADY_RETURNED', 'already_returned', v_bad,
                'entry', private.visit_entry_json(p_entry_id, v_today),
                'message', '이미 반납된 팔찌가 있어 아무것도 반영하지 않았습니다. 목록을 새로 확인해 주세요.');
        END IF;
        SELECT array_agg(t ORDER BY t) INTO v_targets FROM jsonb_array_elements_text(p_ticket_ids) t;
    ELSE
        SELECT array_agg(ticket_id ORDER BY ticket_id) INTO v_targets
          FROM public.visit_entry_tickets WHERE entry_id = p_entry_id AND returned_at IS NULL;
    END IF;

    IF v_targets IS NOT NULL AND array_length(v_targets, 1) IS NOT NULL THEN
        -- 미정산 차단: 이 방문에 연결된 주문의 품목 금액과 유효 결제가 다르면 반납을 반영하지 않는다
        --   (같은 트랜잭션·시설 잠금 안에서 원장을 다시 읽는다. 화면 검사 결과는 근거로 쓰지 않는다)
        v_unsettled := private.visit_unsettled_orders(v_entry.consent_id);
        IF jsonb_array_length(v_unsettled) > 0 THEN
            RETURN jsonb_build_object('ok', false, 'error', 'UNSETTLED_ORDERS', 'entry_id', p_entry_id,
                'unsettled_orders', v_unsettled,
                'message', '이 방문에 정산되지 않은 주문이 있어 반납을 반영하지 않았습니다. 결제(또는 환불)를 원장에 기록한 뒤 다시 시도해 주세요.');
        END IF;
    END IF;

    IF v_targets IS NULL OR array_length(v_targets, 1) IS NULL THEN
        -- 전체 반납인데 남은 팔찌가 없음: 아무것도 바꾸지 않는다
        RETURN jsonb_build_object('ok', true, 'entry_id', p_entry_id, 'returned_now', '[]'::jsonb,
            'ticket_count', v_entry.ticket_count, 'inside_count', 0, 'returned_count', v_entry.ticket_count,
            'status', v_entry.status, 'exited_at', v_entry.exited_at,
            'past_business_date', v_entry.business_date < v_today, 'already_exited', true, 'replayed', false);
    END IF;

    UPDATE public.visit_entry_tickets
       SET returned_at = v_now, returned_by = p_staff_id, return_request_id = p_request_id
     WHERE entry_id = p_entry_id AND ticket_id = ANY (v_targets) AND returned_at IS NULL;

    SELECT COUNT(*) FILTER (WHERE returned_at IS NULL), COUNT(*) FILTER (WHERE returned_at IS NOT NULL)
      INTO v_inside, v_returned FROM public.visit_entry_tickets WHERE entry_id = p_entry_id;
    v_status := CASE WHEN v_inside = 0 THEN 'exited' ELSE 'partial' END;
    UPDATE public.visit_entries
       SET status = v_status, exited_at = CASE WHEN v_inside = 0 THEN v_now ELSE NULL END,
           version = version + 1, updated_at = v_now
     WHERE id = p_entry_id;

    IF v_inside = 0 THEN
        -- 호환 거울: 오늘 접수 서약서의 빈 exit_at 만 채운다
        UPDATE public.safety_consents
           SET exit_at = v_now,
               stay_duration_minutes = GREATEST(0, round(EXTRACT(EPOCH FROM (v_now - v_entry.entered_at)) / 60)::INTEGER),
               updated_at = v_now
         WHERE id = v_entry.consent_id AND exit_at IS NULL AND created_date = v_today;
    END IF;

    v_resp := jsonb_build_object('ok', true, 'entry_id', p_entry_id, 'returned_now', to_jsonb(v_targets),
        'ticket_count', v_entry.ticket_count, 'inside_count', v_inside, 'returned_count', v_returned,
        'status', v_status, 'exited_at', CASE WHEN v_inside = 0 THEN v_now END,
        'past_business_date', v_entry.business_date < v_today, 'already_exited', false, 'replayed', false);
    INSERT INTO public.visit_entry_requests (site_id, request_id, op, params, response)
    VALUES (p_site_id, p_request_id, 'return_visit_wristbands', v_params, v_resp);
    RETURN v_resp;
END;
$$;

-- E7. 인원 집계 (읽기 전용)
CREATE OR REPLACE FUNCTION public.get_visit_occupancy(
    p_access_code TEXT,
    p_business_date DATE DEFAULT NULL,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_date DATE := COALESCE(p_business_date, private.visit_today());
    v_res JSONB;
BEGIN
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;
    SELECT jsonb_build_object(
        'ok', true,
        'business_date', v_date,
        'entered_teams', (SELECT COUNT(*) FROM public.visit_entries e WHERE e.site_id = p_site_id AND e.business_date = v_date),
        'partial_teams', (SELECT COUNT(*) FROM public.visit_entries e WHERE e.site_id = p_site_id AND e.business_date = v_date AND e.status = 'partial'),
        'cumulative_visitors', COUNT(t.ticket_id),
        'exited_visitors', COUNT(t.ticket_id) FILTER (WHERE t.returned_at IS NOT NULL),
        'current_inside', COUNT(t.ticket_id) FILTER (WHERE t.returned_at IS NULL),
        'refunded_after_entry_visitors', COUNT(t.ticket_id) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.ticket_ledger l WHERE l.ticket_id = t.ticket_id
               AND (l.cancelled_at IS NOT NULL OR COALESCE(l.status, 'active') = 'cancelled'))),
        'past_unreturned_visitors', (SELECT COUNT(*) FROM public.visit_entry_tickets pt
                                       JOIN public.visit_entries pe ON pe.id = pt.entry_id
                                      WHERE pe.site_id = p_site_id AND pe.business_date < v_date AND pt.returned_at IS NULL)
    ) INTO v_res
    FROM public.visit_entries e
    JOIN public.visit_entry_tickets t ON t.entry_id = e.id
    WHERE e.site_id = p_site_id AND e.business_date = v_date;
    RETURN v_res;
END;
$$;

-- ── 4. 호출 알림 발송 원장 ───────────────────────────────────────────────────

-- 호출·재호출(called_at 변경) 시 1건. 기록 실패는 경고만 남기고 대기열 변경을 막지 않는다.
CREATE OR REPLACE FUNCTION private.trg_queue_call_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_reason TEXT := NULL;
BEGIN
    IF NEW.status = 'called' AND NEW.called_at IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.called_at IS DISTINCT FROM OLD.called_at) THEN
        BEGIN
            IF EXISTS (SELECT 1 FROM public.queue_call_notifications
                        WHERE queue_id = NEW.id AND created_at > NOW() - INTERVAL '60 seconds') THEN
                v_reason := 'cooldown_60s';
            ELSIF (SELECT COUNT(*) FROM public.queue_call_notifications
                    WHERE queue_id = NEW.id AND business_date = NEW.queue_date AND status <> 'suppressed') >= 3 THEN
                v_reason := 'daily_cap_3';
            END IF;
            INSERT INTO public.queue_call_notifications (id, site_id, queue_id, business_date, called_at, dedupe_key,
                                                         status, suppress_reason)
            VALUES ('qn_' || encode(extensions.gen_random_bytes(12), 'hex'), NEW.site_id, NEW.id, NEW.queue_date,
                    NEW.called_at, NEW.id || ':' || (EXTRACT(EPOCH FROM NEW.called_at) * 1000000)::BIGINT,
                    CASE WHEN v_reason IS NULL THEN 'pending' ELSE 'suppressed' END, v_reason)
            ON CONFLICT (dedupe_key) DO NOTHING;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'queue_call_notifications 기록 실패 (호출은 유지): %', SQLERRM;
        END;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_call_notification ON public.ticket_queue;
CREATE TRIGGER trg_queue_call_notification
    AFTER INSERT OR UPDATE OF called_at, status ON public.ticket_queue
    FOR EACH ROW EXECUTE FUNCTION private.trg_queue_call_notification();

-- 작업자(service_role 전용): 발송할 건 수령. 임대가 끝난 sending 은 다시 보내지 않고 unknown 으로 둔다 (중복 발송 방지)
CREATE OR REPLACE FUNCTION public.claim_queue_call_notifications(
    p_limit INTEGER DEFAULT 10,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    r RECORD;
    v_items JSONB := '[]'::jsonb;
    v_token TEXT;
BEGIN
    UPDATE public.queue_call_notifications
       SET status = 'unknown', last_error = 'lease_expired_without_report', updated_at = v_now
     WHERE status = 'sending' AND lease_until < v_now;

    FOR r IN
        SELECT n.*, q.status AS q_status, q.called_at AS q_called_at, q.guardian_phone, q.formatted_number, q.desk_no
          FROM public.queue_call_notifications n
          LEFT JOIN public.ticket_queue q ON q.id = n.queue_id
         WHERE n.status = 'pending' AND (n.next_attempt_at IS NULL OR n.next_attempt_at <= v_now)
         ORDER BY n.created_at
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 50))
         FOR UPDATE OF n SKIP LOCKED
    LOOP
        -- 발송하지 않음(expired): 팀이 더 이상 호출 상태가 아님 / 호출 뒤 15분 경과 /
        -- 같은 팀에 더 새로운 발송 대상 알림이 있음 (재호출 알림이 대신 나간다 — 한 호출에 한 번만)
        IF r.q_status IS DISTINCT FROM 'called'
           OR v_now - r.called_at > INTERVAL '15 minutes'
           OR EXISTS (SELECT 1 FROM public.queue_call_notifications x
                       WHERE x.queue_id = r.queue_id AND x.id <> r.id AND x.status <> 'suppressed'
                         AND x.created_at > r.created_at) THEN
            UPDATE public.queue_call_notifications SET status = 'expired', updated_at = v_now WHERE id = r.id;
            CONTINUE;
        END IF;
        v_token := encode(extensions.gen_random_bytes(16), 'hex');
        UPDATE public.queue_call_notifications
           SET status = 'sending', attempts = attempts + 1, claim_token = v_token,
               lease_until = v_now + make_interval(secs => GREATEST(30, LEAST(COALESCE(p_lease_seconds, 120), 600))),
               updated_at = v_now
         WHERE id = r.id;
        v_items := v_items || jsonb_build_object('notification_id', r.id, 'claim_token', v_token, 'queue_id', r.queue_id,
            'formatted_number', r.formatted_number, 'desk_no', r.desk_no, 'recipient_phone', r.guardian_phone,
            'attempt', r.attempts + 1);
    END LOOP;
    RETURN jsonb_build_object('ok', true, 'items', v_items);
END;
$$;

-- 작업자(service_role 전용): 발송 결과 보고. 같은 수령 건 재보고는 상태 변화 없음.
CREATE OR REPLACE FUNCTION public.report_queue_call_notification(
    p_notification_id TEXT,
    p_claim_token TEXT,
    p_result TEXT,
    p_provider_message_id TEXT DEFAULT NULL,
    p_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_now TIMESTAMPTZ := NOW();
    n RECORD;
    v_status TEXT;
BEGIN
    IF p_result NOT IN ('sent', 'retryable', 'failed', 'unknown') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVALID_RESULT', 'message', 'p_result 는 sent/retryable/failed/unknown 중 하나여야 합니다.');
    END IF;
    SELECT * INTO n FROM public.queue_call_notifications WHERE id = p_notification_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;
    IF n.claim_token IS DISTINCT FROM p_claim_token THEN
        RETURN jsonb_build_object('ok', false, 'error', 'STALE_CLAIM', 'status', n.status);
    END IF;
    IF n.status <> 'sending' THEN
        RETURN jsonb_build_object('ok', true, 'duplicate', true, 'status', n.status);
    END IF;
    v_status := CASE
        WHEN p_result = 'sent' THEN 'sent'
        WHEN p_result = 'unknown' THEN 'unknown'
        WHEN p_result = 'failed' OR n.attempts >= n.max_attempts THEN 'failed'
        ELSE 'pending' END;
    UPDATE public.queue_call_notifications
       SET status = v_status,
           provider_message_id = COALESCE(p_provider_message_id, provider_message_id),
           last_error = CASE WHEN p_result = 'sent' THEN NULL ELSE left(p_error, 200) END,
           sent_at = CASE WHEN p_result = 'sent' THEN v_now ELSE sent_at END,
           next_attempt_at = CASE WHEN v_status = 'pending' THEN v_now + make_interval(secs => 30 * n.attempts) END,
           lease_until = NULL, updated_at = v_now
     WHERE id = p_notification_id;
    RETURN jsonb_build_object('ok', true, 'duplicate', false, 'status', v_status);
END;
$$;

-- 직원: 팀의 알림 상태 (보조 표시용)
CREATE OR REPLACE FUNCTION public.get_queue_call_notifications(
    p_access_code TEXT,
    p_queue_id TEXT,
    p_site_id TEXT DEFAULT 'bongplay_bonghwa'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NOT private.verify_staff_permission(p_access_code, p_site_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHORIZED_STAFF', 'message', '직원 인증에 실패했거나 시설 권한이 없습니다.');
    END IF;
    RETURN jsonb_build_object('ok', true, 'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('notification_id', id, 'called_at', called_at, 'status', status,
                   'suppress_reason', suppress_reason, 'attempts', attempts, 'updated_at', updated_at,
                   'last_error_code', CASE WHEN last_error IS NULL THEN NULL ELSE left(last_error, 40) END)
                 ORDER BY created_at)
          FROM public.queue_call_notifications WHERE queue_id = p_queue_id AND site_id = p_site_id), '[]'::jsonb));
END;
$$;

-- ── 5. 인터록·권한 ──────────────────────────────────────────────────────────

-- 입장 원장 직접 INSERT 도 기존 안전점검 인터록을 따른다 (RPC 는 이미 검사함 — 이중 장치). 반납(UPDATE)은 막지 않는다.
DROP TRIGGER IF EXISTS trg_safety_interlock ON public.visit_entries;
CREATE TRIGGER trg_safety_interlock
    BEFORE INSERT ON public.visit_entries
    FOR EACH ROW EXECUTE FUNCTION private.trg_safety_interlock();

ALTER TABLE public.visit_identity_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visit_entry_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visit_entry_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_call_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.visit_identity_checks, public.visit_entries, public.visit_entry_tickets,
    public.visit_entry_requests, public.queue_call_notifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.visit_identity_checks_id_seq FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION private.visit_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.visit_safety_pass() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.visit_last4(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.visit_sorted_ids(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.visit_request_replay(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.visit_entry_json(TEXT, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.visit_reconcile_order(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.visit_unsettled_orders(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.trg_queue_call_notification() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.verify_visit_guardian_last4(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_visit_entry(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_visit_entries(TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_visit_entry(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.return_visit_wristbands(TEXT, TEXT, JSONB, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_visit_occupancy(TEXT, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_queue_call_notifications(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_queue_call_notifications(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_queue_call_notification(TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- 직원 RPC: 공용 anon 키 경로 + 함수 안 운영 암호 검증 (기존 대기열 직원 RPC 와 같은 방식)
GRANT EXECUTE ON FUNCTION public.verify_visit_guardian_last4(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_visit_entry(TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_visit_entries(TEXT, TEXT, BOOLEAN, BOOLEAN, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_visit_entry(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.return_visit_wristbands(TEXT, TEXT, JSONB, BOOLEAN, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_visit_occupancy(TEXT, DATE, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_queue_call_notifications(TEXT, TEXT, TEXT) TO anon, authenticated;
-- 발송 작업자 RPC: service_role 만 (수신 전화번호를 돌려주므로 anon 불가)
GRANT EXECUTE ON FUNCTION public.claim_queue_call_notifications(INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_queue_call_notification(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
