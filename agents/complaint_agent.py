"""에이전트 5 — 민원 대응 초안·기한 관리.

사용허가 특수조건 제12조: 민원 발생 시 **3일 이내** 대책을 강구하여
서면으로 군수에게 통보해야 한다. 놓치면 계약 위반이다.

기한 계산은 순수 파이썬이라 API 키 없이 동작한다. AI는 회신문·통보문
초안 작성에만 쓰인다.
"""

import argparse
from datetime import date, timedelta

from client import cached_system, get_client, handle_api_error, text_of
from config import COMPLAINT_DEADLINE_DAYS, MODEL_QUALITY, system_prompt
from store import append, load, parse_date, update

CHANNELS = ["현장", "전화", "온라인", "군청이첩", "기타"]
SEVERITIES = ["경미", "보통", "중대"]


def _deadline(received: str) -> date:
    return date.fromisoformat(received) + timedelta(days=COMPLAINT_DEADLINE_DAYS)


def cmd_new(args) -> None:
    received = parse_date(args.date)
    rec = append("complaints", {
        "date": received.isoformat(),
        "channel": args.channel,
        "severity": args.severity,
        "summary": args.summary,
        "contact": args.contact or "",
        "status": "접수",
        "deadline": _deadline(received.isoformat()).isoformat(),
        "actions": "",
        "notified_gun": False,
    })
    left = (date.fromisoformat(rec["deadline"]) - date.today()).days
    print(f"접수됨 (#{rec['id']}) — {args.summary}")
    print(f"군 통보 기한: {rec['deadline']} (특약 제12조, {left}일 남음)")
    if args.severity == "중대":
        print("\n※ 중대 민원입니다. 계약서 제13조 ⑥ — 중대 민원이 연 2회 이상 발생하면")
        print("   해지 사유가 됩니다. 처리 경과를 상세히 남기십시오.")


def cmd_list(args) -> None:
    rows = load("complaints")
    if not args.all:
        rows = [r for r in rows if r["status"] != "완료"]
    if not rows:
        print("처리 중인 민원이 없습니다." if not args.all else "기록된 민원이 없습니다.")
        return

    today = date.today()
    for r in rows:
        r["_left"] = (date.fromisoformat(r["deadline"]) - today).days
    rows.sort(key=lambda r: (r["status"] == "완료", r["_left"]))

    print(f"{'ID':>4}  {'상태':<6}{'심각도':<6}{'접수일':<12}{'기한':<12}{'남음':>6}  요약")
    print("-" * 96)
    for r in rows:
        left = r["_left"]
        if r["status"] == "완료":
            flag = "완료"
        elif left < 0:
            flag = f"초과 {-left}일"
        elif left == 0:
            flag = "오늘"
        else:
            flag = f"{left}일"
        gun = "" if r["notified_gun"] else "  [군통보 미완]"
        print(
            f"{r['id']:>4}  {r['status']:<6}{r['severity']:<6}{r['date']:<12}"
            f"{r['deadline']:<12}{flag:>6}  {r['summary'][:34]}{gun}"
        )

    overdue = [r for r in rows if r["status"] != "완료" and r["_left"] < 0]
    if overdue:
        print(f"\n※ 기한 초과 {len(overdue)}건 — 특약 제12조 위반 상태입니다. 즉시 조치하십시오.")


def cmd_draft(args) -> None:
    rows = load("complaints")
    rec = next((r for r in rows if r["id"] == args.id), None)
    if rec is None:
        raise SystemExit(f"오류: id={args.id} 인 민원이 없습니다.")

    kind = "봉화군 서면 통보문" if args.gun else "민원인 회신문"
    if args.gun:
        body = (
            "사용허가 특수조건 제12조에 따라 봉화군수에게 제출할 서면 통보문을 작성하십시오.\n"
            "구성: 민원 개요(발생일·경로·내용) → 원인 확인 → 조치 내용 → 재발 방지 대책 → 향후 계획\n"
            "공문 형식의 담담한 문어체로 쓰고, 사실만 기술하십시오."
        )
    else:
        body = (
            "민원인에게 보낼 회신문을 작성하십시오.\n"
            "구성: 사과 및 접수 확인 → 확인된 사실 → 조치 내용 → 재발 방지 → 연락처 안내\n"
            "3~5문단, 정중하되 과도하게 굽신거리지 말고 담담하게 쓰십시오."
        )

    prompt = (
        f"# 민원 정보\n"
        f"- 접수일: {rec['date']}\n- 경로: {rec['channel']}\n- 심각도: {rec['severity']}\n"
        f"- 내용: {rec['summary']}\n"
        f"- 조치 내역: {rec['actions'] or '(아직 기록 없음)'}\n\n"
        f"# 요청\n{body}\n\n"
        "규칙:\n"
        "- 위 정보에 없는 사실을 지어내지 마십시오. 확인이 필요한 부분은\n"
        "  [확인 필요] 로 표시해 담당자가 채우게 하십시오.\n"
        "- 법적 책임을 인정하거나 배상을 약속하는 문구를 넣지 마십시오.\n"
        "  (개인명의 무한책임 구조이므로 문서상 책임 인정은 담당자가 직접 판단할 사안입니다)\n"
        "- 금액·보상 조건을 임의로 제시하지 마십시오."
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

    print(f"# {kind} 초안 (민원 #{rec['id']})\n")
    print(text_of(response))
    print("\n" + "-" * 60)
    print("※ 초안입니다. 사실관계를 확인하고 [확인 필요] 부분을 채운 뒤 발송하십시오.")


def cmd_update(args) -> None:
    fields = {}
    if args.actions:
        rows = load("complaints")
        rec = next((r for r in rows if r["id"] == args.id), None)
        if rec is None:
            raise SystemExit(f"오류: id={args.id} 인 민원이 없습니다.")
        prev = rec["actions"]
        stamp = date.today().isoformat()
        fields["actions"] = (prev + "\n" if prev else "") + f"[{stamp}] {args.actions}"
    if args.status:
        fields["status"] = args.status
    if args.notified:
        fields["notified_gun"] = True
    if not fields:
        raise SystemExit("변경할 내용이 없습니다. --actions / --status / --notified 중 하나를 쓰세요.")

    rec = update("complaints", args.id, **fields)
    print(f"갱신됨 (#{rec['id']}) — 상태 {rec['status']} / 군통보 {'완료' if rec['notified_gun'] else '미완'}")
    if rec["status"] == "완료" and not rec["notified_gun"]:
        print("\n※ 군 통보가 아직 '미완' 입니다. 특약 제12조상 서면 통보가 필요합니다.")


def main() -> None:
    p = argparse.ArgumentParser(description="민원 대응 초안·기한 관리")
    sub = p.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("new", help="민원 접수 (API 불필요)")
    n.add_argument("summary", help="민원 요약")
    n.add_argument("-c", "--channel", choices=CHANNELS, default="현장")
    n.add_argument("-s", "--severity", choices=SEVERITIES, default="보통")
    n.add_argument("-t", "--contact", default="", help="민원인 연락처")
    n.add_argument("-d", "--date", help="접수일 YYYY-MM-DD (기본: 오늘)")
    n.set_defaults(func=cmd_new)

    ls = sub.add_parser("list", help="처리 현황 (API 불필요)")
    ls.add_argument("-a", "--all", action="store_true", help="완료 건도 표시")
    ls.set_defaults(func=cmd_list)

    d = sub.add_parser("draft", help="대응 초안 작성")
    d.add_argument("id", type=int, help="민원 ID")
    d.add_argument("--gun", action="store_true", help="봉화군 서면 통보문 (기본: 민원인 회신문)")
    d.set_defaults(func=cmd_draft)

    u = sub.add_parser("update", help="조치 기록·상태 변경 (API 불필요)")
    u.add_argument("id", type=int)
    u.add_argument("--actions", help="조치 내용 추가")
    u.add_argument("--status", choices=["접수", "대응중", "완료"])
    u.add_argument("--notified", action="store_true", help="봉화군 서면 통보 완료 표시")
    u.set_defaults(func=cmd_update)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
