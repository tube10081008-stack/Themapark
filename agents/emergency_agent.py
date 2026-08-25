"""에이전트 11 — 비상대응 플레이북 생성.

사고가 나면 AI에게 물어볼 시간이 없다. 이 도구는 **사전에** 시나리오별 대응
절차를 문서로 뽑아 인쇄·비치하기 위한 것이다.

따라서 이 에이전트는 실시간 판단을 하지 않는다. `playbook` 으로 문서를 한 번
만들어 벽에 붙이고, 그 뒤로는 사람이 종이를 보고 움직인다.

의료적 판단(응급처치 방법, 이송 여부)은 문서에 담지 않는다. 그건 119와 의료진의
영역이며, 플레이북은 "누구에게 어떤 순서로 알리고 무엇을 기록하는가"만 다룬다.
"""

import argparse
from datetime import date

from client import cached_system, get_client, handle_api_error, text_of
from config import MODEL_QUALITY, system_prompt
from store import append, load, parse_date, save

SCENARIOS = {
    "fall":      ("추락·낙하 (짚코스터·네트어드벤처)", "본 시설의 최대 위험. 높이 13m 짚코스터와 네트 구조물에서 발생 가능"),
    "injury":    ("골절·염좌·열상",                    "놀이 중 가장 흔한 사고 유형"),
    "unconscious": ("의식불명·호흡곤란",                "즉시 119. 초 단위 대응이 필요한 상황"),
    "fire":      ("화재",                              "실내시설이고 다중이용업소. 대피 동선 확보가 핵심"),
    "missing":   ("미아·아동 실종",                     "가족단위 시설이라 발생 가능성이 높고 대응이 늦으면 커짐"),
    "trapped":   ("설비 고장 중 고립",                  "짚코스터·네트 상부에서 정지 시 구조 절차 필요"),
    "blackout":  ("정전",                              "어트랙션 정지 + 조명 소실 동시 발생"),
}

ROLES = ["최초 발견자", "안전요원", "운영담당", "관리책임자(사업주)"]


def _contacts() -> list[dict]:
    return load("contacts")


def cmd_contact(args) -> None:
    if args.delete is not None:
        rows = _contacts()
        kept = [c for c in rows if c["id"] != args.delete]
        if len(kept) == len(rows):
            raise SystemExit(f"오류: id={args.delete} 인 연락처가 없습니다.")
        save("contacts", kept)
        print(f"삭제됨 (#{args.delete})")
        return
    if not args.name:
        rows = _contacts()
        if not rows:
            print("등록된 연락처가 없습니다.")
            print("  python3 emergency_agent.py contact -n '봉화소방서' -p '119' -r 소방")
            return
        print(f"{'ID':>4}  {'구분':<10}{'이름':<22}연락처")
        print("-" * 60)
        for c in rows:
            print(f"{c['id']:>4}  {c['role']:<10}{c['name']:<22}{c['phone']}")
        return

    rec = append("contacts", {"name": args.name, "phone": args.phone, "role": args.role})
    print(f"등록됨 (#{rec['id']}) — {rec['role']} / {rec['name']} / {rec['phone']}")


def cmd_playbook(args) -> None:
    keys = [args.scenario] if args.scenario != "all" else list(SCENARIOS)
    contacts = _contacts()
    if not contacts:
        print("※ 긴급연락처가 등록되지 않았습니다. 플레이북의 연락처가 비어 나옵니다.")
        print("   python3 emergency_agent.py contact -n '봉화소방서' -p '119' -r 소방\n")

    contact_txt = "\n".join(f"- {c['role']}: {c['name']} {c['phone']}" for c in contacts) or "(미등록)"

    for key in keys:
        title, why = SCENARIOS[key]
        prompt = (
            f"# 시나리오\n{title}\n({why})\n\n"
            f"# 등록된 긴급연락처\n{contact_txt}\n\n"
            f"# 역할 구성\n{', '.join(ROLES)}\n\n"
            "# 요청\n"
            "위 상황이 발생했을 때 현장에서 종이를 보고 그대로 따라 할 수 있는\n"
            "비상대응 플레이북을 작성하십시오.\n\n"
            "구성:\n"
            "1. 최초 60초 — 최초 발견자가 할 일 (번호 매긴 3~5단계)\n"
            "2. 역할별 임무 — 안전요원 / 운영담당 / 관리책임자 각각\n"
            "3. 연락 순서 — 누구에게 어떤 순서로 (등록된 연락처를 쓰고, 없으면 [연락처 기입])\n"
            "4. 현장 통제 — 다른 이용객 관리, 기구 운행 중단 범위\n"
            "5. 기록 — 사고 직후 남겨야 할 항목 목록 (시각, 위치, 목격자 등)\n"
            "6. 사후 보고 — 봉화군 통보(계약서 제7조④·⑪), 보험사 신고, 재발방지\n\n"
            "규칙:\n"
            "- **응급처치 방법을 적지 마십시오.** 심폐소생술 절차, 지혈법, 부목 고정 같은\n"
            "  의료 행위는 이 문서의 범위가 아닙니다. '119 지시에 따른다'로 처리하십시오.\n"
            "- 부상 정도를 판단하거나 이송 여부를 결정하는 기준을 넣지 마십시오.\n"
            "- 짧은 명령문으로 쓰십시오. 당황한 사람이 읽습니다.\n"
            "- 법적 책임을 인정하는 표현을 넣지 마십시오.\n"
            "- 인쇄해서 벽에 붙일 문서이므로 한 장 분량으로 압축하십시오."
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

        print(f"\n{'=' * 70}")
        print(f"# 비상대응 플레이북 — {title}")
        print(f"{'=' * 70}\n")
        print(text_of(response))

    print("\n" + "-" * 70)
    print("※ 인쇄해서 매표소·사무실·기구별 위치에 비치하십시오.")
    print("   실제 사고 시에는 이 도구를 실행하지 말고 인쇄물을 보고 움직이십시오.")


def cmd_drill(args) -> None:
    if args.scenario and args.scenario not in SCENARIOS:
        raise SystemExit(f"오류: 시나리오는 {', '.join(SCENARIOS)} 중 하나여야 합니다.")
    if not args.scenario:
        rows = load("drills")
        if not rows:
            print("훈련 기록이 없습니다.")
            return
        print(f"{'일자':<12}{'시나리오':<28}{'참여':<20}메모")
        print("-" * 82)
        for r in sorted(rows, key=lambda r: r["date"]):
            title = SCENARIOS.get(r["scenario"], (r["scenario"], ""))[0]
            print(f"{r['date']:<12}{title:<28}{r['participants']:<20}{r['note']}")
        last = max(rows, key=lambda r: r["date"])
        gap = (date.today() - date.fromisoformat(last["date"])).days
        print(f"\n최근 훈련: {last['date']} ({gap}일 전)")
        if gap > 180:
            print("※ 6개월 이상 훈련 기록이 없습니다.")
        return

    rec = append("drills", {
        "date": parse_date(args.date).isoformat(),
        "scenario": args.scenario,
        "participants": args.participants,
        "note": args.note or "",
    })
    print(f"훈련 기록됨 (#{rec['id']}) — {SCENARIOS[args.scenario][0]} / {rec['date']}")


def main() -> None:
    p = argparse.ArgumentParser(description="비상대응 플레이북")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("contact", help="긴급연락처 등록·조회 (API 불필요)")
    c.add_argument("-n", "--name", help="기관·담당자명 (생략 시 목록 조회)")
    c.add_argument("-p", "--phone", default="", help="연락처")
    c.add_argument("-r", "--role", default="기타", help="구분 (소방/경찰/병원/군청/보험 등)")
    c.add_argument("--delete", type=int, help="삭제할 ID")
    c.set_defaults(func=cmd_contact)

    pb = sub.add_parser("playbook", help="플레이북 생성 (인쇄용)")
    pb.add_argument("scenario", choices=list(SCENARIOS) + ["all"], help="시나리오")
    pb.set_defaults(func=cmd_playbook)

    d = sub.add_parser("drill", help="훈련 기록 (API 불필요)")
    d.add_argument("scenario", nargs="?", help="시나리오 (생략 시 기록 조회)")
    d.add_argument("-p", "--participants", default="", help="참여자")
    d.add_argument("-d", "--date", help="훈련일 YYYY-MM-DD")
    d.add_argument("-n", "--note", default="")
    d.set_defaults(func=cmd_drill)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
