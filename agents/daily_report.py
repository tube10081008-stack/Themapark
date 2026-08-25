"""에이전트 6 — 일일 운영 리포트.

방문객·매출을 기록하고, 계절 목표와 손익분기 대비 어디쯤 와 있는지
매일 아침 한 장으로 확인한다. 현장에 없어도 상태를 파악하기 위한 도구다.

숫자 계산은 전부 순수 파이썬(API 불필요)이고, AI는 그 숫자를 읽고
코멘트를 붙이는 데만 쓴다.
"""

import argparse
from collections import defaultdict
from datetime import date, timedelta

from client import cached_system, get_client, handle_api_error, text_of
from config import (
    ANNUAL_BEP_VISITORS,
    ANNUAL_FIXED_COST,
    MODEL_QUALITY,
    season_target,
    system_prompt,
)
from store import append, load, parse_date


def cmd_log(args) -> None:
    d = parse_date(args.date)
    existing = [r for r in load("daily") if r["date"] == d.isoformat()]
    if existing and not args.force:
        raise SystemExit(
            f"오류: {d} 실적이 이미 기록되어 있습니다 (방문객 {existing[-1]['visitors']}명).\n"
            f"덮어쓰려면 --force 를 붙이세요."
        )
    rec = append("daily", {
        "date": d.isoformat(),
        "visitors": args.visitors,
        "revenue": args.revenue,
        "note": args.note or "",
    })
    _, target = season_target(d.month)
    rate = rec["visitors"] / target * 100
    unit = rec["revenue"] / rec["visitors"] if rec["visitors"] else 0
    print(f"기록됨 — {d} / 방문객 {rec['visitors']:,}명 / 매출 {rec['revenue']:,}원")
    print(f"  계절 목표 {target}명 대비 {rate:.0f}% / 실측 객단가 {unit:,.0f}원")


def _aggregate(rows: list[dict], year: int) -> dict:
    ytd = [r for r in rows if r["date"].startswith(str(year))]
    visitors = sum(r["visitors"] for r in ytd)
    revenue = sum(r["revenue"] for r in ytd)
    by_month = defaultdict(lambda: {"visitors": 0, "revenue": 0, "days": 0})
    for r in ytd:
        m = int(r["date"][5:7])
        by_month[m]["visitors"] += r["visitors"]
        by_month[m]["revenue"] += r["revenue"]
        by_month[m]["days"] += 1
    return {
        "days": len(ytd),
        "visitors": visitors,
        "revenue": revenue,
        "unit_price": revenue / visitors if visitors else 0,
        "bep_progress": visitors / ANNUAL_BEP_VISITORS * 100,
        "cost_coverage": revenue / ANNUAL_FIXED_COST * 100,
        "by_month": dict(by_month),
    }


def _build_summary(as_of: date, window: int) -> tuple[str, bool]:
    rows = sorted(load("daily"), key=lambda r: r["date"])
    if not rows:
        raise SystemExit("기록된 실적이 없습니다. 먼저 `daily_report.py log` 로 입력하세요.")

    start = as_of - timedelta(days=window - 1)
    recent = [r for r in rows if start.isoformat() <= r["date"] <= as_of.isoformat()]
    agg = _aggregate(rows, as_of.year)

    lines = [f"# 기준일 {as_of} (최근 {window}일 + 연간 누적)", "", "## 최근 일자별"]
    if recent:
        for r in recent:
            d = date.fromisoformat(r["date"])
            season, target = season_target(d.month)
            rate = r["visitors"] / target * 100
            unit = r["revenue"] / r["visitors"] if r["visitors"] else 0
            note = f" | {r['note']}" if r["note"] else ""
            lines.append(
                f"- {r['date']} ({season}) 방문 {r['visitors']:,}명 "
                f"(목표 {target}명, {rate:.0f}%) / 매출 {r['revenue']:,}원 "
                f"/ 객단가 {unit:,.0f}원{note}"
            )
        rv = sum(r["visitors"] for r in recent)
        lines += [
            "",
            f"최근 {len(recent)}일 합계: 방문 {rv:,}명 (일평균 {rv/len(recent):.1f}명), "
            f"매출 {sum(r['revenue'] for r in recent):,}원",
        ]
    else:
        lines.append("- (해당 기간 기록 없음)")

    lines += [
        "",
        "## 연간 누적",
        f"- 영업일수: {agg['days']}일",
        f"- 누적 방문객: {agg['visitors']:,}명",
        f"- 누적 매출: {agg['revenue']:,}원",
        f"- 실측 객단가: {agg['unit_price']:,.0f}원",
        f"- 손익분기 진척률: {agg['bep_progress']:.1f}% (연 목표 {ANNUAL_BEP_VISITORS:,}명)",
        f"- 고정비 회수율: {agg['cost_coverage']:.1f}% (연 고정비 {ANNUAL_FIXED_COST:,}원)",
        "",
        "## 월별",
    ]
    for m in sorted(agg["by_month"]):
        v = agg["by_month"][m]
        season, target = season_target(m)
        avg = v["visitors"] / v["days"]
        lines.append(
            f"- {m}월 ({season}): {v['days']}일 / 방문 {v['visitors']:,}명 "
            f"(일평균 {avg:.1f}명, 목표 {target}명, {avg/target*100:.0f}%) "
            f"/ 매출 {v['revenue']:,}원"
        )

    behind = agg["unit_price"] and agg["unit_price"] < 12_000
    return "\n".join(lines), behind


def cmd_report(args) -> None:
    summary, _ = _build_summary(parse_date(args.date), args.window)
    print(summary)
    if args.raw:
        return

    client = get_client()
    prompt = (
        f"{summary}\n\n"
        "위는 실제 운영 실적입니다. 운영자가 아침에 읽을 브리핑을 작성하십시오.\n\n"
        "구성:\n"
        "1. 한 줄 요약 — 지금 상태를 한 문장으로\n"
        "2. 눈여겨볼 점 2~3가지 — 목표 대비 미달/초과, 객단가 변화, 요일별 편차 등\n"
        "   숫자를 근거로 제시하십시오\n"
        "3. 오늘 할 일 제안 1~2가지 — 실행 가능한 것만\n\n"
        "규칙:\n"
        "- 데이터에 없는 사실을 추론해서 단정하지 마십시오. 표본이 적으면 적다고 말하십시오.\n"
        "- 격려나 위로는 넣지 마십시오. 사실과 판단만 씁니다.\n"
        "- 400자 이내로 간결하게."
    )
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


def main() -> None:
    p = argparse.ArgumentParser(description="일일 운영 리포트")
    sub = p.add_subparsers(dest="cmd", required=True)

    lg = sub.add_parser("log", help="당일 실적 입력 (API 불필요)")
    lg.add_argument("visitors", type=int, help="방문객 수")
    lg.add_argument("revenue", type=int, help="매출 (원)")
    lg.add_argument("-d", "--date", help="날짜 YYYY-MM-DD (기본: 오늘)")
    lg.add_argument("-n", "--note", default="", help="특이사항")
    lg.add_argument("--force", action="store_true", help="같은 날짜 재입력 허용")
    lg.set_defaults(func=cmd_log)

    rp = sub.add_parser("report", help="리포트 생성")
    rp.add_argument("-d", "--date", help="기준일 YYYY-MM-DD (기본: 오늘)")
    rp.add_argument("-w", "--window", type=int, default=7, help="최근 며칠 (기본 7)")
    rp.add_argument("--raw", action="store_true", help="AI 코멘트 없이 숫자만")
    rp.set_defaults(func=cmd_report)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
