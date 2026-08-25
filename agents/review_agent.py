"""에이전트 8 — 리뷰 모니터링·대응 초안.

네이버·구글 리뷰를 붙여넣으면 분류하고 답글 초안을 만든다. 누적하면 어떤
불만이 반복되는지 패턴이 보인다.

크롤링은 하지 않는다. 플랫폼 약관 문제도 있고, 하루 몇 건 수준이라 붙여넣기가
더 빠르다. 리뷰를 자동으로 긁어오는 기능은 의도적으로 넣지 않았다.

`faq_agent` 와 같은 원칙: **안전·사고·분쟁 리뷰는 AI가 답글을 쓰지 않는다.**
공개된 곳에 남기는 답글이라 잘못 쓰면 되돌릴 수 없다.
"""

import argparse
from collections import Counter
from datetime import date

from pydantic import BaseModel

from client import cached_system, get_client, handle_api_error, text_of
from config import MODEL_QUALITY, MODEL_VOLUME, system_prompt
from faq_agent import ESCALATE_KEYWORDS
from store import append, load, parse_date

PLATFORMS = ["네이버", "구글", "카카오", "인스타", "기타"]

# 답글을 자동 생성하지 않고 사람에게 넘기는 주제.
# faq_agent 의 목록을 그대로 쓰고, 공개 리뷰에서만 문제되는 항목을 더한다.
REVIEW_BLOCK_KEYWORDS = ESCALATE_KEYWORDS + ["위생", "벌레", "식중독", "차별", "폭언", "성희롱"]

CATEGORIES = ["시설", "안전", "직원응대", "요금", "청결", "혼잡", "예약", "기타"]


class ReviewAnalysis(BaseModel):
    sentiment: str      # 긍정 / 중립 / 부정
    category: str       # CATEGORIES 중 하나
    actionable: bool    # 운영 개선으로 이어질 수 있는 지적인가
    summary: str        # 한 줄 요약 (내부용)


def blocked_by(text: str) -> str | None:
    for kw in REVIEW_BLOCK_KEYWORDS:
        if kw in text:
            return kw
    return None


def cmd_add(args) -> None:
    text = args.text
    hit = blocked_by(text)

    analysis = None
    if not hit:
        client = get_client()
        try:
            res = client.messages.parse(
                model=MODEL_VOLUME,
                max_tokens=2000,
                system=cached_system(
                    system_prompt()
                    + "\n# 분류 규칙\n"
                    f"- category 는 반드시 다음 중 하나: {', '.join(CATEGORIES)}\n"
                    "- sentiment 는 반드시 긍정 / 중립 / 부정 중 하나\n"
                    "- actionable 은 운영자가 고칠 수 있는 지적이 있으면 true\n"
                ),
                messages=[{"role": "user", "content": f"리뷰: {text}"}],
                output_format=ReviewAnalysis,
            )
        except Exception as e:  # noqa: BLE001
            handle_api_error(e)
            raise
        analysis = res.parsed_output

    rec = append("reviews", {
        "date": parse_date(args.date).isoformat(),
        "platform": args.platform,
        "rating": args.rating,
        "text": text,
        "sentiment": analysis.sentiment if analysis else "확인필요",
        "category": analysis.category if analysis else "확인필요",
        "actionable": analysis.actionable if analysis else True,
        "summary": analysis.summary if analysis else f"[자동분류 차단: '{hit}']",
        "blocked": bool(hit),
        "replied": False,
    })

    print(f"등록됨 (#{rec['id']}) — {args.platform} / {args.rating}점")
    if hit:
        print(f"\n※ '{hit}' 이(가) 포함되어 자동 분류·답글 생성을 차단했습니다.")
        print("   공개 답글은 담당자가 직접 작성하십시오. 안전·위생·분쟁 관련 리뷰에")
        print("   잘못된 답글이 올라가면 되돌릴 수 없습니다.")
    else:
        print(f"  분류: {rec['sentiment']} / {rec['category']} / 개선여지 {'있음' if rec['actionable'] else '없음'}")
        print(f"  요약: {rec['summary']}")
        print(f"\n답글 초안: python3 review_agent.py reply {rec['id']}")


def cmd_reply(args) -> None:
    rec = next((r for r in load("reviews") if r["id"] == args.id), None)
    if rec is None:
        raise SystemExit(f"오류: id={args.id} 인 리뷰가 없습니다.")
    if rec["blocked"]:
        raise SystemExit(
            f"이 리뷰(#{rec['id']})는 안전·위생·분쟁 관련으로 분류되어 자동 답글을 만들지 않습니다.\n"
            f"담당자가 직접 작성하십시오.\n\n리뷰 내용: {rec['text']}"
        )

    prompt = (
        f"# 리뷰\n플랫폼: {rec['platform']} / 평점: {rec['rating']}점\n"
        f"분류: {rec['sentiment']} / {rec['category']}\n내용: {rec['text']}\n\n"
        "# 요청\n공개 답글 초안을 작성하십시오.\n\n"
        "규칙:\n"
        "- 2~4문장. 짧고 담백하게.\n"
        "- 지적된 내용이 있으면 인정하고 무엇을 바꿀지 구체적으로 씁니다.\n"
        "  다만 확정할 수 없는 개선은 약속하지 말고 '검토하겠다' 수준으로 씁니다.\n"
        "- 변명하거나 반박하지 마십시오. 다른 방문객이 함께 읽는 글입니다.\n"
        "- 보상·환불·할인을 제시하지 마십시오.\n"
        "- 정형화된 인사말('소중한 리뷰 감사합니다')로 시작하지 마십시오."
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

    print(f"# 답글 초안 (리뷰 #{rec['id']})\n")
    print(text_of(response))
    print("\n" + "-" * 60)
    print("※ 초안입니다. 확인 후 직접 게시하고 `review_agent.py done <id>` 로 표시하세요.")


def cmd_done(args) -> None:
    from store import update
    rec = update("reviews", args.id, replied=True)
    print(f"답글 완료 표시 (#{rec['id']})")


def cmd_stats(args) -> None:
    """누적 리뷰 패턴. API 불필요."""
    rows = load("reviews")
    if not rows:
        raise SystemExit("등록된 리뷰가 없습니다.")

    print(f"# 리뷰 분석 (총 {len(rows)}건)\n")
    ratings = [r["rating"] for r in rows if r["rating"]]
    if ratings:
        print(f"평균 평점: {sum(ratings)/len(ratings):.2f}점 ({len(ratings)}건)\n")

    for label, key in [("감성", "sentiment"), ("분류", "category"), ("플랫폼", "platform")]:
        c = Counter(r[key] for r in rows)
        line = " / ".join(f"{k} {v}건" for k, v in c.most_common())
        print(f"{label}: {line}")

    negative = [r for r in rows if r["sentiment"] == "부정" and r["actionable"]]
    if negative:
        print(f"\n## 개선 여지가 있는 부정 리뷰 ({len(negative)}건)")
        for r in negative[-10:]:
            print(f"- [{r['category']}] {r['summary']} ({r['date']}, {r['platform']})")

    pending = [r for r in rows if not r["replied"]]
    blocked = [r for r in rows if r["blocked"] and not r["replied"]]
    if pending:
        print(f"\n미답변: {len(pending)}건" + (f" (그중 담당자 직접 작성 필요 {len(blocked)}건)" if blocked else ""))


def main() -> None:
    p = argparse.ArgumentParser(description="리뷰 모니터링·대응")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="리뷰 등록·분류")
    a.add_argument("text", help="리뷰 본문")
    a.add_argument("-p", "--platform", choices=PLATFORMS, default="네이버")
    a.add_argument("-r", "--rating", type=int, default=0, help="평점 (1~5, 없으면 0)")
    a.add_argument("-d", "--date", help="작성일 YYYY-MM-DD (기본: 오늘)")
    a.set_defaults(func=cmd_add)

    rp = sub.add_parser("reply", help="답글 초안 작성")
    rp.add_argument("id", type=int)
    rp.set_defaults(func=cmd_reply)

    dn = sub.add_parser("done", help="답글 완료 표시 (API 불필요)")
    dn.add_argument("id", type=int)
    dn.set_defaults(func=cmd_done)

    st = sub.add_parser("stats", help="누적 패턴 분석 (API 불필요)")
    st.set_defaults(func=cmd_stats)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
