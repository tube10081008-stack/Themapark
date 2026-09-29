-- ============================================================
-- 봉플레이 객단가(ARPU) 추적·분석 뷰 (2026-09-22)
-- ------------------------------------------------------------
-- 목적: 객단가가 "왜" 오르고 내리는지 SQL 한 줄로 볼 수 있게 한다.
-- 원천: order_items(품목 결제 원장) + safety_consents(방문·체류)
-- 보안: 별도 analytics 스키마에 두어 앱(anon)·외부 API 로는 조회 불가.
--       Supabase SQL Editor(관리자)에서만 조회한다. 개인정보(이름·연락처)는 뷰에 넣지 않는다.
-- 실행: SQL Editor 에 전체 붙여넣기 ➔ Run (여러 번 실행해도 안전)
--
-- 객단가 정의 (시뮬레이터 "혼합객단가"와 동일)
--   객단가 = 총 결제금액 ÷ 방문객 수
--   방문객 = 입장권 계열 수량 합계 (아이·보호자·영유아 무료·인솔교사 포함)
--   취소(status='cancelled') 건은 제외
-- ============================================================

create schema if not exists analytics;
revoke all on schema analytics from public, anon, authenticated;

-- 공통: 유효 결제 품목 (KST 날짜, 품목군 정규화)
create or replace view analytics.v_order_lines as
select
  o.item_id,
  o.order_id,
  o.visit_id,
  o.consent_id,
  (coalesce(o.purchased_at, o.created_at) at time zone 'Asia/Seoul')::date as 날짜,
  coalesce(o.purchased_at, o.created_at)                                   as 결제시각,
  coalesce(o.product_category, o.category, 'etc')                          as 품목군,
  o.product_id,
  o.product_name,
  coalesce(o.quantity, 1)                                                  as 수량,
  coalesce(o.list_price, o.unit_price, 0) * coalesce(o.quantity, 1)        as 정가금액,
  coalesce(o.discount_amount, 0)                                           as 할인금액,
  coalesce(o.paid_amount, o.total_price, 0)                                as 결제금액,
  o.discount_rule                                                          as 할인규칙,
  o.sales_channel                                                          as 판매채널
from public.order_items o
where coalesce(o.status, 'paid') <> 'cancelled';

-- ① 일자별 객단가 + 7일 이동평균 (추세 확인용 핵심 뷰)
create or replace view analytics.v_daily_arpu as
with d as (
  select
    날짜,
    sum(결제금액) filter (where 품목군 = 'ticket')  as 입장매출,
    sum(결제금액) filter (where 품목군 <> 'ticket') as 부가매출,
    sum(결제금액)                                   as 총매출,
    sum(수량) filter (where 품목군 = 'ticket')      as 방문객,
    sum(할인금액)                                   as 할인총액,
    count(distinct visit_id) filter (where 품목군 <> 'ticket' and visit_id is not null) as 매점연동가족
  from analytics.v_order_lines
  group by 날짜
)
select
  날짜,
  (array['월','화','수','목','금','토','일'])[extract(isodow from 날짜)::int] as 요일,
  coalesce(입장매출, 0) as 입장매출,
  coalesce(부가매출, 0) as 부가매출,
  총매출,
  coalesce(방문객, 0) as 방문객,
  round(총매출::numeric / nullif(방문객, 0))               as 객단가,
  round(coalesce(입장매출, 0)::numeric / nullif(방문객, 0)) as 입장객단가,
  round(coalesce(부가매출, 0)::numeric / nullif(방문객, 0)) as 부가객단가,
  round(100.0 * coalesce(부가매출, 0) / nullif(총매출, 0), 1) as 부가매출비중,
  할인총액,
  매점연동가족,
  round(avg(총매출::numeric / nullif(방문객, 0)) over (order by 날짜 rows between 6 preceding and current row)) as 객단가_7일평균
from d
order by 날짜 desc;

-- ② 방문(가족) 단위 지출 — 체류시간·거주지와 결합 (개인정보 제외)
create or replace view analytics.v_visit_spend as
with s as (
  select
    visit_id,
    min(날짜) as 날짜,
    sum(결제금액) filter (where 품목군 = 'ticket')  as 입장지출,
    sum(결제금액) filter (where 품목군 <> 'ticket') as 부가지출,
    sum(결제금액)                                   as 총지출,
    sum(수량) filter (where 품목군 = 'ticket')      as 인원,
    count(*) filter (where 품목군 <> 'ticket')      as 부가구매건수
  from analytics.v_order_lines
  where visit_id is not null
  group by visit_id
)
select
  s.visit_id,
  s.날짜,
  case when extract(isodow from s.날짜) in (6, 7) then '주말' else '평일' end as 요일구분,
  case when c.residence like '%군민%' or c.residence like '%관내%' then '군민' else '외지' end as 거주구분,
  coalesce(jsonb_array_length(case when jsonb_typeof(c.children) = 'array' then c.children end), 0) as 아이수,
  c.entry_at at time zone 'Asia/Seoul' as 입장시각,
  extract(hour from c.entry_at at time zone 'Asia/Seoul')::int as 입장시,
  c.stay_duration_minutes as 체류분,
  case
    when c.stay_duration_minutes is null then '미측정'
    when c.stay_duration_minutes < 90  then '1) 90분 미만'
    when c.stay_duration_minutes < 150 then '2) 90~150분'
    when c.stay_duration_minutes < 210 then '3) 150~210분'
    else '4) 210분 이상'
  end as 체류구간,
  coalesce(s.입장지출, 0) as 입장지출,
  coalesce(s.부가지출, 0) as 부가지출,
  s.총지출,
  s.인원,
  round(s.총지출::numeric / nullif(s.인원, 0)) as 객단가,
  s.부가구매건수
from s
left join public.safety_consents c on c.visit_id = s.visit_id;

-- ③ 세그먼트별 객단가 — "어떤 손님이 객단가를 올리나"
create or replace view analytics.v_arpu_segments as
select '요일구분' as 기준, 요일구분 as 구분, count(*) as 가족수, sum(인원) as 인원,
       round(sum(총지출)::numeric / nullif(sum(인원), 0)) as 객단가,
       round(sum(부가지출)::numeric / nullif(sum(인원), 0)) as 부가객단가
  from analytics.v_visit_spend group by 요일구분
union all
select '거주구분', 거주구분, count(*), sum(인원),
       round(sum(총지출)::numeric / nullif(sum(인원), 0)),
       round(sum(부가지출)::numeric / nullif(sum(인원), 0))
  from analytics.v_visit_spend group by 거주구분
union all
select '체류구간', 체류구간, count(*), sum(인원),
       round(sum(총지출)::numeric / nullif(sum(인원), 0)),
       round(sum(부가지출)::numeric / nullif(sum(인원), 0))
  from analytics.v_visit_spend group by 체류구간
union all
select '매점구매', case when 부가구매건수 > 0 then '매점 이용' else '미이용' end, count(*), sum(인원),
       round(sum(총지출)::numeric / nullif(sum(인원), 0)),
       round(sum(부가지출)::numeric / nullif(sum(인원), 0))
  from analytics.v_visit_spend group by 2
union all
select '입장시간대', case when 입장시 < 12 then '오전(조조)' when 입장시 < 15 then '오후 이른' else '오후 늦은' end, count(*), sum(인원),
       round(sum(총지출)::numeric / nullif(sum(인원), 0)),
       round(sum(부가지출)::numeric / nullif(sum(인원), 0))
  from analytics.v_visit_spend where 입장시 is not null group by 2
order by 1, 2;

-- ④ 품목별 부착률 — 방문객 100명당 몇 개 팔리나 (객단가를 올리는 품목 찾기)
create or replace view analytics.v_product_attach as
with visitors as (
  select sum(수량) as 방문객 from analytics.v_order_lines where 품목군 = 'ticket'
)
select
  l.품목군,
  l.product_name as 품목,
  sum(l.수량)    as 판매수량,
  sum(l.결제금액) as 매출,
  round(100.0 * sum(l.수량) / nullif(v.방문객, 0), 1)          as 방문객100명당,
  round(sum(l.결제금액)::numeric / nullif(v.방문객, 0))         as 객단가기여
from analytics.v_order_lines l cross join visitors v
where l.품목군 <> 'ticket'
group by l.품목군, l.product_name, v.방문객
order by 객단가기여 desc nulls last;

-- ⑤ 할인 효과 — 매점 연동 할인이 객단가를 올리는지
create or replace view analytics.v_discount_effect as
select
  coalesce(할인규칙, '할인 없음') as 할인규칙,
  count(distinct order_id)       as 주문수,
  sum(정가금액)                  as 정가매출,
  sum(할인금액)                  as 할인총액,
  sum(결제금액)                  as 실결제,
  round(sum(결제금액)::numeric / nullif(count(distinct order_id), 0)) as 주문당결제
from analytics.v_order_lines
group by 1
order by 실결제 desc;

-- ⑥ 방문 후기 설문 요약 (태블릿·모바일 정성 설문 + 퇴장 얼굴 버튼)
--    ※ PATCH_survey_v2.sql 실행 후 사용
create or replace view analytics.v_survey_base as
select
  s.id,
  (coalesce(s.submitted_at, s.created_at) at time zone 'Asia/Seoul')::date as 날짜,
  s.survey_channel                                    as 채널,     -- exit_tablet(얼굴 버튼) / tablet_survey / mobile_survey
  coalesce(s.satisfaction_score, s.score)             as 만족도,
  s.recommendation_score                              as 추천점수,
  s.favorite_facility, s.improvement_reason, s.wish_list, s.child_age_groups,
  s.price_perception, s.visit_source, s.revisit_intent,
  nullif(coalesce(s.notes, s.comment), '')            as 의견,
  s.gift_code, s.gift_given_at, s.pass_code, s.visit_id
from public.customer_experience_surveys s
where coalesce(s.visit_id, '') not like 'vst_sim_%';

-- 채널·날짜별 응답 수, 평균 만족도, 진짜 NPS(추천 0~10 응답분만), 선물 지급 수
create or replace view analytics.v_survey_daily as
select
  날짜, 채널,
  count(*)                                                            as 응답수,
  round(avg(만족도)::numeric, 2)                                       as 평균만족도,
  round(100.0 * count(*) filter (where 만족도 <= 3) / nullif(count(만족도), 0), 1) as 불만비율,
  count(추천점수)                                                      as 추천응답수,
  round(100.0 * (count(*) filter (where 추천점수 >= 9) - count(*) filter (where 추천점수 <= 6)) / nullif(count(추천점수), 0)) as NPS,
  count(*) filter (where gift_given_at is not null)                   as 선물지급
from analytics.v_survey_base
group by 날짜, 채널
order by 날짜 desc, 채널;

-- 복수 선택 문항 빈도 (좋았던 점 / 아쉬운 점 / 희망 시설 / 아이 연령대)
create or replace view analytics.v_survey_choices as
select '좋았던 점' as 문항, trim(x) as 코드, count(*) as 응답수
  from analytics.v_survey_base, unnest(string_to_array(favorite_facility, ',')) x
 where favorite_facility is not null and favorite_facility <> '' group by 2
union all
select '아쉬운 점', trim(x), count(*)
  from analytics.v_survey_base, unnest(string_to_array(improvement_reason, ',')) x
 where improvement_reason is not null and improvement_reason not in ('', 'none', 'skip') group by 2
union all
select '희망 시설', trim(x), count(*)
  from analytics.v_survey_base, unnest(string_to_array(wish_list, ',')) x
 where wish_list is not null and wish_list <> '' group by 2
union all
select '아이 연령대', trim(x), count(*)
  from analytics.v_survey_base, unnest(string_to_array(child_age_groups, ',')) x
 where child_age_groups is not null and child_age_groups <> '' group by 2
union all
select '가격 인식', price_perception, count(*) from analytics.v_survey_base where price_perception is not null group by 2
union all
select '유입 경로', visit_source, count(*) from analytics.v_survey_base where visit_source is not null group by 2
union all
select '재방문 의향', revisit_intent, count(*) from analytics.v_survey_base where revisit_intent is not null group by 2
order by 1, 3 desc;

-- 만족도와 행동 데이터 결합 (체류시간·지출과 만족도의 관계)
create or replace view analytics.v_survey_x_visit as
select b.날짜, b.채널, b.만족도, b.추천점수, b.improvement_reason as 아쉬운점,
       v.체류분, v.체류구간, v.총지출, v.부가지출, v.객단가, v.거주구분, v.요일구분
from analytics.v_survey_base b
join analytics.v_visit_spend v
  on v.visit_id = coalesce(b.visit_id,
       (select c.visit_id from public.safety_consents c where c.pass_code = b.pass_code limit 1));

-- 뷰도 앱 계정에서는 조회 불가 (관리자 SQL Editor 전용)
revoke all on all tables in schema analytics from public, anon, authenticated;

-- ============================================================
-- 사용 예시
--   select * from analytics.v_daily_arpu limit 30;        -- 일자별 객단가·7일 추세
--   select * from analytics.v_arpu_segments;              -- 누가 객단가를 올리나
--   select * from analytics.v_product_attach;             -- 어떤 품목이 객단가를 올리나
--   select * from analytics.v_discount_effect;            -- 할인이 효과 있나
--   select 체류구간, avg(부가지출) from analytics.v_visit_spend group by 1 order by 1;
-- ============================================================
