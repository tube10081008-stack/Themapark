"""현금흐름·비상대응 로직 검증 — API 키 없이 실행된다.

    python3 test_cashflow.py
"""

import sys
import tempfile
from datetime import date
from pathlib import Path

import store

_tmp = tempfile.TemporaryDirectory()
store.DATA_DIR = Path(_tmp.name)

import cashflow_agent as cf  # noqa: E402
from forecast_agent import weekday_coefficients  # noqa: E402
from config import ANNUAL_FIXED_COST, ASSUMED_TICKET_PRICE  # noqa: E402

failures: list[str] = []


passed = 0


def check(label: str, actual, expected) -> None:
    global passed
    if actual == expected:
        passed += 1
        print(f"[통과] {label}")
    else:
        print(f"[실패] {label} — 기대 {expected!r}, 실제 {actual!r}")
        failures.append(label)


def setup_cash(cash: int, fee_month: int | None = None, ins_month: int | None = None) -> None:
    c = {"starting_cash": cash, "as_of": "2026-09-01"}
    if fee_month:
        c["fee_month"] = fee_month
    if ins_month:
        c["insurance_month"] = ins_month
    store.save("cash", [c])


def test_cost_consistency() -> None:
    print("\n## 고정비 정합성")
    check("ANNUAL_ITEMS 합계 = config 고정비", sum(cf.ANNUAL_ITEMS.values()), ANNUAL_FIXED_COST)
    monthly = sum(v for k, v in cf.ANNUAL_ITEMS.items() if k not in cf.LUMP_SUM) / 12
    check("월 균등지출 계산 일치", cf.MONTHLY_OUTFLOW, monthly)
    check("일시납 항목은 월 균등에서 제외", cf.MONTHLY_OUTFLOW * 12 + sum(
        cf.ANNUAL_ITEMS[k] for k in cf.LUMP_SUM), float(ANNUAL_FIXED_COST))


def test_month_range() -> None:
    print("\n## 월 순회")
    check("연말 넘김", cf._month_range(date(2026, 11, 1), 4),
          [(2026, 11), (2026, 12), (2027, 1), (2027, 2)])
    check("1개월", cf._month_range(date(2026, 3, 15), 1), [(2026, 3)])


def test_balance_arithmetic() -> None:
    print("\n## 잔고 계산")
    store.save("daily", [])
    store.save("expenses", [])
    setup_cash(100_000_000)
    rows = cf.project(6, date(2026, 9, 1))["rows"]

    ok_type = all(isinstance(r["opening"], int) and isinstance(r["closing"], int) for r in rows)
    check("잔고가 모두 정수", ok_type, True)
    ok_math = all(r["opening"] + r["revenue"] - r["outflow"] == r["closing"] for r in rows)
    check("월초+수입-지출=월말", ok_math, True)
    ok_chain = all(rows[i]["closing"] == rows[i + 1]["opening"] for i in range(len(rows) - 1))
    check("전월 월말 = 당월 월초", ok_chain, True)
    check("첫 달 월초 = 보유현금", rows[0]["opening"], 100_000_000)


def test_lump_sums() -> None:
    print("\n## 일시 지출 반영")
    store.save("daily", [])
    store.save("expenses", [])
    setup_cash(100_000_000, fee_month=9, ins_month=3)
    rows = {(r["year"], r["month"]): r for r in cf.project(12, date(2026, 9, 1))["rows"]}

    sep = rows[(2026, 9)]
    check("9월에 사용료 표시", "사용료" in sep["lumps"], True)
    check("9월 지출 = 월균등 + 사용료",
          sep["outflow"], round(cf.MONTHLY_OUTFLOW + cf.ANNUAL_ITEMS["사용료(VAT포함)"]))
    check("9월에 보험료 없음", "보험료" in sep["lumps"], False)

    mar = rows[(2027, 3)]
    check("3월에 보험료 표시", "보험료" in mar["lumps"], True)

    oct_ = rows[(2026, 10)]
    check("10월은 월균등만", oct_["outflow"], round(cf.MONTHLY_OUTFLOW))


def test_one_off_expense() -> None:
    print("\n## 비정기 지출")
    store.save("daily", [])
    store.save("expenses", [
        {"id": 1, "date": "2026-10-15", "amount": 30_000_000, "item": "인테리어", "note": ""},
    ])
    setup_cash(100_000_000)
    rows = {(r["year"], r["month"]): r for r in cf.project(3, date(2026, 9, 1))["rows"]}
    check("10월에 비정기 지출 반영", rows[(2026, 10)]["outflow"],
          round(cf.MONTHLY_OUTFLOW) + 30_000_000)
    check("10월 비고에 항목명", "인테리어" in rows[(2026, 10)]["lumps"], True)
    check("9월은 영향 없음", rows[(2026, 9)]["outflow"], round(cf.MONTHLY_OUTFLOW))


def test_no_double_count() -> None:
    """기준일 이전 매출은 이미 보유 현금에 들어 있으므로 수입으로 다시 더하면 안 된다."""
    print("\n## 과거 실적 이중계상 방지")
    store.save("expenses", [])
    logged = [
        {"date": "2026-09-01", "visitors": 10, "revenue": 5_000_000},
        {"date": "2026-09-02", "visitors": 10, "revenue": 5_000_000},
        {"date": "2026-09-03", "visitors": 10, "revenue": 5_000_000},
    ]

    # 실적을 넣으면 요일계수가 바뀌어 추정치 자체가 달라진다. 따라서
    # "실적 유무로 수입이 같은가"가 아니라 "수입이 순수 추정치와 일치하는가"로
    # 이중계상을 확인해야 한다.
    store.save("daily", logged)
    setup_cash(100_000_000)
    as_of = date(2026, 9, 8)
    sep = cf.project(1, as_of)["rows"][0]

    coef, _, _ = weekday_coefficients(sorted(logged, key=lambda r: r["date"]))
    expected = cf._estimate_revenue(2026, 9, coef, ASSUMED_TICKET_PRICE, as_of.day)
    check("9월 수입 = 잔여일 추정치 (실적 1,500만이 더해지지 않음)", sep["revenue"], expected)
    check("실적이 수입에 섞였다면 이 값보다 컸을 것", sep["revenue"] < expected + 15_000_000, True)
    check("기준일이 속한 달은 '잔여'", sep["kind"], "잔여")

    # 기준일이 뒤로 갈수록 남은 날이 줄어 수입도 줄어야 한다
    early = cf.project(1, date(2026, 9, 1))["rows"][0]["revenue"]
    late = cf.project(1, date(2026, 9, 25))["rows"][0]["revenue"]
    check("기준일이 늦을수록 잔여 수입이 작음", late < early, True)

    # 다음 달부터는 온전한 한 달치 예측
    rows = cf.project(2, date(2026, 9, 25))["rows"]
    check("다음 달은 '예측'", rows[1]["kind"], "예측")
    check("다음 달 수입 > 9월 잔여분", rows[1]["revenue"] > rows[0]["revenue"], True)


def test_missing_lump_warning() -> None:
    print("\n## 일시납 월 미설정 감지")
    store.save("daily", [])
    store.save("expenses", [])

    setup_cash(100_000_000)   # fee_month / insurance_month 없음
    res = cf.project(12, date(2026, 9, 1))
    labels = [label for label, _ in res["missing_lumps"]]
    check("사용료 누락 감지", "사용료" in labels, True)
    check("보험료 누락 감지", "보험료" in labels, True)
    check("누락 금액 합계 = 51,300,000",
          sum(a for _, a in res["missing_lumps"]), 51_300_000)

    setup_cash(100_000_000, fee_month=9, ins_month=9)
    res2 = cf.project(12, date(2026, 9, 1))
    check("둘 다 설정하면 경고 없음", res2["missing_lumps"], [])

    # 일시납이 반영되면 연간 총지출이 고정비와 맞아야 한다.
    # 월 균등지출을 매월 반올림하므로 최대 12원(월 1원)의 오차는 허용한다.
    total_out = sum(r["outflow"] for r in res2["rows"])
    check("12개월 총지출 ≈ 연 고정비 (반올림 오차 12원 이내)",
          abs(total_out - ANNUAL_FIXED_COST) <= 12, True)


def test_range_guard() -> None:
    print("\n## 범위 방어")
    setup_cash(100_000_000)
    for bad in (0, -1):
        try:
            cf.project(bad, date(2026, 9, 1))
            check(f"months={bad} 거부", "예외 없음", "SystemExit")
        except SystemExit:
            check(f"months={bad} 거부", "SystemExit", "SystemExit")


def test_estimate_from_day() -> None:
    print("\n## 잔여일 매출 추정")
    coef = {i: 1.0 for i in range(7)}
    full = cf._estimate_revenue(2026, 9, coef, 10_000)
    half = cf._estimate_revenue(2026, 9, coef, 10_000, from_day=16)
    check("일부 기간이 전체보다 작음", half < full, True)
    check("월말 다음날부터는 0", cf._estimate_revenue(2026, 9, coef, 10_000, from_day=31), 0)
    check("1일부터 = 전체", cf._estimate_revenue(2026, 9, coef, 10_000, from_day=1), full)


def test_emergency_scenarios() -> None:
    print("\n## 비상 시나리오 정의")
    import emergency_agent as em
    check("짚코스터 추락 시나리오 존재", "fall" in em.SCENARIOS, True)
    check("화재 시나리오 존재", "fire" in em.SCENARIOS, True)
    check("미아 시나리오 존재", "missing" in em.SCENARIOS, True)
    check("시나리오 7종", len(em.SCENARIOS), 7)
    check("역할 4종", len(em.ROLES), 4)


def main() -> int:
    test_cost_consistency()
    test_month_range()
    test_balance_arithmetic()
    test_lump_sums()
    test_one_off_expense()
    test_no_double_count()
    test_missing_lump_warning()
    test_range_guard()
    test_estimate_from_day()
    test_emergency_scenarios()
    total = passed + len(failures)
    print(f"\n{passed}/{total} 통과")
    if failures:
        print("실패: " + ", ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        _tmp.cleanup()
