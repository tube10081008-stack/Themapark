"""공용 Anthropic 클라이언트와 에러 처리."""

import sys

import anthropic

_client: anthropic.Anthropic | None = None


def get_client() -> anthropic.Anthropic:
    """싱글턴 클라이언트. ANTHROPIC_API_KEY 또는 `ant auth login` 프로필을 사용한다."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def cached_system(text: str) -> list[dict]:
    """시스템 프롬프트를 캐시 대상 블록으로 감싼다.

    세 에이전트가 동일한 접두부를 쓰므로, 하루 안에 반복 호출하면
    두 번째 요청부터 입력 토큰 비용이 크게 줄어든다.
    """
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def text_of(response) -> str:
    """응답에서 텍스트 블록만 이어붙인다. thinking 블록은 건너뛴다."""
    return "\n".join(b.text for b in response.content if b.type == "text").strip()


def report_cache(response, label: str = "") -> None:
    """캐시가 실제로 걸렸는지 확인용. 반복 호출인데 read가 0이면 접두부가 흔들린 것."""
    u = response.usage
    print(
        f"  [{label}] 입력 {u.input_tokens} / 캐시기록 {u.cache_creation_input_tokens}"
        f" / 캐시읽기 {u.cache_read_input_tokens} / 출력 {u.output_tokens}",
        file=sys.stderr,
    )


def handle_api_error(e: Exception) -> None:
    """사람이 읽을 수 있는 메시지로 바꿔 출력하고 종료한다."""
    if isinstance(e, anthropic.AuthenticationError):
        msg = "API 키가 잘못되었습니다. ANTHROPIC_API_KEY를 확인하세요."
    elif isinstance(e, anthropic.RateLimitError):
        retry = e.response.headers.get("retry-after", "60")
        msg = f"요청이 몰렸습니다. {retry}초 후 다시 시도하세요."
    elif isinstance(e, anthropic.BadRequestError):
        msg = f"요청이 잘못되었습니다: {e.message}"
    elif isinstance(e, anthropic.APIStatusError):
        msg = (
            f"서버 오류({e.status_code}). 잠시 후 재시도하세요."
            if e.status_code >= 500
            else f"API 오류: {e.message}"
        )
    elif isinstance(e, anthropic.APIConnectionError):
        msg = "네트워크 연결에 실패했습니다."
    else:
        raise e
    print(f"오류: {msg}", file=sys.stderr)
    sys.exit(1)
