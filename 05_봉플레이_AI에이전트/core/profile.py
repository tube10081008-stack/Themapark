"""기준정보 계약(site_profile.json) 로더와 사용 규칙.

에이전트는 사업 상수를 코드에 두지 않고 이 계약만 읽는다. 값마다 출처와 확인 상태가 있다.

    confirmed       대표 결정 또는 1차 자료로 확인, 벤 검토 PR 로 병합된 값
    system_default  운영시스템 코드·DB 기본값. 현장 확정 여부 미확인
    unverified      미정이거나 출처 불명확
    unresolved      출처끼리 서로 달라 결정이 필요한 값

사용 규칙 (BEN-004):
- 고객에게 나가는 글에는 confirmed 만 쓴다. 나머지는 "확정 후 안내".
- 내부 분석에는 confirmed·system_default 를 쓰되 system_default 는 표시한다.
- unverified·unresolved 는 어디에도 쓰지 않는다.

이 모듈은 파일을 읽기만 한다. 쓰기·디렉터리 생성·네트워크 호출이 없다.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

SCHEMA_VERSION = 1
DEFAULT_PATH = Path(__file__).resolve().parent.parent / "site_profile.json"

STATUSES = ("confirmed", "system_default", "unverified", "unresolved")
FIELD_KEYS = {
    "value", "unit", "scope", "status", "source",
    "confirmed_by", "confirmed_at", "effective_from", "note", "price_check",
}
SOURCE_KEYS = {"path", "item", "revision"}
PENDING_TEXT = "확정 후 안내"
SQM_PER_PYEONG = 3.305785


class ProfileError(Exception):
    """계약 파일이 규칙을 어겼다. 조용히 넘어가지 않는다."""


@dataclass(frozen=True)
class Field:
    key: str
    value: object
    status: str
    source: dict
    unit: str | None = None
    scope: str | None = None
    confirmed_by: str | None = None
    confirmed_at: str | None = None
    effective_from: str | None = None
    note: str | None = None
    price_check: dict | None = None


def _iso_date(s: object, where: str) -> None:
    if not isinstance(s, str):
        raise ProfileError(f"{where}: 날짜는 YYYY-MM-DD 문자열이어야 합니다")
    try:
        date.fromisoformat(s)
    except ValueError as e:
        raise ProfileError(f"{where}: 날짜 형식 오류 {s!r}") from e


def _validate_field(key: str, raw: object) -> Field:
    if not isinstance(raw, dict):
        raise ProfileError(f"{key}: 객체여야 합니다")
    unknown = set(raw) - FIELD_KEYS
    if unknown:
        raise ProfileError(f"{key}: 알 수 없는 항목 {sorted(unknown)}")
    if "value" not in raw:
        raise ProfileError(f"{key}: value 가 없습니다 (미정이면 null 로 명시)")
    status = raw.get("status")
    if status not in STATUSES:
        raise ProfileError(f"{key}: status 는 {STATUSES} 중 하나여야 합니다 (현재 {status!r})")

    src = raw.get("source")
    if not isinstance(src, dict) or set(src) - SOURCE_KEYS:
        raise ProfileError(f"{key}: source 는 path/item/revision 만 갖는 객체여야 합니다")
    if not src.get("path") or not src.get("item"):
        raise ProfileError(f"{key}: source.path 와 source.item 은 비울 수 없습니다")

    value = raw["value"]
    if status in ("confirmed", "system_default") and value is None:
        raise ProfileError(f"{key}: {status} 인데 value 가 null 입니다")
    if status == "confirmed":
        for req in ("confirmed_by", "confirmed_at"):
            if not raw.get(req):
                raise ProfileError(f"{key}: confirmed 는 {req} 가 필요합니다")
        if not src.get("revision"):
            raise ProfileError(f"{key}: confirmed 는 source.revision(커밋 SHA 또는 문서 판본)이 필요합니다")
        _iso_date(raw["confirmed_at"], f"{key}.confirmed_at")
        if key.startswith(("price.", "discount.")) and not raw.get("price_check"):
            raise ProfileError(f"{key}: confirmed 요금·할인은 price_check 대조 규칙이 필요합니다")
    if raw.get("effective_from") is not None:
        _iso_date(raw["effective_from"], f"{key}.effective_from")

    return Field(
        key=key, value=value, status=status, source=dict(src),
        unit=raw.get("unit"), scope=raw.get("scope"),
        confirmed_by=raw.get("confirmed_by"), confirmed_at=raw.get("confirmed_at"),
        effective_from=raw.get("effective_from"), note=raw.get("note"),
        price_check=raw.get("price_check"),
    )


class Profile:
    def __init__(self, fields: dict[str, Field], path: Path | None = None):
        self._fields = fields
        self.path = path

    # ── 조회 ────────────────────────────────────────────────────
    def field(self, key: str) -> Field | None:
        return self._fields.get(key)

    def keys(self) -> list[str]:
        return sorted(self._fields)

    def with_status(self, status: str) -> list[Field]:
        return [f for k, f in sorted(self._fields.items()) if f.status == status]

    def customer_value(self, key: str):
        """고객에게 나가는 글용. confirmed 가 아니면 None."""
        f = self._fields.get(key)
        return f.value if f is not None and f.status == "confirmed" else None

    def internal_value(self, key: str):
        """내부 분석용. (값, 상태) 또는 None. unverified·unresolved·누락은 None."""
        f = self._fields.get(key)
        if f is None or f.status not in ("confirmed", "system_default"):
            return None
        return f.value, f.status

    def customer_text(self, key: str, fmt: str = "{}") -> str:
        v = self.customer_value(key)
        return PENDING_TEXT if v is None else fmt.format(v)


def load_profile(path: str | Path | None = None) -> Profile:
    p = Path(path) if path is not None else DEFAULT_PATH
    try:
        with p.open(encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError as e:
        raise ProfileError(f"계약 파일이 없습니다: {p}") from e
    except json.JSONDecodeError as e:
        raise ProfileError(f"계약 파일 JSON 오류: {p} ({e})") from e

    if not isinstance(data, dict):
        raise ProfileError("최상위는 객체여야 합니다")
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ProfileError(
            f"schema_version 불일치: 파일 {data.get('schema_version')!r}, 코드 {SCHEMA_VERSION}")
    raw_fields = data.get("fields")
    if not isinstance(raw_fields, dict) or not raw_fields:
        raise ProfileError("fields 가 비어 있습니다")

    fields = {k: _validate_field(k, v) for k, v in raw_fields.items()}
    return Profile(fields, p)


# ── 시설 설명 (confirmed 값으로만 생성) ─────────────────────────────

def _topic_particle(word: str) -> str:
    """은/는 — 마지막 글자 받침 유무로 고른다. 한글이 아니면 '은(는)'."""
    last = word.rstrip()[-1:] if word.strip() else ""
    if not ("가" <= last <= "힣"):
        return "은(는)"
    return "은" if (ord(last) - 0xAC00) % 28 else "는"


def _subject_particle(word: str) -> str:
    last = word.rstrip()[-1:] if word.strip() else ""
    if not ("가" <= last <= "힣"):
        return "이(가)"
    return "이" if (ord(last) - 0xAC00) % 28 else "가"


def facility_description(profile: Profile) -> str:
    """confirmed 값만으로 시설 설명문을 만든다.

    모르는 사실(높이·길이·운영 조건 등)은 보충하지 않는다. confirmed 가 아닌 항목은
    문장에서 빠지거나 '확정 후 안내'로 표시된다.
    """
    name = profile.customer_value("facility.name")
    road = profile.customer_value("address.road")
    play_m2 = profile.customer_value("area.play_space_m2")
    outdoor = profile.customer_value("facility.outdoor_attractions")

    subject = name if isinstance(name, str) and name.strip() else "이 시설"
    parts = []
    if road:
        parts.append(f"{subject}{_topic_particle(subject)} {road}에 있는 놀이시설입니다.")
    else:
        parts.append(f"{subject}{_topic_particle(subject)} 놀이시설입니다.")
    if isinstance(play_m2, (int, float)):
        pyeong = round(play_m2 / SQM_PER_PYEONG)
        parts.append(f"실내 놀이공간은 {play_m2:,.1f}㎡(약 {pyeong}평)입니다.")
    if isinstance(outdoor, list) and outdoor and all(isinstance(x, str) for x in outdoor):
        joined = "·".join(outdoor)
        parts.append(f"야외에는 {joined}{_subject_particle(joined)} 있습니다.")
    hours = profile.customer_value("hours.open")
    if hours is None:
        parts.append(f"운영시간은 {PENDING_TEXT}드립니다.")
    return " ".join(parts)


_KEY_RE = re.compile(r"^[a-z_]+(\.[a-z0-9_]+)+$")


def lint_keys(profile: Profile) -> list[str]:
    """키 이름 규칙 위반 목록 (소문자·점 구분)."""
    return [k for k in profile.keys() if not _KEY_RE.match(k)]
