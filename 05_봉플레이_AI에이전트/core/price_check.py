"""confirmed 요금·할인이 고객 고지와 운영 카탈로그에 그대로 있는지 대조한다.

BEN-004 결정 1 / BEN PR-009 R1·R2:
- JS 를 실행하지 않는다. `core.js_static` 의 제한적 파서로만 읽는다.
- 키 중복(따옴표 키 포함)·형식 변경·추출 실패·값/조건 불일치는 **실패** 다.
- 고지는 CSS 클래스가 아니라 구조로 읽는다. 요금 영역 안에서 품목 카드로 분류되지 않은
  금액·할인율이 있으면 실패다 (새 디자인의 카드가 조용히 빠지는 것을 막는다).
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

from .js_static import ExtractError, read_const_array
from .profile import Profile, load_profile

REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPO_ROOT / "01_봉플레이_운영시스템" / "assets" / "bongplay-id.js"
NOTICE_PATH = REPO_ROOT / "01_봉플레이_운영시스템" / "pages" / "booking.html"

SPEC_KEYS = {
    "catalog_id", "discount_rule", "notice_title", "notice_field",
    "notice_list_matches_catalog", "notice_label", "notice_allowed_text",
}

__all__ = ["ExtractError", "CheckResult", "catalog_prices", "discount_rates", "read_notice",
           "notice_items", "run_checks", "main"]


@dataclass(frozen=True)
class CheckResult:
    key: str
    ok: bool
    message: str


# ── 카탈로그 (JS, 실행 없이) ────────────────────────────────────────

def _keyed(js: str, name: str, field: str, kind) -> dict:
    out: dict = {}
    for n, obj in enumerate(read_const_array(js, name)):
        oid = obj.get("id")
        if not isinstance(oid, str) or not oid:
            raise ExtractError(f"{name}[{n}]: 문자열 id 가 없음")
        if field not in obj:
            raise ExtractError(f"{name}.{oid}: {field} 가 없음")
        val = obj[field]
        if isinstance(val, bool) or not isinstance(val, kind):
            raise ExtractError(f"{name}.{oid}.{field}: 숫자가 아님 {val!r}")
        if oid in out:
            raise ExtractError(f"{name}: id 중복 {oid!r}")
        out[oid] = val
    return out


def catalog_prices(js: str) -> dict[str, int]:
    return _keyed(js, "PRODUCT_CATALOG", "list_price", int)


def discount_rates(js: str) -> dict[str, float]:
    return {k: float(v) for k, v in _keyed(js, "DISCOUNT_RULES", "rate", (int, float)).items()}


# ── 고지 (HTML, 구조 기반) ─────────────────────────────────────────

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
_WON_ANY = re.compile(r"\d[\d,]*\s*원")
_WON_FULL = re.compile(r"([\d,]+)\s*원")
_LIST_FULL = re.compile(r"정가\s*([\d,]+)\s*원")
_PCT = re.compile(r"(\d+)\s*%")


class _Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.children, self.parent = tag, dict(attrs), [], parent

    def classes(self) -> list[str]:
        return (self.attrs.get("class") or "").split()

    def texts(self):
        """(텍스트, 소유 노드) — 문서 순서."""
        for ch in self.children:
            if isinstance(ch, str):
                yield ch, self
            else:
                yield from ch.texts()

    def text(self) -> str:
        return " ".join(" ".join(t for t, _ in self.texts()).split())

    def walk(self):
        for ch in self.children:
            if isinstance(ch, _Node):
                yield ch
                yield from ch.walk()

    def within(self, other: "_Node") -> bool:
        n = self
        while n is not None:
            if n is other:
                return True
            n = n.parent
        return False


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
            self.cur.children.append(" ".join(data.split()))


def _amount(m: re.Match) -> int:
    return int(m.group(1).replace(",", ""))


def _pricing_section(html: str) -> _Node:
    tree = _Tree()
    tree.feed(html)
    secs = [n for n in tree.root.walk() if n.attrs.get("id") == "sectionPricing"]
    if len(secs) != 1:
        raise ExtractError(f"section#sectionPricing 이 {len(secs)}개입니다")
    return secs[0]


def _is_sale_anchor(node: _Node) -> bool:
    return node.tag == "strong" and _WON_FULL.fullmatch(node.text()) is not None


def read_notice(html: str) -> tuple[dict[str, dict], list[str]]:
    """(품목 제목 → {sale, list, extras}, 카드 밖 할인율 문장 목록).

    카드: 판매가 앵커(<strong>N원</strong>)에서 위로 올라가며 앵커를 하나만 포함하는 가장 큰 요소.
    제목: 카드의 첫 텍스트. 정가: 카드 안의 '정가 N원' 단독 텍스트(0~1개).
    extras: 카드 안에서 판매가·정가와 다른 금액이 든 문장. 계약이 정확한 문장으로 허용하지
    않으면 run_checks 가 실패시킨다.
    추출 실패: 카드 밖의 금액, 제목 중복·빈 제목, 정가 표기 여러 개.
    """
    sec = _pricing_section(html)
    anchors = [n for n in sec.walk() if _is_sale_anchor(n)]
    if not anchors:
        raise ExtractError("요금 영역에서 판매가(<strong>N원</strong>)를 하나도 찾지 못했습니다")

    def anchor_count(node):
        return sum(1 for n in node.walk() if _is_sale_anchor(n)) + (1 if _is_sale_anchor(node) else 0)

    items: dict[str, dict] = {}
    cards: list[_Node] = []
    for a in anchors:
        card = a
        while card.parent is not None and card.parent is not sec and anchor_count(card.parent) == 1:
            card = card.parent
        texts = [t for t, _ in card.texts()]
        title = texts[0].strip() if texts else ""
        if not title or _WON_FULL.fullmatch(title):
            raise ExtractError(f"판매가 {a.text()!r} 의 카드에 제목이 없습니다")
        if title in items:
            raise ExtractError(f"고지 품목 제목 중복: {title!r}")
        sale = _amount(_WON_FULL.fullmatch(a.text()))
        lists = [t for t, owner in card.texts() if _LIST_FULL.fullmatch(t) and not owner.within(a)]
        if len(lists) > 1:
            raise ExtractError(f"{title!r}: 정가 표기가 {len(lists)}개입니다")
        lst = _amount(_LIST_FULL.fullmatch(lists[0])) if lists else None
        extras = []
        for t, owner in card.texts():
            if owner.within(a) or t in lists:
                continue
            amounts = [int(re.sub(r"[^\d]", "", m.group(0))) for m in _WON_ANY.finditer(t)]
            if any(v not in (sale, lst) for v in amounts):
                extras.append(t)
        items[title] = {"sale": sale, "list": lst, "extras": extras}
        cards.append(card)

    loose_pct: list[str] = []
    for t, owner in sec.texts():
        if any(owner.within(c) for c in cards):
            continue
        if _WON_ANY.search(t):
            raise ExtractError(f"품목 카드로 분류되지 않은 금액: {t!r} — 미분류 가격 블록")
        if _PCT.search(t):
            loose_pct.append(t)
    return items, loose_pct


def notice_items(html: str) -> dict[str, dict]:
    return read_notice(html)[0]


def _notice_percent(loose_pct: list[str], label: str) -> float:
    found = [int(m.group(1)) for t in loose_pct if label in t for m in _PCT.finditer(t)]
    if len(found) != 1:
        raise ExtractError(f"고지에서 '{label} N%' 가 {len(found)}개 발견")
    return found[0] / 100


# ── 대조 ───────────────────────────────────────────────────────────

def _check_field(value, spec, prices, rates, notices, loose_pct) -> str | None:
    """실패 사유 문자열, 통과면 None."""
    unknown = set(spec) - SPEC_KEYS
    if unknown:
        return f"price_check 에 알 수 없는 항목 {sorted(unknown)}"
    allowed = spec.get("notice_allowed_text", [])
    if not isinstance(allowed, list) or not all(isinstance(x, str) and x for x in allowed):
        return "notice_allowed_text 는 비어 있지 않은 문자열 목록이어야 함"

    if "notice_label" in spec:  # 할인율
        rule = spec.get("discount_rule")
        if rule not in rates:
            return f"DISCOUNT_RULES 에 {rule!r} 없음"
        notice = _notice_percent(loose_pct, spec["notice_label"])
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
    if spec.get("notice_list_matches_catalog") and notices[title]["list"] != base:
        return f"고지 정가 {notices[title]['list']} ≠ 카탈로그 {base}"
    return None


def run_checks(profile: Profile, js: str, html: str) -> list[CheckResult]:
    results: list[CheckResult] = []
    try:
        prices = catalog_prices(js)
        rates = discount_rates(js)
        notices, loose_pct = read_notice(html)
    except ExtractError as e:
        return [CheckResult("(추출)", False, f"추출 실패: {e}")]

    pricing_fields = [profile.field(k) for k in profile.keys() if k.startswith(("price.", "discount."))]
    for f in pricing_fields:
        if f.status != "confirmed":
            continue
        try:
            reason = _check_field(f.value, f.price_check or {}, prices, rates, notices, loose_pct)
        except ExtractError as e:
            reason = f"추출 실패: {e}"
        results.append(CheckResult(f.key, reason is None, reason or "고지·카탈로그 일치"))

    # 고지에 새 품목·할인이 생겼는데 계약에 없으면 실패 — 조용히 빠지는 것을 막는다.
    mapped = " ".join(f.source.get("item") or "" for f in pricing_fields)
    for title in notices:
        if f"'{title}'" not in mapped:
            results.append(CheckResult("(고지 품목)", False, f"계약에 없는 고지 품목: {title!r}"))
    allowed: dict[str, list] = {}
    for f in pricing_fields:
        spec = f.price_check or {}
        if f.status == "confirmed" and spec.get("notice_title"):
            allowed[spec["notice_title"]] = spec.get("notice_allowed_text") or []
    for title, item in notices.items():
        for t in item["extras"]:
            if t not in allowed.get(title, []):
                results.append(CheckResult("(미분류 가격)", False,
                                           f"{title!r} 카드에 판매가·정가와 다른 금액: {t!r}"))
    labels = [(f.price_check or {}).get("notice_label") for f in pricing_fields]
    labels = [x for x in labels if x]
    for t in loose_pct:
        if not any(lb in t for lb in labels):
            results.append(CheckResult("(고지 할인)", False, f"계약에 없는 할인 고지: {t!r}"))
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
