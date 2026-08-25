"""에이전트 3 — 단체영업 리스트업·제안서.

평일 비수기를 채우는 사실상 유일한 현실적 수단이 단체 유치다.
경북 북부 생활권의 유치원·초등학교·지역아동센터를 찾아 맞춤 제안서를 만든다.

`research` 는 웹 검색으로 후보 기관을 찾고, `proposal` 은 특정 기관에 보낼
제안서를 작성한다.
"""

import argparse

from client import cached_system, get_client, handle_api_error, report_cache, text_of
from config import MODEL_QUALITY, system_prompt

GROUP_SALES_CONTEXT = """
# 단체영업 배경
- 목표는 **평일 비수기(11~4월, 일평균 24명 수준)** 를 단체 예약으로 채우는 것입니다.
- 주말·성수기는 개인 방문객으로 채워지므로, 단체 제안은 평일 오전~오후를 겨냥합니다.
- 실내 시설이라 날씨에 영향받지 않는다는 점이 체험학습 담당 교사에게 가장 큰 장점입니다.
  (야외 체험학습은 우천 시 취소되지만 이곳은 예정대로 진행됩니다)
- 짚코스터·네트어드벤처는 신체활동 중심이라 체육·창의체험 교과 연계가 가능합니다.
- 이동 거리: 봉화군 내는 근거리, 안동·영주는 시외 이동이 필요하므로
  버스 대절 기준 반나절 일정으로 제안하는 것이 현실적입니다.
"""


def _run_with_server_tools(client, **kwargs):
    """서버 도구(웹 검색)가 pause_turn을 낼 수 있으므로 이어서 진행한다."""
    messages = list(kwargs.pop("messages"))
    while True:
        response = client.messages.create(messages=messages, **kwargs)
        if response.stop_reason != "pause_turn":
            return response
        messages.append({"role": "assistant", "content": response.content})


def research(region: str, kind: str) -> str:
    """지역 내 후보 기관을 웹에서 찾아 정리한다."""
    client = get_client()
    prompt = (
        f"{region} 지역의 {kind} 목록을 웹에서 찾아 정리하십시오.\n\n"
        "각 기관에 대해 이름, 소재지(읍면동까지), 대략적인 규모(원아·학생 수)를 표로 정리하고,\n"
        "본 시설까지의 접근성(같은 군 / 시외 이동 필요)을 한 줄로 덧붙이십시오.\n"
        "확인되지 않은 연락처나 담당자명은 절대 추측해서 적지 마십시오.\n"
        "검색으로 확인되지 않은 항목은 '확인 필요'로 표시하십시오."
    )
    try:
        response = _run_with_server_tools(
            client,
            model=MODEL_QUALITY,
            max_tokens=16000,
            system=cached_system(system_prompt() + GROUP_SALES_CONTEXT),
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            tools=[{"type": "web_search_20260209", "name": "web_search", "max_uses": 8}],
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:  # noqa: BLE001
        handle_api_error(e)
        raise

    out = text_of(response)
    print(out)
    report_cache(response, "research")
    return out


def proposal(institution: str, kind: str, headcount: str, notes: str = "") -> str:
    """특정 기관에 보낼 제안서를 작성한다."""
    client = get_client()
    prompt = (
        f"# 제안 대상\n"
        f"- 기관명: {institution}\n"
        f"- 유형: {kind}\n"
        f"- 예상 인원: {headcount}\n"
    )
    if notes:
        prompt += f"- 참고사항: {notes}\n"
    prompt += (
        "\n# 요청\n"
        "위 기관의 체험학습 담당자에게 보낼 제안서를 마크다운으로 작성하십시오.\n\n"
        "구성:\n"
        "1. 인사 및 제안 배경 (3문장 이내)\n"
        "2. 시설 소개 — 해당 연령대에 왜 맞는지 중심으로\n"
        "3. 추천 프로그램 구성 — 반나절 기준 시간표 형태\n"
        "4. 안전관리 — 기구별 안전요원 배치, 보험 가입 사실을 담담하게 기술\n"
        "   (안전을 과장하거나 '절대 안전' 같은 단정 표현은 쓰지 말 것)\n"
        "5. 문의 안내\n\n"
        "요금은 확정 전이므로 '단체 요금은 협의 후 안내' 로 처리하십시오.\n"
        "담당자 이름이나 연락처를 지어내지 마십시오."
    )
    try:
        response = client.messages.create(
            model=MODEL_QUALITY,
            max_tokens=16000,
            system=cached_system(system_prompt() + GROUP_SALES_CONTEXT),
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception as e:  # noqa: BLE001
        handle_api_error(e)
        raise

    out = text_of(response)
    print(out)
    report_cache(response, "proposal")
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="단체영업 리스트업·제안서")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("research", help="지역 내 후보 기관 조사")
    r.add_argument("region", help="예: '경북 봉화군', '경북 안동시'")
    r.add_argument("-k", "--kind", default="유치원 및 초등학교", help="기관 유형")

    pr = sub.add_parser("proposal", help="기관별 제안서 작성")
    pr.add_argument("institution", help="기관명")
    pr.add_argument("-k", "--kind", default="초등학교", help="기관 유형")
    pr.add_argument("-n", "--headcount", default="30~40명", help="예상 인원")
    pr.add_argument("-x", "--notes", default="", help="참고사항")

    args = p.parse_args()
    if args.cmd == "research":
        research(args.region, args.kind)
    else:
        proposal(args.institution, args.kind, args.headcount, args.notes)


if __name__ == "__main__":
    main()
