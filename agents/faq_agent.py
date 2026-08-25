"""에이전트 2 — 고객문의 응대.

운영시간·요금·연령제한·주차 같은 반복 문의를 흡수해서, 매표 담당이
전화 받느라 발권을 못 하는 상황을 막는 것이 목적이다.

안전·사고·환불·민원은 **모델 판단에 맡기지 않고** 키워드 단계에서 먼저
차단해 사람에게 넘긴다. 개인명의 무한책임 구조에서 이 판단을 자동화하면
안 된다.
"""

import argparse
import sys

from pydantic import BaseModel

from client import cached_system, get_client, handle_api_error
from config import MODEL_VOLUME, system_prompt

# 이 단어가 하나라도 있으면 API를 부르지 않고 즉시 사람에게 넘긴다.
ESCALATE_KEYWORDS = [
    # 안전·사고
    "사고", "다쳤", "다침", "부상", "골절", "응급", "구급", "119",
    "안전한가", "위험", "추락", "떨어졌",
    # 분쟁·금전
    "환불", "취소해", "보상", "배상", "변상", "소송", "고소", "신고할",
    # 민원
    "민원", "불만", "항의", "책임자", "사장", "군청",
]

ESCALATION_MESSAGE = (
    "문의 주셔서 감사합니다. 해당 내용은 담당자가 직접 확인 후 안내드리겠습니다.\n"
    "빠른 처리를 위해 연락 가능한 번호를 남겨 주시면 담당자가 연락드리겠습니다."
)


class FaqAnswer(BaseModel):
    can_answer: bool   # 시설 정보만으로 확실히 답할 수 있는가
    answer: str        # 고객에게 보낼 답변 (can_answer=False면 무시)
    reason: str        # can_answer=False일 때 왜 못 답하는지 (내부용)


def needs_human(question: str) -> str | None:
    """사람이 받아야 하는 문의면 사유 키워드를 돌려준다."""
    for kw in ESCALATE_KEYWORDS:
        if kw in question:
            return kw
    return None


def answer(question: str, verbose: bool = False) -> tuple[str, bool]:
    """(고객에게 보낼 문구, 사람에게 넘겨야 하는지) 를 돌려준다."""
    hit = needs_human(question)
    if hit:
        if verbose:
            print(f"  [차단] 키워드 '{hit}' — API 호출 없이 사람에게 이관", file=sys.stderr)
        return ESCALATION_MESSAGE, True

    client = get_client()
    try:
        response = client.messages.parse(
            model=MODEL_VOLUME,
            max_tokens=2000,
            system=cached_system(
                system_prompt()
                + "\n# 응대 규칙\n"
                "- 고객에게 보내는 메시지는 3문장 이내, 존댓말로 씁니다.\n"
                "- 시설 정보에 없는 내용은 절대 추측하지 말고 can_answer=false로 표시하십시오.\n"
                "- 확정되지 않은 요금·운영시간을 임의로 만들어내지 마십시오.\n"
            ),
            messages=[{"role": "user", "content": f"고객 문의: {question}"}],
            output_format=FaqAnswer,
        )
    except Exception as e:  # noqa: BLE001
        handle_api_error(e)
        raise  # handle_api_error가 종료하지만 타입 체커를 위해

    parsed = response.parsed_output
    if verbose:
        u = response.usage
        print(
            f"  [faq] 캐시읽기 {u.cache_read_input_tokens} / 출력 {u.output_tokens}",
            file=sys.stderr,
        )

    if not parsed.can_answer:
        if verbose:
            print(f"  [이관] {parsed.reason}", file=sys.stderr)
        return ESCALATION_MESSAGE, True
    return parsed.answer, False


def main() -> None:
    p = argparse.ArgumentParser(description="고객문의 응대")
    p.add_argument("question", nargs="?", help="문의 내용 (생략하면 대화형)")
    p.add_argument("-v", "--verbose", action="store_true", help="내부 판단 근거 표시")
    args = p.parse_args()

    if args.question:
        reply, escalated = answer(args.question, args.verbose)
        print(reply)
        if escalated:
            print("\n※ 담당자 확인이 필요한 문의입니다.", file=sys.stderr)
        return

    print("문의를 입력하세요. (빈 줄 입력 시 종료)")
    while True:
        try:
            q = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not q:
            break
        reply, escalated = answer(q, args.verbose)
        print(f"\n{reply}")
        if escalated:
            print("※ 담당자 확인 필요", file=sys.stderr)


if __name__ == "__main__":
    main()
