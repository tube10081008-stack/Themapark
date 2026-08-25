"""에이전트 10 — 현금흐름 예측.

`daily_report` 는 손익을 보지만 **손익과 현금은 다르다.** 사용료 4,730만 원은
계약일로부터 14일 이내에 한 번에 나가고 매년 반복되므로, 그 달에는 매출과 무관하게
큰 구멍이 난다. 소규모 사업이 죽는 이유는 대개 적자가 아니라 현금 고갈이다.

수입 추정은 forecast_agent 의 요일계수를 그대로 재사용한다(같은 근거를 두 곳에서
따로 계산하지 않기 위함). 계산은 전부 순수 파이썬이라 API 키 없이 동작한다.
"""

import argparse
from calendar import monthrange
from datetime import date

from client import cached_system, get_client, handle_api_error, text_of
from config import (
    ANNUAL_FIXED_COST,
    ASSUMED_TICKET_PRICE,
    MODEL_QUALITY,
    season_target,
    system_prompt,
)
from forecast_agent import weekday_coefficients
from store import append, load, parse_date, save

# 연간 고정비 내역 (config.ANNUAL_FIXED_COST 와 합이 맞아야 한다)
ANNUAL_ITEMS = {
    "사용료(VAT포함)": 47_300_000,
    "보험료": 4_000_000,
    "유지관리비": 25_000_000,
    "인건비": 118_000_000,
    "기타(마케팅 등)": 15_000_000,
}
# 연 1회 일시 지출 — 나머지는 매월 균등 지출로 본다
LUMP_SUM = {"사용료(VAT포함)", "보험료"}

MONTHLY_OUTFLOW = sum(v for k, v in ANNUAL_ITEMS.items() if k not in LUMP_SUM) / 12


def _cfg() -> dict:
    rows = load("cash")
    return rows[-1] if rows else {}


def _month_range(start: date, months: int) -> list[tuple[int, int]]:
    out, y, m = [], start.year, start.month
    for _ in range(months):
        out.append((y, m))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def _estimate_revenue(y: int, m: int, coef: dict[int, float], price: int,
                      from_day: int = 1) -> int:
    """월 매출 추정 = Σ(일별 계절목표 × 요일계수) × 객단가.

    from_day 를 주면 그 날부터 월말까지만 계산한다. 진행 중인 달에서 이미 실적이
    있는 앞부분을 중복 계산하지 않기 위한 것.
    """
    _, target = season_target(m)
    days = monthrange(y, m)[1]
    if from_day > days:
        return 0
    visitors = sum(target * coef[date(y, m, d).weekday()] for d in range(from_day, days + 1))
    return round(visitors * price)


def cmd_setup(args) -> None:
    c = _cfg()
    if args.cash is not None:
        c["starting_cash"] = args.cash
    if args.date:
        c["as_of"] = parse_date(args.date).isoformat()
    if args.fee_month:
        c["fee_month"] = args.fee_month          # 사용료 납부 월 (1~12)
    if args.insurance_month:
        c["insurance_month"] = args.insurance_month
    c.setdefault("as_of", date.today().isoformat())
    save("cash", [c])

    print("현금 기준 설정됨:")
    print(f"  기준일: {c['as_of']}")
    print(f"  보유 현금: {c.get('starting_cash', 0):,}원")
    print(f"  사용료 납부월: {c.get('fee_month', '미설정')}월")
    print(f"  보험 갱신월: {c.get('insurance_month', '미설정')}월")
    if "starting_cash" not in c:
        print("\n※ 보유 현금이 설정되지 않았습니다. --cash 로 지정하세요.")


def cmd_expense(args) -> None:
    rec = append("expenses", {
        "date": parse_date(args.date).isoformat(),
        "amount": args.amount,
        "item": args.item,
        "note": args.note or "",
    })
    print(f"기록됨 (#{rec['id']}) — {rec['date']} / {rec['item']} / {rec['amount']:,}원")


def project(months: int, as_of: date) -> dict:
    if months < 1:
        raise SystemExit("오류: 예측 개월 수는 1 이상이어야 합니다.")
    c = _cfg()
    cash = c.get("starting_cash", 0)
    fee_month = c.get("fee_month")
    ins_month = c.get("insurance_month")

    # 과거 실적은 이미 starting_cash 에 반영돼 있으므로 수입으로 다시 더하지 않는다.
    # daily 기록은 요일계수(예측 정확도)를 뽑는 데만 쓴다.
    daily = sorted(load("daily"), key=lambda r: r["date"])
    coef, _, _ = weekday_coefficients(daily)

    extra: dict[tuple[int, int], list[dict]] = {}
    for e in load("expenses"):
        d = date.fromisoformat(e["date"])
        extra.setdefault((d.year, d.month), []).append(e)

    rows, balance = [], cash
    for y, m in _month_range(as_of, months):
        # 기준일이 속한 달은 남은 날짜분만 계산한다. 기준일 이전 수입은
        # 이미 보유 현금에 들어 있다.
        if (y, m) == (as_of.year, as_of.month):
            revenue = _estimate_revenue(y, m, coef, ASSUMED_TICKET_PRICE, as_of.day)
            kind = "잔여"
        else:
            revenue = _estimate_revenue(y, m, coef, ASSUMED_TICKET_PRICE)
            kind = "예측"

        out = MONTHLY_OUTFLOW
        lumps = []
        if fee_month and m == fee_month:
            out += ANNUAL_ITEMS["사용료(VAT포함)"]
            lumps.append("사용료")
        if ins_month and m == ins_month:
            out += ANNUAL_ITEMS["보험료"]
            lumps.append("보험료")
        one_offs = extra.get((y, m), [])
        out += sum(e["amount"] for e in one_offs)
        lumps += [e["item"] for e in one_offs]

        # 잔고는 매월 정수로 확정한다. float 을 그대로 이월하면 오차가 누적되고
        # 월초 잔고에 소수점이 그대로 찍힌다.
        opening = balance
        outflow = round(out)
        balance = opening + revenue - outflow
        rows.append({
            "year": y, "month": m, "kind": kind,
            "opening": opening, "revenue": revenue, "outflow": outflow,
            "closing": balance, "lumps": lumps,
        })
    return {
        "rows": rows, "starting_cash": cash, "configured": "starting_cash" in c,
        "as_of": as_of, "missing_lumps": [
            (label, ANNUAL_ITEMS[item])
            for key, label, item in (
                ("fee_month", "사용료", "사용료(VAT포함)"),
                ("insurance_month", "보험료", "보험료"),
            )
            if not c.get(key)
        ],
    }


def _base_date(arg_date: str | None) -> date:
    """기준일: 인자 > 저장된 as_of > 오늘. 보유 현금이 기록된 시점과 맞춰야 한다."""
    if arg_date:
        return parse_date(arg_date)
    stored = _cfg().get("as_of")
    return date.fromisoformat(stored) if stored else date.today()


def _warn_stale(res: dict) -> None:
    if res["missing_lumps"]:
        miss = ", ".join(label for label, _ in res["missing_lumps"])
        total = sum(amount for _, amount in res["missing_lumps"])
        print(f"※ {miss} 납부월이 설정되지 않아 연 {total:,}원의 일시 지출이 "
              f"예측에서 빠져 있습니다.")
        print("   setup --fee-month / --insurance-month 로 지정하십시오.\n")
    gap = (date.today() - res["as_of"]).days
    if gap > 30:
        print(f"※ 보유 현금 기준일이 {gap}일 전({res['as_of']})입니다. "
              f"setup --cash 로 현재 잔액을 갱신하십시오.\n")


def cmd_project(args) -> None:
    res = project(args.months, _base_date(args.date))
    if not res["configured"]:
        raise SystemExit(
            "보유 현금이 설정되지 않았습니다.\n"
            "  python3 cashflow_agent.py setup --cash 50000000 --fee-month 9 --insurance-month 9"
        )

    print(f"# 현금흐름 예측 — {res['as_of']} 기준, 향후 {args.months}개월 "
          f"(보유 현금 {res['starting_cash']:,}원)\n")
    _warn_stale(res)
    print(f"{'월':<10}{'구분':<6}{'월초':>14}{'수입':>14}{'지출':>14}{'월말':>14}  비고")
    print("-" * 92)
    for r in res["rows"]:
        kind = r["kind"]
        note = ", ".join(r["lumps"]) if r["lumps"] else ""
        mark = " [!]" if r["closing"] < 0 else ""
        print(
            f"{r['year']}-{r['month']:02d}  {kind:<6}{r['opening']:>14,}{r['revenue']:>14,}"
            f"{r['outflow']:>14,}{r['closing']:>14,}  {note}{mark}"
        )

    neg = [r for r in res["rows"] if r["closing"] < 0]
    low = min(res["rows"], key=lambda r: r["closing"])
    print()
    if neg:
        first = neg[0]
        print(f"※ {first['year']}-{first['month']:02d} 에 현금이 마이너스로 전환됩니다 "
              f"({first['closing']:,}원).")
        print(f"   최저점: {low['year']}-{low['month']:02d} {low['closing']:,}원 "
              f"→ 최소 {abs(low['closing']):,}원의 추가 자금이 필요합니다.")
    else:
        print(f"예측 기간 내 현금 부족은 발생하지 않습니다. "
              f"최저 잔고: {low['year']}-{low['month']:02d} {low['closing']:,}원")

    if args.raw:
        return

    lines = "\n".join(
        f"- {r['year']}-{r['month']:02d} ({r['kind']}) "
        f"수입 {r['revenue']:,} / 지출 {r['outflow']:,} / 월말 {r['closing']:,}"
        + (f" [{', '.join(r['lumps'])}]" if r["lumps"] else "")
        for r in res["rows"]
    )
    prompt = (
        f"연간 고정비 {ANNUAL_FIXED_COST:,}원 구조의 현금흐름 예측입니다.\n\n{lines}\n\n"
        "자금 브리핑을 작성하십시오.\n\n"
        "1. 현금 관점의 한 줄 진단\n"
        "2. 가장 위험한 달과 그 이유 (일시 지출이 겹치는 달을 짚을 것)\n"
        "3. 실행 가능한 대응 1~2가지\n\n"
        "규칙: 수입은 요일·계절 패턴에 기반한 추정이므로 단정하지 마십시오. "
        "대출·투자 유치 같은 금융 조언은 하지 마십시오. 300자 이내."
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


def cmd_runway(args) -> None:
    """현금이 바닥나기까지 몇 개월 남았는지. API 불필요."""
    res = project(36, _base_date(args.date))
    if not res["configured"]:
        raise SystemExit("보유 현금이 설정되지 않았습니다. setup 을 먼저 실행하세요.")
    _warn_stale(res)

    neg = [r for r in res["rows"] if r["closing"] < 0]
    print(f"보유 현금: {res['starting_cash']:,}원")
    print(f"월평균 고정지출(일시납 제외): {MONTHLY_OUTFLOW:,.0f}원")
    if neg:
        first = neg[0]
        idx = res["rows"].index(first)
        print(f"\n현금 소진 예상: {first['year']}-{first['month']:02d} (약 {idx}개월 후)")
        low = min(res["rows"], key=lambda r: r["closing"])
        print(f"최대 부족액: {abs(low['closing']):,}원 ({low['year']}-{low['month']:02d})")
    else:
        print("\n향후 36개월 내 현금 부족 없음")


def main() -> None:
    p = argparse.ArgumentParser(description="현금흐름 예측")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("setup", help="보유 현금·납부월 설정 (API 불필요)")
    s.add_argument("--cash", type=int, help="현재 보유 현금 (원)")
    s.add_argument("--date", help="기준일 YYYY-MM-DD")
    s.add_argument("--fee-month", type=int, choices=range(1, 13), metavar="1-12",
                   help="사용료 납부 월")
    s.add_argument("--insurance-month", type=int, choices=range(1, 13), metavar="1-12",
                   help="보험 갱신 월")
    s.set_defaults(func=cmd_setup)

    e = sub.add_parser("expense", help="비정기 지출 기록 (API 불필요)")
    e.add_argument("amount", type=int, help="금액 (원)")
    e.add_argument("item", help="항목명")
    e.add_argument("-d", "--date", help="지출일 YYYY-MM-DD")
    e.add_argument("-n", "--note", default="")
    e.set_defaults(func=cmd_expense)

    pj = sub.add_parser("project", help="월별 현금흐름 예측")
    pj.add_argument("-m", "--months", type=int, default=12, help="예측 개월 (기본 12)")
    pj.add_argument("-d", "--date", help="기준일 YYYY-MM-DD")
    pj.add_argument("--raw", action="store_true", help="AI 브리핑 없이 표만 (API 불필요)")
    pj.set_defaults(func=cmd_project)

    rw = sub.add_parser("runway", help="현금 소진 시점 (API 불필요)")
    rw.add_argument("-d", "--date", help="기준일 YYYY-MM-DD")
    rw.set_defaults(func=cmd_runway)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
