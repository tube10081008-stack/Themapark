"""에이전트 1 — 마케팅 콘텐츠 생성.

비수기 일평균 24명을 채우는 것이 이 사업의 사활이고, 5명 조직으로는
블로그·SNS 콘텐츠를 지속 생산할 수 없다. 이 에이전트가 그 공백을 메운다.

품질이 곧 방문객 수이므로 Opus를 쓴다.
"""

import argparse

from client import cached_system, get_client, handle_api_error, report_cache
from config import MODEL_QUALITY, system_prompt

CHANNELS = {
    "blog": """\
네이버 블로그 포스트를 씁니다.
- 900~1,400자. 소제목으로 단락을 나누고, 문단은 짧게 끊습니다.
- 검색 유입을 고려해 '봉화 아이와 갈 만한 곳', '봉화 실내 놀이터',
  '안동 근교 키즈' 같은 표현을 억지스럽지 않게 녹입니다.
- 실제 방문 경험처럼 쓰되, 겪지 않은 일을 지어내지 마십시오.
- 마지막에 위치와 문의 안내를 한 줄로 정리합니다.""",
    "instagram": """\
인스타그램 피드 캡션을 씁니다.
- 3~5문장. 첫 문장에서 시선을 잡습니다.
- 이모지는 문장당 최대 1개, 과하지 않게.
- 해시태그는 마지막에 10~15개. 지역(#봉화 #안동 #영주)과
  타겟(#아이와가볼만한곳 #실내놀이터)을 섞습니다.""",
    "cafe": """\
지역 맘카페에 올릴 글을 씁니다.
- 홍보 티가 나면 역효과입니다. 정보 공유하듯 담백하게 씁니다.
- 500~800자. 존댓말, 과장 없는 어투.
- '비 오는 날 갈 데 없어서 찾아봤다' 같은 실제 고민에서 출발합니다.""",
    "sms": """\
재방문 유도 문자/알림톡을 씁니다.
- 90자 이내. 핵심 혜택 하나만 담습니다.
- 수신거부 문구 자리를 [수신거부] 로 표시해 둡니다.""",
}


def generate(topic: str, channel: str, context: str = "", stream: bool = True) -> str:
    client = get_client()

    guide = CHANNELS[channel]
    user_msg = f"# 작성 요청\n채널: {channel}\n주제: {topic}\n"
    if context:
        user_msg += f"추가 맥락: {context}\n"
    user_msg += f"\n# 채널별 작성 규칙\n{guide}\n\n위 규칙에 맞는 콘텐츠 본문만 출력하십시오."

    kwargs = dict(
        model=MODEL_QUALITY,
        max_tokens=8000,
        system=cached_system(system_prompt()),
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        messages=[{"role": "user", "content": user_msg}],
    )

    if stream:
        with client.messages.stream(**kwargs) as s:
            for event in s.text_stream:
                print(event, end="", flush=True)
            print()
            response = s.get_final_message()
    else:
        response = client.messages.create(**kwargs)
        print("\n".join(b.text for b in response.content if b.type == "text"))

    report_cache(response, "content")
    return "\n".join(b.text for b in response.content if b.type == "text")


def main() -> None:
    p = argparse.ArgumentParser(description="마케팅 콘텐츠 생성")
    p.add_argument("topic", help="주제 (예: '비 오는 날 아이와 갈 만한 곳')")
    p.add_argument("-c", "--channel", choices=list(CHANNELS), default="blog")
    p.add_argument("-x", "--context", default="", help="추가 맥락 (예: '은어축제 기간 연계')")
    p.add_argument("--no-stream", action="store_true")
    args = p.parse_args()

    try:
        generate(args.topic, args.channel, args.context, stream=not args.no_stream)
    except Exception as e:  # noqa: BLE001 — handle_api_error가 미처리 예외는 재발생시킨다
        handle_api_error(e)


if __name__ == "__main__":
    main()
