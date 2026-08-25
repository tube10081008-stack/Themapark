"""Tier 2 계약 준수 로직 검증 — API 키 없이 실행된다.

점검 기한과 민원 통보 기한은 계약 위반과 직결되므로, 계산 로직이
바뀌면 반드시 이 스크립트를 다시 돌릴 것.

    python3 test_tier2.py
"""

import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import store

# 실제 운영 데이터를 건드리지 않도록 임시 폴더로 격리
_tmp = tempfile.TemporaryDirectory()
store.DATA_DIR = Path(_tmp.name)

import complaint_agent  # noqa: E402
import safety_agent  # noqa: E402

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


def test_safety_status() -> None:
    print("\n## 안전점검 기한 계산")
    today = date(2026, 9, 1)

    # 기록이 없으면 전 항목 '미실시'
    states = {r["code"]: r["state"] for r in safety_agent.status(today)}
    check("기록 없을 때 짚코스터 미실시", states["zip"], "미실시")
    check("기록 없을 때 소방 미실시", states["fire"], "미실시")

    # 1일 주기 항목: 오늘 점검 → 정상, 어제 점검 → 임박, 3일 전 → 지연
    store.append("inspections", {"date": today.isoformat(), "item": "zip",
                                 "result": "정상", "note": "", "inspector": "테스트"})
    check("당일 점검 후 정상", {r["code"]: r["state"] for r in safety_agent.status(today)}["zip"], "정상")

    store.append("inspections", {"date": (today - timedelta(days=1)).isoformat(), "item": "net",
                                 "result": "정상", "note": "", "inspector": "테스트"})
    check("1일 전 점검(주기1일) 임박", {r["code"]: r["state"] for r in safety_agent.status(today)}["net"], "임박")

    store.append("inspections", {"date": (today - timedelta(days=3)).isoformat(), "item": "exit",
                                 "result": "정상", "note": "", "inspector": "테스트"})
    row = {r["code"]: r for r in safety_agent.status(today)}["exit"]
    check("3일 전 점검(주기1일) 지연", row["state"], "지연")
    check("지연 일수", row["overdue_days"], 2)

    # 30일 주기 항목은 3일 전 점검이면 아직 정상
    store.append("inspections", {"date": (today - timedelta(days=3)).isoformat(), "item": "fire",
                                 "result": "정상", "note": "", "inspector": "테스트"})
    check("3일 전 점검(주기30일) 정상", {r["code"]: r["state"] for r in safety_agent.status(today)}["fire"], "정상")

    # 같은 항목을 여러 번 점검하면 가장 최근 것을 본다
    store.append("inspections", {"date": today.isoformat(), "item": "exit",
                                 "result": "정상", "note": "", "inspector": "테스트"})
    check("재점검 후 최신 기록 반영", {r["code"]: r["state"] for r in safety_agent.status(today)}["exit"], "정상")


def test_complaint_deadline() -> None:
    print("\n## 민원 통보 기한 (특약 제12조: 3일)")
    check("8/25 접수 → 8/28 기한", complaint_agent._deadline("2026-08-25"), date(2026, 8, 28))
    check("월말 넘김 (8/30 → 9/2)", complaint_agent._deadline("2026-08-30"), date(2026, 9, 2))
    check("연말 넘김 (12/30 → 1/2)", complaint_agent._deadline("2026-12-30"), date(2027, 1, 2))
    check("윤년 2월 (2/27 → 3/1)", complaint_agent._deadline("2027-02-27"), date(2027, 3, 2))


def test_season_targets() -> None:
    print("\n## 계절 목표 (수지분석 기준)")
    from config import season_target
    check("1월 비수기", season_target(1), ("비수기", 24))
    check("7월 성수기", season_target(7), ("성수기", 116))
    check("10월 준성수기", season_target(10), ("준성수기", 51))
    check("12월 비수기", season_target(12), ("비수기", 24))


def main() -> int:
    test_safety_status()
    test_complaint_deadline()
    test_season_targets()
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
