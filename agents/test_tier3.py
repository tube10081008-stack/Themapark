"""Tier 3 로직 검증 — API 키 없이 실행된다.

    python3 test_tier3.py
"""

import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import store

_tmp = tempfile.TemporaryDirectory()
store.DATA_DIR = Path(_tmp.name)

import forecast_agent  # noqa: E402
import review_agent  # noqa: E402
from config import staffing_for  # noqa: E402

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual == expected:
        print(f"[통과] {label}")
    else:
        print(f"[실패] {label} — 기대 {expected!r}, 실제 {actual!r}")
        failures.append(label)


def close(label: str, actual: float, expected: float, tol: float = 0.03) -> None:
    if abs(actual - expected) <= tol:
        print(f"[통과] {label} ({actual:.2f})")
    else:
        print(f"[실패] {label} — 기대 {expected:.2f}±{tol}, 실제 {actual:.2f}")
        failures.append(label)


def test_weekday_coefficients() -> None:
    print("\n## 요일 계수 추출")
    # 7월(성수기 목표 116명)에 평일 0.40 / 주말 0.90 비율로 4주치 생성
    rows = []
    d = date(2026, 7, 6)   # 월요일 시작
    for i in range(28):
        cur = d + timedelta(days=i)
        ratio = 0.90 if cur.weekday() >= 5 else 0.40
        rows.append({"date": cur.isoformat(), "visitors": round(116 * ratio), "revenue": 0})
    coef, samples, overall = forecast_agent.weekday_coefficients(rows)

    check("월요일 표본 4일", samples[0], 4)
    close("평일(월) 계수 ≈ 0.40", coef[0], 0.40)
    close("주말(토) 계수 ≈ 0.90", coef[5], 0.90)
    check("주말 계수가 평일보다 큼", coef[5] > coef[0], True)

    # 표본이 부족한 요일은 전체 평균으로 대체
    few = [r for r in rows if date.fromisoformat(r["date"]).weekday() in (0, 5)][:3]
    coef2, samples2, overall2 = forecast_agent.weekday_coefficients(few)
    check("표본 부족 요일은 전체평균 대체", coef2[2], overall2)

    # 데이터가 전혀 없으면 계수 1.0 (계절 목표를 그대로 씀)
    coef3, _, overall3 = forecast_agent.weekday_coefficients([])
    check("데이터 없으면 계수 1.0", coef3[0], 1.0)
    check("데이터 없으면 전체평균 1.0", overall3, 1.0)


def test_seasonality() -> None:
    print("\n## 계절 전환 반영")
    # 8월(성수기 116) 데이터로 계수를 만든 뒤 9월(준성수기 51) 예측
    rows = []
    d = date(2026, 8, 3)
    for i in range(21):
        cur = d + timedelta(days=i)
        rows.append({"date": cur.isoformat(), "visitors": round(116 * 0.50), "revenue": 0})
    store.save("daily", rows)

    aug = forecast_agent.forecast(1, date(2026, 8, 24))["predictions"][0]
    sep = forecast_agent.forecast(1, date(2026, 9, 24))["predictions"][0]

    check("8월 예측 구분", aug["season"], "성수기")
    check("9월 예측 구분", sep["season"], "준성수기")
    check("같은 계수인데 계절 목표가 다르면 예측도 다름", aug["visitors"] > sep["visitors"], True)
    check("8월 예측 = 116 × 0.50", aug["visitors"], 58)
    check("9월 예측 = 51 × 0.50", sep["visitors"], 26)


def test_staffing() -> None:
    print("\n## 인력 배치 구간")
    check("20명 → 총 3명", staffing_for(20)["총원"], 3)
    check("30명(경계) → 총 3명", staffing_for(30)["총원"], 3)
    check("31명 → 총 4명", staffing_for(31)["총원"], 4)
    check("100명 → 안전요원 3명", staffing_for(100)["안전요원"], 3)
    check("200명 → 총 7명", staffing_for(200)["총원"], 7)


def test_review_blocking() -> None:
    print("\n## 리뷰 자동응답 차단")
    must_block = [
        "애가 짚코스터에서 다칠 뻔했어요",
        "떨어질 뻔했습니다",
        "화장실에 벌레가 나왔어요",
        "환불해 주세요",
        "직원이 폭언을 했습니다",
        "위생상태가 엉망",
    ]
    must_pass = [
        "아이들이 정말 좋아했어요",
        "주차하기 편해서 좋았습니다",
        "대기시간이 좀 길었어요",
        "재방문 의사 있습니다",
    ]
    blocked_ok = all(review_agent.blocked_by(t) for t in must_block)
    passed_ok = all(review_agent.blocked_by(t) is None for t in must_pass)
    check("위험·분쟁 리뷰 전부 차단", blocked_ok, True)
    check("일반 리뷰 오탐 없음", passed_ok, True)


def main() -> int:
    test_weekday_coefficients()
    test_seasonality()
    test_staffing()
    test_review_blocking()
    total = 18
    print(f"\n{total - len(failures)}/{total} 통과")
    if failures:
        print("실패: " + ", ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        _tmp.cleanup()
