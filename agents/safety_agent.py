"""에이전트 4 — 안전점검 기록·리마인더.

계약서 제10조·특약 제3조에 따라 점검일지를 작성·비치할 의무가 있고,
개인명의 사업이라 사고 시 무한책임 구조다.

**이 도구는 안전 여부를 판정하지 않는다.** 판정은 점검자(사람)가 하고,
도구는 (1) 기한 관리, (2) 기록 보존, (3) 일지 문장 정돈만 담당한다.
AI에게 "이상 없음"을 판단하게 하는 기능은 의도적으로 넣지 않았다.

기한 계산과 미이행 표시는 전부 순수 파이썬이라 API 키 없이도 동작한다.
"""

import argparse
from datetime import date, timedelta

from client import cached_system, get_client, handle_api_error, text_of
from config import MODEL_QUALITY, system_prompt
from store import append, load, parse_date

# (코드, 항목명, 주기(일), 근거)
CHECK_ITEMS = [
    ("zip",   "짚코스터 — 와이어·하네스·브레이크·체결부", 1,  "특약 제3조 ⑤"),
    ("net",   "네트어드벤처 — 그물 손상·고정부 유격",     1,  "특약 제3조 ⑤"),
    ("indoor", "실내놀이시설 — 매트·구조물·모서리 보호재", 1,  "특약 제3조 ⑤"),
    ("exit",  "비상구·피난통로 적치물 확인",              1,  "계약서 제7조 ⑧"),
    ("fire",  "소화기 압력·소방설비 상태",                30, "특약 제3조 ④"),
    ("elec",  "전기설비 안전점검",                        30, "계약서 제10조 ②"),
    ("total", "종합 안전점검 (전 기구 정밀)",             90, "특약 제3조 ⑤"),
]
ITEMS = {code: (name, cycle, basis) for code, name, cycle, basis in CHECK_ITEMS}

RESULTS = {"정상", "주의", "이상"}


def _last_check(code: str) -> dict | None:
    rows = [r for r in load("inspections") if r["item"] == code]
    return max(rows, key=lambda r: r["date"]) if rows else None


def status(as_of: date | None = None) -> list[dict]:
    """항목별 점검 상태. AI를 쓰지 않는다."""
    today = as_of or date.today()
    out = []
    for code, name, cycle, basis in CHECK_ITEMS:
        last = _last_check(code)
        if last is None:
            out.append({
                "code": code, "name": name, "cycle": cycle, "basis": basis,
                "last": None, "due": None, "overdue_days": None, "state": "미실시",
            })
            continue
        last_date = date.fromisoformat(last["date"])
        due = last_date + timedelta(days=cycle)
        delta = (today - due).days
        # delta > 0 기한 지남 / delta == 0 오늘이 기한 / delta < 0 아직 여유.
        # 1일 주기 항목은 점검한 날 due가 내일이 되므로 delta == -1 이 정상 상태다.
        state = "지연" if delta > 0 else ("임박" if delta == 0 else "정상")
        out.append({
            "code": code, "name": name, "cycle": cycle, "basis": basis,
            "last": last["date"], "last_result": last.get("result"),
            "due": due.isoformat(), "overdue_days": delta if delta > 0 else 0,
            "state": state,
        })
    return out


def cmd_status(args) -> None:
    rows = status(parse_date(args.date))
    order = {"미실시": 0, "지연": 1, "임박": 2, "정상": 3}
    rows.sort(key=lambda r: (order[r["state"]], -(r["overdue_days"] or 0)))

    print(f"{'상태':<6}{'항목':<34}{'주기':>5}  {'최근점검':<12}{'기한':<12}근거")
    print("-" * 92)
    for r in rows:
        mark = {"미실시": "[!] 미실시", "지연": "[!] 지연", "임박": "[~] 임박", "정상": "[ ] 정상"}[r["state"]]
        extra = f" ({r['overdue_days']}일 경과)" if r["overdue_days"] else ""
        print(
            f"{mark:<12}{r['name']:<34}{r['cycle']:>4}일  "
            f"{(r['last'] or '-'):<12}{(r['due'] or '-'):<12}{r['basis']}{extra}"
        )

    urgent = [r for r in rows if r["state"] in ("미실시", "지연")]
    if urgent:
        print(f"\n※ 즉시 조치 필요: {len(urgent)}건")
        print("   점검 후 기록: python3 safety_agent.py record <항목코드> <결과> -n '내용'")
    else:
        print("\n지연된 항목이 없습니다.")


def cmd_record(args) -> None:
    if args.item not in ITEMS:
        raise SystemExit(f"오류: 항목 코드가 잘못되었습니다. 가능한 값: {', '.join(ITEMS)}")
    if args.result not in RESULTS:
        raise SystemExit(f"오류: 결과는 {', '.join(RESULTS)} 중 하나여야 합니다.")
    if args.result in ("주의", "이상") and not args.note:
        raise SystemExit("오류: 결과가 '주의' 또는 '이상'이면 -n 으로 내용을 반드시 남겨야 합니다.")

    rec = append("inspections", {
        "date": parse_date(args.date).isoformat(),
        "item": args.item,
        "result": args.result,
        "note": args.note or "",
        "inspector": args.inspector,
    })
    name, cycle, _ = ITEMS[args.item]
    nxt = date.fromisoformat(rec["date"]) + timedelta(days=cycle)
    print(f"기록됨 (#{rec['id']}) — {name} / {args.result} / 점검자 {args.inspector}")
    print(f"다음 점검 기한: {nxt.isoformat()}")
    if args.result == "이상":
        print("\n※ '이상' 으로 기록되었습니다. 해당 기구의 운행을 중단하고 조치 후")
        print("   재점검 기록을 남기십시오. 필요 시 봉화군에 통보해야 합니다.")


def cmd_log(args) -> None:
    """계약상 비치용 점검일지를 문서 형태로 정돈한다. 판정은 하지 않는다."""
    start = parse_date(args.start)
    end = parse_date(args.end)
    rows = [r for r in load("inspections") if start.isoformat() <= r["date"] <= end.isoformat()]
    if not rows:
        raise SystemExit(f"{start} ~ {end} 기간에 기록된 점검이 없습니다.")
    rows.sort(key=lambda r: (r["date"], r["item"]))

    lines = [
        f"- {r['date']} | {ITEMS[r['item']][0]} | 결과: {r['result']}"
        f" | 점검자: {r['inspector']}" + (f" | 특이사항: {r['note']}" if r["note"] else "")
        for r in rows
    ]
    raw = "\n".join(lines)

    if args.raw:
        print(f"# 안전점검일지 ({start} ~ {end})\n\n{raw}")
        return

    client = get_client()
    prompt = (
        f"아래는 {start} ~ {end} 기간의 안전점검 원시 기록입니다.\n\n{raw}\n\n"
        "이것을 관계기관 제출·비치가 가능한 점검일지 문서로 정돈하십시오.\n\n"
        "규칙:\n"
        "- 기록에 있는 사실만 쓰십시오. 점검하지 않은 항목을 채워 넣지 마십시오.\n"
        "- **안전 여부를 판정하지 마십시오.** '이상 없음', '안전함' 같은 결론을 도구가\n"
        "  내리면 안 됩니다. 점검자가 기록한 결과를 그대로 옮기기만 하십시오.\n"
        "- 구성: 개요(기간·점검 항목 수) → 일자별 점검 내역 표 → 특이사항 및 조치 →\n"
        "  미점검·지연 항목이 있으면 그 사실을 명시\n"
        "- 담당자 서명란을 문서 끝에 두십시오."
    )
    try:
        response = client.messages.create(
            model=MODEL_QUALITY,
            max_tokens=16000,
            system=cached_system(system_prompt()),
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:  # noqa: BLE001
        handle_api_error(e)
        raise
    print(text_of(response))


def main() -> None:
    p = argparse.ArgumentParser(description="안전점검 기록·리마인더")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("status", help="점검 기한 현황 (API 불필요)")
    s.add_argument("-d", "--date", help="기준일 YYYY-MM-DD (기본: 오늘)")
    s.set_defaults(func=cmd_status)

    r = sub.add_parser("record", help="점검 결과 기록 (API 불필요)")
    r.add_argument("item", choices=list(ITEMS), help="항목 코드")
    r.add_argument("result", choices=sorted(RESULTS), help="점검 결과")
    r.add_argument("-n", "--note", default="", help="특이사항 (주의/이상이면 필수)")
    r.add_argument("-i", "--inspector", required=True, help="점검자 이름")
    r.add_argument("-d", "--date", help="점검일 YYYY-MM-DD (기본: 오늘)")
    r.set_defaults(func=cmd_record)

    g = sub.add_parser("log", help="비치용 점검일지 생성")
    g.add_argument("start", help="시작일 YYYY-MM-DD")
    g.add_argument("end", help="종료일 YYYY-MM-DD")
    g.add_argument("--raw", action="store_true", help="AI 정돈 없이 원시 기록만 출력")
    g.set_defaults(func=cmd_log)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
