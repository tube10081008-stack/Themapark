"""에이전트 7 — 수요예측·인력 배치.

성수기 116명/일과 비수기 24명/일의 편차가 5배에 가까우므로, 인력을 고정으로
두면 성수기엔 부족하고 비수기엔 남는다. 실적에서 요일 패턴을 뽑아 향후 며칠을
예측하고 권장 인력을 제시한다.

예측 방식은 단순하고 검증 가능하게 유지했다.

    관측비율 = 실제 방문객 / 그 달의 계절 목표
    요일계수 = 해당 요일 관측비율의 평균
    예측     = 예측일 계절 목표 × 요일계수

표본이 부족한 요일은 계수를 쓰지 않고 전체 평균으로 대체하며, 그 사실을
출력에 명시한다. 데이터가 없으면 계절 목표를 그대로 돌려준다.
계산은 전부 순수 파이썬이라 API 키 없이 동작한다.
"""

import argparse
from collections import defaultdict
from datetime import date, timedelta
from statistics import mean

from client import cached_system, get_client, handle_api_error, text_of
from config import (
    FORECAST_MIN_SAMPLES,
    MODEL_QUALITY,
    season_target,
    staffing_for,
    system_prompt,
)
from store import load, parse_date

WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"]


def weekday_coefficients(rows: list[dict]) -> tuple[dict[int, float], dict[int, int], float]:
    """(요일→계수, 요일→표본수, 전체평균비율). 계절 편차는 목표로 나눠 제거한다."""
    ratios: dict[int, list[float]] = defaultdict(list)
    for r in rows:
        d = date.fromisoformat(r["date"])
        _, target = season_target(d.month)
        if target:
            ratios[d.weekday()].append(r["visitors"] / target)

    all_ratios = [x for v in ratios.values() for x in v]
    overall = mean(all_ratios) if all_ratios else 1.0

    coef, samples = {}, {}
    for wd in range(7):
        n = len(ratios.get(wd, []))
        samples[wd] = n
        coef[wd] = mean(ratios[wd]) if n >= FORECAST_MIN_SAMPLES else overall
    return coef, samples, overall


def forecast(days: int, as_of: date | None = None) -> dict:
    if days < 1:
        raise SystemExit("오류: 예측 일수는 1 이상이어야 합니다.")
    start = (as_of or date.today()) + timedelta(days=1)
    rows = sorted(load("daily"), key=lambda r: r["date"])
    coef, samples, overall = weekday_coefficients(rows)

    preds = []
    for i in range(days):
        d = start + timedelta(days=i)
        season, target = season_target(d.month)
        wd = d.weekday()
        est = target * coef[wd]
        preds.append({
            "date": d.isoformat(),
            "weekday": WEEKDAYS[wd],
            "season": season,
            "target": target,
            "coef": coef[wd],
            "trusted": samples[wd] >= FORECAST_MIN_SAMPLES,
            "visitors": round(est),
            "staffing": staffing_for(est),
        })
    return {
        "predictions": preds,
        "samples": samples,
        "overall_ratio": overall,
        "total_days": len(rows),
    }


def cmd_forecast(args) -> None:
    res = forecast(args.days, parse_date(args.date))
    n = res["total_days"]

    print(f"# 수요예측 — 향후 {args.days}일 (실적 {n}일 기준)\n")
    if n == 0:
        print("실적 기록이 없어 계절 목표를 그대로 사용합니다. 예측이 아니라 목표치입니다.\n")
    elif n < FORECAST_MIN_SAMPLES * 7:
        print(f"표본이 적습니다({n}일). 요일 패턴이 안정되려면 최소 {FORECAST_MIN_SAMPLES * 7}일 정도가 필요합니다.\n")

    print(f"{'날짜':<12}{'요일':<4}{'구분':<7}{'목표':>5}{'계수':>7}{'예측':>6}  권장인력")
    print("-" * 74)
    for p in res["predictions"]:
        star = "" if p["trusted"] else "*"
        s = p["staffing"]
        print(
            f"{p['date']:<12}{p['weekday']:<4}{p['season']:<7}{p['target']:>5}"
            f"{p['coef']:>6.2f}{star:<1}{p['visitors']:>6}  "
            f"안전{s['안전요원']} 매표{s['매표']} (총 {s['총원']})"
        )

    untrusted = [wd for wd, c in res["samples"].items() if c < FORECAST_MIN_SAMPLES]
    if untrusted and n > 0:
        names = ", ".join(WEEKDAYS[wd] for wd in sorted(untrusted))
        print(f"\n* 표본 부족({FORECAST_MIN_SAMPLES}일 미만)으로 전체 평균을 적용한 요일: {names}")

    peak = max(res["predictions"], key=lambda p: p["visitors"])
    low = min(res["predictions"], key=lambda p: p["visitors"])
    print(f"\n최다: {peak['date']}({peak['weekday']}) {peak['visitors']}명 / "
          f"최소: {low['date']}({low['weekday']}) {low['visitors']}명")

    if args.raw:
        return

    lines = "\n".join(
        f"- {p['date']}({p['weekday']}, {p['season']}) 예측 {p['visitors']}명"
        f" / 목표 {p['target']}명 / 권장 총원 {p['staffing']['총원']}명"
        + ("" if p["trusted"] else " [표본부족]")
        for p in res["predictions"]
    )
    prompt = (
        f"실적 {n}일치를 바탕으로 한 향후 {args.days}일 수요예측입니다.\n\n{lines}\n\n"
        "운영자에게 줄 배치 브리핑을 작성하십시오.\n\n"
        "1. 이번 기간의 특징 한 문장\n"
        "2. 인력 배치에서 주의할 날 1~2개와 그 이유\n"
        "3. 예측이 목표를 크게 밑도는 날이 있으면 프로모션 검토를 제안\n"
        "   (단, 이용요금 자체 변경은 봉화군 사전협의 사항이므로 요금 인하가 아니라\n"
        "    시간대 패키지·단체 유치 같은 방법을 제안할 것)\n\n"
        f"규칙: 표본이 {n}일뿐이라는 점을 감안해 단정하지 마십시오. "
        "[표본부족] 표시된 날은 신뢰도가 낮다고 명시하십시오. 300자 이내."
    )
    client = get_client()
    try:
        response = client.messages.create(
            model=MODEL_QUALITY,
            max_tokens=4000,
            system=cached_system(system_prompt()),
            thinking={"type": "adaptive"},
            output_config={"effort": "medium"},
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:  # noqa: BLE001
        handle_api_error(e)
        raise
    print("\n" + "=" * 60)
    print(text_of(response))


def cmd_pattern(args) -> None:
    """요일별 실측 패턴만 표시. API 불필요."""
    rows = sorted(load("daily"), key=lambda r: r["date"])
    if not rows:
        raise SystemExit("실적 기록이 없습니다. `daily_report.py log` 로 먼저 입력하세요.")
    coef, samples, overall = weekday_coefficients(rows)

    print(f"# 요일별 패턴 (실적 {len(rows)}일)\n")
    print(f"{'요일':<5}{'표본':>5}{'계수':>8}  해석")
    print("-" * 52)
    for wd in range(7):
        n = samples[wd]
        mark = "" if n >= FORECAST_MIN_SAMPLES else "  (표본부족)"
        rel = coef[wd] / overall if overall else 1.0
        desc = "평균 이상" if rel > 1.05 else ("평균 이하" if rel < 0.95 else "평균 수준")
        print(f"{WEEKDAYS[wd]:<5}{n:>5}{coef[wd]:>8.2f}  {desc}{mark}")
    print(f"\n전체 평균 비율: {overall:.2f} (1.00 = 계절 목표 달성)")


def main() -> None:
    p = argparse.ArgumentParser(description="수요예측·인력 배치")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("forecast", help="향후 수요·인력 예측")
    f.add_argument("-n", "--days", type=int, default=7, help="예측 일수 (기본 7)")
    f.add_argument("-d", "--date", help="기준일 YYYY-MM-DD (기본: 오늘)")
    f.add_argument("--raw", action="store_true", help="AI 브리핑 없이 표만 (API 불필요)")
    f.set_defaults(func=cmd_forecast)

    pt = sub.add_parser("pattern", help="요일별 실측 패턴 (API 불필요)")
    pt.set_defaults(func=cmd_pattern)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
