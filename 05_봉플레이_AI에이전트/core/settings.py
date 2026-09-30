"""실행 설정.

모델 ID는 코드에 두지 않는다 (BEN-004 결정 4). 원본 에이전트의 모델 ID들은 연결 계정에서
제공 여부를 확인하지 않았으므로 기본값으로 쓰지 않는다. LLM 을 부르는 명령만 이 함수를
호출하고, 순수 계산·계약 검증·게이트는 모델 없이 동작해야 한다.
"""

import os

MODEL_ENV = "ANTHROPIC_MODEL"


class MissingModelError(SystemExit):
    """ANTHROPIC_MODEL 미설정. SystemExit 이라 CLI 에서는 설명만 남기고 종료된다."""


def require_model() -> str:
    model = os.environ.get(MODEL_ENV, "").strip()
    if not model:
        raise MissingModelError(
            f"{MODEL_ENV} 가 설정되지 않았습니다. 이 명령은 LLM 을 호출하므로 사용할 모델 ID를 "
            f"명시해야 합니다 (예: .env 에 {MODEL_ENV}=... ). 연결 계정에서 제공되는 ID인지 먼저 "
            f"확인하십시오. 순수 계산·검증 명령은 모델 없이 실행됩니다."
        )
    return model
