"""로컬 JSON 저장소.

Tier 2 에이전트는 시간에 걸친 상태(점검 이력, 민원 처리, 일별 실적)를
다루므로 저장이 필요하다. DB를 쓸 규모가 아니라 JSON 파일로 충분하다.

파일은 `data/` 에 쌓이며, 백업은 이 폴더만 복사하면 된다.
"""

import json
import shutil
from datetime import date, datetime
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"


def _path(name: str) -> Path:
    DATA_DIR.mkdir(exist_ok=True)
    return DATA_DIR / f"{name}.json"


def load(name: str) -> list[dict]:
    p = _path(name)
    if not p.exists():
        return []
    try:
        with p.open(encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise SystemExit(
            f"오류: {p} 파일이 손상되었습니다 ({e}).\n"
            f"백업본이 있다면 복구하고, 없다면 파일을 지운 뒤 다시 시작하세요."
        ) from e


def save(name: str, records: list[dict]) -> None:
    """기존 파일을 .bak 으로 남기고 저장한다. 점검·민원 기록은 유실되면 안 된다."""
    p = _path(name)
    if p.exists():
        shutil.copy2(p, p.with_suffix(".json.bak"))
    tmp = p.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    tmp.replace(p)   # 원자적 교체 — 쓰다가 죽어도 원본이 남는다


def append(name: str, record: dict) -> dict:
    records = load(name)
    record.setdefault("id", (max((r.get("id", 0) for r in records), default=0)) + 1)
    record.setdefault("created_at", datetime.now().isoformat(timespec="seconds"))
    records.append(record)
    save(name, records)
    return record


def update(name: str, record_id: int, **fields) -> dict:
    records = load(name)
    for r in records:
        if r.get("id") == record_id:
            r.update(fields)
            save(name, records)
            return r
    raise SystemExit(f"오류: {name} 에 id={record_id} 인 기록이 없습니다.")


def parse_date(s: str | None) -> date:
    """'2026-08-25' 또는 None(오늘)."""
    if not s:
        return date.today()
    try:
        return date.fromisoformat(s)
    except ValueError as e:
        raise SystemExit(f"오류: 날짜 형식이 잘못되었습니다 ('{s}'). YYYY-MM-DD 로 입력하세요.") from e
