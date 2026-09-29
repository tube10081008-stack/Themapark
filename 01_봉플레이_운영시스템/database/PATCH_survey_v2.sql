-- ============================================================
-- 봉플레이 방문 후기 설문 v2 (정성 설문 · 선물 연계) 컬럼 추가 (2026-09-22)
-- ------------------------------------------------------------
-- 대상: PATCH_r3_to_r4.sql 을 이미 실행한 DB
-- 내용: 가격 인식·유입 경로·아이 연령대·희망 시설·선물 교환번호/지급 시각·전체 응답(jsonb)
--       + 게이트 태블릿의 "아쉬운 이유" 코드
-- 특성: IF NOT EXISTS — 여러 번 실행해도 안전
-- ============================================================

alter table public.customer_experience_surveys add column if not exists price_perception text;   -- expensive / fair / cheap
alter table public.customer_experience_surveys add column if not exists visit_source     text;   -- friend / instagram / blog / naver / passing / county / festival / revisit
alter table public.customer_experience_surveys add column if not exists child_age_groups text;   -- age_0_3,age_4_6 ... (쉼표 구분)
alter table public.customer_experience_surveys add column if not exists wish_list        text;   -- party_room,program ... (쉼표 구분)
alter table public.customer_experience_surveys add column if not exists gift_code        text;   -- 선물 교환 번호 (4자리)
alter table public.customer_experience_surveys add column if not exists gift_given_at    timestamptz;
alter table public.customer_experience_surveys add column if not exists answers          jsonb;  -- 전체 응답 원본 (문항 버전·코드·라벨)

create index if not exists idx_ces_channel on public.customer_experience_surveys (survey_channel);

-- 확인
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'customer_experience_surveys'
   and column_name in ('price_perception','visit_source','child_age_groups','wish_list','gift_code','gift_given_at','answers','improvement_reason','favorite_facility','recommendation_score')
 order by column_name;
