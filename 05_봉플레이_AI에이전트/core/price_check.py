"""confirmed 요금·할인이 고객 고지와 운영 카탈로그에 그대로 있는지 대조한다.

BEN-004 결정 1:
- JS 를 실행하지 않는다. 범위를 좁힌 정적 추출만 한다.
- 키 중복·형식 변경·추출 실패·값/조건 불일치는 **실패** 다. 경고로 통과시키지 않는다.
- profile 값을 자동으로 고치거나 confirmed 로 올리지 않는다. 읽고 판정만 한다.

대조 대상 (저장소 루트 기준, 읽기 전용):
- 카탈로그: 01_봉플레이_운영시스템/assets/bongplay-id.js 의 PRODUCT_CATALOG, DISCOUNT_RULES
- 고객 고지: 01_봉플레이_운영시스템/pages/booking.html 의 section#sectionPricing

    python -m core.price_check      (05_봉플레이_AI에이전트 폴더에서) → 실패가 있으면 종료코드 1
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

from .profile import Profile, load_profile

REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPO_ROOT / "01_봉플레이_운영시스템" / "assets" / "bongplay-id.js"
NOTICE_PATH = REPO_ROOT / "01_봉플레이_운영시스템" / "pages" / "booking.html"

SPEC_KEYS = {
    "catalog_id", "discount_rule", "notice_title", "notice_field",
    "notice_list_matches_catalog", "notice_label",
}


class ExtractError(Exception):
    """원본 형식이 예상과 다르거나 값이 모호하다."""


@dataclass(frozen=True)
class CheckResult:
    key: str
    ok: bool
    message: str


# ── JS 정적 추출 ───────────────────────────────────────────────────

def _array_block(js: str, name: str) -> str:
    """`const NAME = [` 부터 짝이 맞는 `]` 까지. 문자열·주석 안의 괄호는 무시한다."""
    decl = re.findall(rf"\bconst\s+{re.escape(name)}\s*=\s*\[", js)
    if len(decl) != 1:
        raise ExtractError(f"{name} 선언이 {len(decl)}개입니다 (정확히 1개여야 함)")
    start = re.search(rf"\bconst\s+{re.escape(name)}\s*=\s*\[", js).end()
    depth, i, n = 1, start, len(js)
    while i < n:
        c = js[i]
        if c in "'\"`":
            j = i + 1
            while j < n and js[j] != c:
                j += 2 if js[j] == "\\" else 1
            if j >= n:
                raise ExtractError(f"{name}: 닫히지 않은 문자열")
            i = j + 1
            continue
        if js.startswith("//", i):
            nl = js.find("\n", i)
            i = n if nl < 0 else nl + 1
            continue
        if js.startswith("/*", i):
            end = js.find("*/", i + 2)
            if end < 0:
                raise ExtractError(f"{name}: 닫히지 않은 주석")
            i = end + 2
            continue
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return js[start:i]
        i += 1
    raise ExtractError(f"{name}: 배열이 닫히지 않았습니다")


def _objects(block: str, name: str) -> list[str]:
    """배열 최상위의 `{ ... }` 객체 텍스트 목록. 중첩 객체가 있으면 형식 변경으로 본다."""
    objs, depth, cur = [], 0, None
    for i, c in enumerate(block):
        if c == "{":
            depth += 1
            if depth == 1:
                cur = i
            elif depth > 1:
                raise ExtractError(f"{name}: 중첩 객체 발견 — 형식이 바뀌었습니다")
        elif c == "}":
            depth -= 1
            if depth < 0:
                raise ExtractError(f"{name}: 괄호 짝 오류")
            if depth == 0:
                objs.append(block[cur:i + 1])
    if depth != 0:
        raise ExtractError(f"{name}: 괄호 짝 오류")
    if not objs:
        raise ExtractError(f"{name}: 항목이 없습니다")
    return objs


def _one(pattern: str, text: str, what: str) -> str:
    found = re.findall(pattern, text)
    if len(found) != 1:
        raise ExtractError(f"{what}: {len(found)}개 발견 (정확히 1개여야 함) — {text[:60]!r}")
    return found[0]


def _keyed_values(js: str, name: str, value_field: str, number: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for obj in _objects(_array_block(js, name), name):
        oid = _one(r"\bid:\s*'([^']+)'", obj, f"{name} id")
        val = _one(rf"\b{value_field}:\s*({number})\s*[,}}]", obj, f"{name}.{oid}.{value_field}")
        if oid in out:
            raise ExtractError(f"{name}: id 중복 {oid!r}")
        out[oid] = val
    return out


def catalog_prices(js: str) -> dict[str, int]:
    return {k: int(v) for k, v in _keyed_values(js, "PRODUCT_CATALOG", "list_price", r"\d+").items()}


def discount_rates(js: str) -> dict[str, float]:
    return {k: float(v) for k, v in _keyed_values(js, "DISCOUNT_RULES", "rate", r"\d+(?:\.\d+)?").items()}


# ── 고지 HTML 추출 ─────────────────────────────────────────────────

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class _Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.children, self.parent = tag, dict(attrs), [], parent

    def classes(self) -> list[str]:
        return (self.attrs.get("class") or "").split()

    def text(self) -> str:
        parts = []
        for ch in self.children:
            parts.append(ch if isinstance(ch, str) else ch.text())
        return " ".join(" ".join(parts).split())

    def own_text(self) -> str:
        return " ".join(" ".join(ch for ch in self.children if isinstance(ch, str)).split())

    def walk(self):
        for ch in self.children:
            if isinstance(ch, _Node):
                yield ch
                yield from ch.walk()


class _Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root", {}, None)
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, attrs, self.cur)
        self.cur.children.append(node)
        if tag not in _VOID:
            self.cur = node

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        if data.strip():
            self.cur.children.append(data)


def _won(text: str, what: str) -> int:
    m = re.fullmatch(r"(?:정가\s*)?([\d,]+)원", text.strip())
    if not m:
        raise ExtractError(f"{what}: 금액 형식이 아닙니다 {text!r}")
    return int(m.group(1).replace(",", ""))


def _pricing_section(html: str) -> _Node:
    tree = _Tree()
    tree.feed(html)
    secs = [n for n in tree.root.walk() if n.attrs.get("id") == "sectionPricing"]
    if len(secs) != 1:
        raise ExtractError(f"section#sectionPricing 이 {len(secs)}개입니다")
    return secs[0]


def notice_items(html: str) -> dict[str, dict]:
    """고지 품목: 제목 → {sale, list}. 제목 중복·금액 형식 오류는 실패."""
    sec = _pricing_section(html)
    items: dict[str, dict] = {}
    for node in sec.walk():
        if node.tag != "div" or "py-2.5" not in node.classes():
            continue
        heads = [n for n in node.walk() if "font-extrabold" in n.classes()]
        if len(heads) != 1:
            raise ExtractError(f"품목 제목 요소가 {len(heads)}개입니다")
        spans = [c for c in heads[0].children if isinstance(c, _Node) and c.tag == "span"]
        title = spans[0].text() if spans else heads[0].own_text()
        strongs = [n for n in node.walk() if n.tag == "strong"]
        if len(strongs) != 1:
            raise ExtractError(f"{title!r}: 판매가(strong)가 {len(strongs)}개입니다")
        lists = [n for n in node.walk() if "line-through" in n.classes()]
        if len(lists) > 1:
            raise ExtractError(f"{title!r}: 정가 표기가 {len(lists)}개입니다")
        if not title:
            raise ExtractError("제목이 빈 품목이 있습니다")
        if title in items:
            raise ExtractError(f"고지 품목 제목 중복: {title!r}")
        items[title] = {
            "sale": _won(strongs[0].text(), f"{title} 판매가"),
            "list": _won(lists[0].text(), f"{title} 정가") if lists else None,
        }
    if not items:
        raise ExtractError("고지 품목을 하나도 찾지 못했습니다")
    return items


def notice_percent(html: str, label: str) -> float:
    text = _pricing_section(html).text()
    found = re.findall(rf"{re.escape(label)}\s*(\d+)\s*%", text)
    if len(found) != 1:
        raise ExtractError(f"고지에서 '{label} N%' 가 {len(found)}개 발견")
    return int(found[0]) / 100


# ── 대조 ───────────────────────────────────────────────────────────

def _check_field(key, value, spec, prices, rates, notices, html) -> str | None:
    """실패 사유 문자열, 통과면 None."""
    unknown = set(spec) - SPEC_KEYS
    if unknown:
        return f"price_check 에 알 수 없는 항목 {sorted(unknown)}"

    if "notice_label" in spec:  # 할인율
        rule = spec.get("discount_rule")
        if rule not in rates:
            return f"DISCOUNT_RULES 에 {rule!r} 없음"
        notice = notice_percent(html, spec["notice_label"])
        if not (value == rates[rule] == notice):
            return f"불일치: profile {value} / 카탈로그 {rates[rule]} / 고지 {notice}"
        return None

    cid = spec.get("catalog_id")
    if cid not in prices:
        return f"PRODUCT_CATALOG 에 {cid!r} 없음"
    base = prices[cid]
    expected = base
    if spec.get("discount_rule"):
        rule = spec["discount_rule"]
        if rule not in rates:
            return f"DISCOUNT_RULES 에 {rule!r} 없음"
        expected = round(base * (1 - rates[rule]))

    title = spec.get("notice_title")
    if title not in notices:
        return f"고지에 품목 {title!r} 없음"
    field = spec.get("notice_field")
    if field not in ("sale", "list"):
        return f"notice_field 는 sale/list 중 하나여야 함 ({field!r})"
    shown = notices[title][field]
    if shown is None:
        return f"고지 {title!r} 에 {field} 값이 없음"
    if not (value == expected == shown):
        return f"불일치: profile {value} / 카탈로그 기준 {expected} / 고지 {shown}"
    if spec.get("notice_list_matches_catalog"):
        if notices[title]["list"] != base:
            return f"고지 정가 {notices[title]['list']} ≠ 카탈로그 {base}"
    return None


def run_checks(profile: Profile, js: str, html: str) -> list[CheckResult]:
    results: list[CheckResult] = []
    try:
        prices = catalog_prices(js)
        rates = discount_rates(js)
        notices = notice_items(html)
    except ExtractError as e:
        return [CheckResult("(추출)", False, f"추출 실패: {e}")]

    for f in profile.with_status("confirmed"):
        if not f.key.startswith(("price.", "discount.")):
            continue
        try:
            reason = _check_field(f.key, f.value, f.price_check or {}, prices, rates, notices, html)
        except ExtractError as e:
            reason = f"추출 실패: {e}"
        results.append(CheckResult(f.key, reason is None, reason or "고지·카탈로그 일치"))

    # 고지에 새 품목이 생겼는데 계약에 없으면 실패 — 조용히 빠지는 것을 막는다.
    mapped = " ".join(
        (f.source.get("item") or "") for f in (profile.field(k) for k in profile.keys())
        if f.key.startswith(("price.", "discount."))
    )
    for title in notices:
        if f"'{title}'" not in mapped:
            results.append(CheckResult("(고지 품목)", False, f"계약에 없는 고지 품목: {title!r}"))
    return results


def main(argv: list[str] | None = None) -> int:
    profile = load_profile()
    js = CATALOG_PATH.read_text(encoding="utf-8")
    html = NOTICE_PATH.read_text(encoding="utf-8")
    results = run_checks(profile, js, html)
    failed = [r for r in results if not r.ok]
    for r in results:
        print(f"[{'통과' if r.ok else '실패'}] {r.key}: {r.message}")
    pending = profile.with_status("unresolved")
    if pending:
        print("\n결정 필요(unresolved) — 고객용 출력에서 보류:")
        for f in pending:
            print(f"  - {f.key}: {f.note or ''}")
    print(f"\n{len(results) - len(failed)}/{len(results)} 통과")
    return 1 if failed or not results else 0


if __name__ == "__main__":
    sys.exit(main())
