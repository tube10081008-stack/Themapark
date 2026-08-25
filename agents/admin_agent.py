"""에이전트 9 — 봉화군 행정문서·기한 관리.

봉화군 계약서·특약에서 실제로 확인되는 제출·승인·통보 의무만 다룬다.
(목포 플레이파크 계약서에 있는 '회계연도 3개월 전 사업계획서 제출' 같은 조항은
 봉화 계약에는 **없다**. 다른 지자체 조건을 섞지 않도록 주의할 것)

기한 계산은 순수 파이썬이라 API 키 없이 동작하고, AI는 문서 초안에만 쓴다.
"""

import argparse
from datetime import date, timedelta

from client import cached_system, get_client, handle_api_error, text_of
from config import MODEL_QUALITY, system_prompt
from store import load, parse_date, save

# (키, 설명, 기준일 앵커, 오프셋(일), 근거)
#   앵커: contract=계약체결일, open=영업개시일, expiry=사용기간 만료일
#   오프셋 음수 = 앵커 이전, 양수 = 앵커 이후
OBLIGATIONS = [
    ("fee",        "연간 사용료 + 부가세 납부",              "contract",  14, "공고문 11-다"),
    ("liability",  "영업배상책임보험 증서 원본 제출",         "contract",   0, "계약서 제11조③"),
    ("fire_ins",   "화재보험 증서 원본 제출",                "contract",   0, "계약서 제11조③"),
    ("perf_bond",  "협약이행보증보험 증서 원본 제출",         "contract",  30, "계약서 제11조④ (1개월 이내)"),
    ("perf_join",  "협약이행보증보험 가입",                  "open",      30, "계약서 제11조④ (사업개시 30일 이내)"),
    ("permits",    "인허가 증빙서류 제출 (유원시설업 등)",     "open",     -10, "계약서 제12조 (개시 10일 전까지)"),
    ("extension",  "사용기간 연장 신청",                     "expiry",   -30, "계약서 제3조② (만료 30일 전)"),
]

# 사전 승인이 필요한 행위 (기한이 아니라 '하기 전에 받아야 하는 것')
APPROVALS = [
    ("시설물·집기 설치 및 구입",        "특약 제7조①"),
    ("옥내·외 간판 및 광고물 설치",     "특약 제9조"),
    ("건물 개조·시설물 구조 변경",      "계약서 제9조①"),
    ("휴업·폐업",                      "계약서 제7조① / 제13조①"),
    ("권리·의무 양도, 전대, 재위탁",    "계약서 제16조① (원칙적 금지)"),
]

# 즉시 통보 의무
NOTIFICATIONS = [
    ("화재·재해 등 이상유무 발견",              "계약서 제7조④"),
    ("화재·파손 등 인적·물적 피해 발생",        "계약서 제7조⑪"),
    ("민원 발생 (3일 이내 서면)",               "특약 제12조 → complaint_agent.py 사용"),
]

DOC_TYPES = {
    "approval": "사전승인 신청서",
    "incident": "사고·재해 통보문",
    "extension": "사용기간 연장 신청서",
    "suspension": "휴업 승인 신청서",
}


def _dates() -> dict:
    rows = load("contract")
    return rows[-1] if rows else {}


def cmd_setup(args) -> None:
    d = _dates()
    if args.contract:
        d["contract"] = parse_date(args.contract).isoformat()
    if args.open:
        d["open"] = parse_date(args.open).isoformat()
    if args.expiry:
        d["expiry"] = parse_date(args.expiry).isoformat()

    # 계약일이 바뀌면 만료일도 다시 계산한다. 그대로 두면 연장신청 기한이 틀어진다.
    if d.get("contract") and not args.expiry:
        c = date.fromisoformat(d["contract"])
        try:
            expiry = c.replace(year=c.year + 5)
        except ValueError:
            # 2/29 계약 → 5년 뒤에 2/29 가 없으므로 2/28 로 내린다
            expiry = c.replace(year=c.year + 5, day=28)
        if d.get("expiry") != expiry.isoformat():
            d["expiry"] = expiry.isoformat()
            print(f"만료일을 계약일 + 5년으로 설정: {d['expiry']} (계약서 제3조①)")

    save("contract", [d])
    print("계약 기준일 저장됨:")
    for k, label in [("contract", "계약체결일"), ("open", "영업개시일"), ("expiry", "사용기간 만료일")]:
        print(f"  {label}: {d.get(k, '미설정')}")
    if not d.get("open"):
        print("\n※ 영업개시일이 미설정입니다. 인허가 제출 기한을 계산하려면 설정하세요.")


def cmd_deadlines(args) -> None:
    d = _dates()
    if not d.get("contract"):
        raise SystemExit(
            "계약 기준일이 설정되지 않았습니다.\n"
            "  python3 admin_agent.py setup --contract 2026-09-08 --open 2026-11-01"
        )
    today = parse_date(args.date)

    rows = []
    for key, desc, anchor, offset, basis in OBLIGATIONS:
        base = d.get(anchor)
        if not base:
            rows.append({"desc": desc, "due": None, "left": None, "basis": basis, "anchor": anchor})
            continue
        due = date.fromisoformat(base) + timedelta(days=offset)
        rows.append({
            "desc": desc, "due": due, "left": (due - today).days,
            "basis": basis, "anchor": anchor,
        })

    known = [r for r in rows if r["due"]]
    known.sort(key=lambda r: r["due"])
    unknown = [r for r in rows if not r["due"]]

    print(f"# 계약 기한 현황 (기준일 {today})\n")
    print(f"{'상태':<10}{'기한':<12}{'남음':>8}  {'항목':<32}근거")
    print("-" * 96)
    for r in known:
        left = r["left"]
        if left < 0:
            mark = "[!] 경과"
        elif left <= 7:
            mark = "[~] 임박"
        else:
            mark = "[ ] 여유"
        txt = f"{left}일" if left >= 0 else f"{-left}일 초과"
        print(f"{mark:<10}{r['due'].isoformat():<12}{txt:>8}  {r['desc']:<32}{r['basis']}")
    for r in unknown:
        anchor_name = {"open": "영업개시일", "expiry": "만료일"}.get(r["anchor"], r["anchor"])
        print(f"{'[?] 미정':<10}{'-':<12}{'-':>8}  {r['desc']:<32}{r['basis']} ({anchor_name} 필요)")

    print("\n## 사전 승인이 필요한 행위 (실행 전 반드시 신청)")
    for desc, basis in APPROVALS:
        print(f"  - {desc}  ({basis})")
    print("\n## 즉시 통보 의무")
    for desc, basis in NOTIFICATIONS:
        print(f"  - {desc}  ({basis})")


def cmd_draft(args) -> None:
    if args.type not in DOC_TYPES:
        raise SystemExit(f"오류: 문서 종류는 {', '.join(DOC_TYPES)} 중 하나여야 합니다.")
    d = _dates()

    context = {
        "approval": (
            "특약 제7조① / 제9조 / 계약서 제9조①에 따라 봉화군수의 사전승인을 받기 위한 신청서입니다.\n"
            "구성: 신청 취지 → 대상 시설물·광고물의 내용과 규격 → 설치 위치와 방법 →\n"
            "기존 시설에 미치는 영향 → 비용 부담 주체(사용자 부담임을 명시) → 원상회복 계획"
        ),
        "incident": (
            "계약서 제7조④·⑪에 따라 화재·재해·피해 발생을 봉화군에 통보하는 문서입니다.\n"
            "구성: 발생 일시·장소 → 경위 → 피해 내역 → 취한 조치 → 향후 조치 계획 →\n"
            "재발 방지 대책\n"
            "사실만 기술하고, 책임 소재에 대한 판단이나 인정 표현은 넣지 마십시오."
        ),
        "extension": (
            "계약서 제3조②에 따라 사용기간 만료 30일 전에 제출하는 연장 신청서입니다.\n"
            "구성: 신청 취지 → 현 계약 개요 → 운영 실적 요약 → 연장 희망 기간 →\n"
            "향후 운영 계획\n"
            "실적 수치는 [실적 기입] 으로 표시해 담당자가 채우게 하십시오."
        ),
        "suspension": (
            "계약서 제7조①에 따라 휴업 승인을 받기 위한 신청서입니다.\n"
            "구성: 신청 취지 → 휴업 사유 → 휴업 기간 → 기간 중 시설 관리 계획 →\n"
            "재개 예정일\n"
            "무단 휴업은 계약서 제13조①상 해지 사유임을 인지하고 작성하십시오."
        ),
    }[args.type]

    prompt = (
        f"# 문서 종류\n{DOC_TYPES[args.type]}\n\n"
        f"# 작성 지침\n{context}\n\n"
        f"# 사안\n{args.subject}\n"
    )
    if args.detail:
        prompt += f"\n# 추가 정보\n{args.detail}\n"
    if d.get("contract"):
        prompt += f"\n# 참고\n계약체결일: {d['contract']}"
        if d.get("open"):
            prompt += f" / 영업개시일: {d['open']}"
        if d.get("expiry"):
            prompt += f" / 만료일: {d['expiry']}"
        prompt += "\n"
    prompt += (
        "\n# 규칙\n"
        "- 지자체에 제출하는 공문 형식으로, 담담한 문어체로 작성하십시오.\n"
        "- 수신은 '봉화군수', 문서 끝에 사용자 서명란을 두십시오.\n"
        "- 제공된 정보에 없는 사실을 지어내지 마십시오. 담당자가 채워야 하는 부분은\n"
        "  [기입 필요] 로 표시하십시오.\n"
        "- 금액·일정을 임의로 만들어내지 마십시오."
    )

    client = get_client()
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

    print(f"# {DOC_TYPES[args.type]} 초안\n")
    print(text_of(response))
    print("\n" + "-" * 60)
    print("※ 초안입니다. [기입 필요] 부분을 채우고 사실관계를 확인한 뒤 제출하십시오.")


def cmd_sales(args) -> None:
    """계약서 제7조⑥ — 군 요구 시 즉시 제출할 매출 자료. API 불필요."""
    rows = sorted(load("daily"), key=lambda r: r["date"])
    start, end = parse_date(args.start), parse_date(args.end)
    sel = [r for r in rows if start.isoformat() <= r["date"] <= end.isoformat()]
    if not sel:
        raise SystemExit(f"{start} ~ {end} 기간에 기록된 실적이 없습니다.")

    visitors = sum(r["visitors"] for r in sel)
    revenue = sum(r["revenue"] for r in sel)
    print(f"# 매출 내역 ({start} ~ {end})")
    print("근거: 계약서 제7조⑥ (매입·매출내역 기록·보관 및 요구 시 제출)\n")
    print(f"{'일자':<12}{'방문객':>8}{'매출(원)':>14}  비고")
    print("-" * 60)
    for r in sel:
        print(f"{r['date']:<12}{r['visitors']:>8,}{r['revenue']:>14,}  {r['note']}")
    print("-" * 60)
    print(f"{'합계':<12}{visitors:>8,}{revenue:>14,}")
    print(f"\n영업일수 {len(sel)}일 / 일평균 방문 {visitors/len(sel):.1f}명 "
          f"/ 평균 객단가 {revenue/visitors:,.0f}원" if visitors else "")
    print("\n※ 이 자료는 매출 측만 포함합니다. 계약서 제7조⑥은 매입내역도 요구하므로,")
    print("   매입 자료는 회계 기록에서 별도로 준비하십시오.")


def main() -> None:
    p = argparse.ArgumentParser(description="봉화군 행정문서·기한 관리")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("setup", help="계약 기준일 설정 (API 불필요)")
    s.add_argument("--contract", help="계약체결일 YYYY-MM-DD")
    s.add_argument("--open", help="영업개시일 YYYY-MM-DD")
    s.add_argument("--expiry", help="만료일 (미지정 시 계약일+5년)")
    s.set_defaults(func=cmd_setup)

    dl = sub.add_parser("deadlines", help="기한·승인·통보 의무 현황 (API 불필요)")
    dl.add_argument("-d", "--date", help="기준일 YYYY-MM-DD (기본: 오늘)")
    dl.set_defaults(func=cmd_deadlines)

    dr = sub.add_parser("draft", help="행정문서 초안 작성")
    dr.add_argument("type", choices=list(DOC_TYPES), help="문서 종류")
    dr.add_argument("subject", help="사안 요약")
    dr.add_argument("-x", "--detail", default="", help="추가 정보")
    dr.set_defaults(func=cmd_draft)

    sl = sub.add_parser("sales", help="매출 자료 정리 (API 불필요)")
    sl.add_argument("start", help="시작일 YYYY-MM-DD")
    sl.add_argument("end", help="종료일 YYYY-MM-DD")
    sl.set_defaults(func=cmd_sales)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
