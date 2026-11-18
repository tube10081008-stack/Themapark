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
_NON_TEXT = {"script", "style", "noscript", "template"}
_WON_ANY = re.compile(r"\d[\d,]*\s*원")
_WON_FULL = re.compile(r"([\d,]+)\s*원")
_LIST_FULL = re.compile(r"정가\s*([\d,]+)\s*원")
_PCT = re.compile(r"(\d+)\s*%")


class _Node:
    __slots__ = ("tag", "attrs", "children", "parent", "line")

    def __init__(self, tag, attrs, parent, line=0):
        self.tag, self.attrs, self.children, self.parent = tag, dict(attrs), [], parent
        self.line = line

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
        node = _Node(tag, attrs, self.cur, self.getpos()[0])
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
        # 스크립트·스타일 본문은 고객에게 보이는 문구가 아니다 (동적 문구는 G2 범위 밖 — 문서화)
        n = self.cur
        while n is not None:
            if n.tag in _NON_TEXT:
                return
            n = n.parent
        if data.strip():
            self.cur.children.append(" ".join(data.split()))


def _amount(m: re.Match) -> int:
    return int(m.group(1).replace(",", ""))


def _parse(html: str) -> tuple[_Node, _Node]:
    tree = _Tree()
    tree.feed(html)
    secs = [n for n in tree.root.walk() if n.attrs.get("id") == "sectionPricing"]
    if len(secs) != 1:
        raise ExtractError(f"section#sectionPricing 이 {len(secs)}개입니다")
    return tree.root, secs[0]


def _pricing_section(html: str) -> _Node:
    return _parse(html)[1]


def _is_sale_anchor(node: _Node) -> bool:
    return node.tag == "strong" and _WON_FULL.fullmatch(node.text()) is not None


def read_notice(html: str) -> tuple[dict[str, dict], list[str]]:
    _, _, items, loose_pct, _ = _read(html)
    return items, loose_pct


def _read(html: str):
    """(품목 제목 → {sale, list, extras}, 카드 밖 할인율 문장 목록).

    카드: 판매가 앵커(<strong>N원</strong>)에서 위로 올라가며 앵커를 하나만 포함하는 가장 큰 요소.
    제목: 카드의 첫 텍스트. 정가: 카드 안의 '정가 N원' 단독 텍스트(0~1개).
    extras: 카드 안에서 판매가·정가와 다른 금액이 든 문장. 계약이 정확한 문장으로 허용하지
    않으면 run_checks 가 실패시킨다.
    추출 실패: 카드 밖의 금액, 제목 중복·빈 제목, 정가 표기 여러 개.
    """
    root, sec = _parse(html)
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
    return root, sec, items, loose_pct, cards


# ── G1·G1b·G2: 혜택 문구와 요금 영역 밖 금액 (CLAUDE-006) ─────────────
#
# G1  요금 영역 안, 품목 카드 밖의 **혜택 선언 문장**(우대·할인·감면·면제·무료)은 계약의 할인
#     라벨(notice_label)을 포함하거나 계약 필드 source.item 에 '문장' 그대로 인용돼 있어야 한다.
#     금액·비율이 없는 우대 문구(예: 폐지된 '국가유공자·장애인 우대')도 여기서 잡힌다.
#     제외: 제목(h1~h6, 예: '이용 요금 및 우대 혜택'), 품목 카드 안 설명(카드는 품목 대조가 담당).
# G1b 페이지 전체에서 공공 주체(봉화군·군청·지자체 등)와 지원·보조·인센티브가 한 문장에 함께 나오면
#     실패 — BEN-010/011 '군 지원 확정 안내 금지'. 계약에 이를 허용하는 근거 필드가 없다.
#     '봉화군민'(주민 우대 대상)은 공공 주체로 보지 않는다.
# G2  요금 영역 밖의 금액(N원, N만 원, 범위)은 confirmed 요금과 같아야 한다. 범위·만 원 단위는
#     요금이 아니므로 실패, 한글 단위가 섞인 표기(1만5천원 등)는 해석 불가로 실패.
#     숫자라도 ㎡·평·시각·전화·날짜·인원 등 '원'이 붙지 않은 것은 금액이 아니다.
#     대상: 텍스트 노드와 placeholder·title·alt·aria-label 속성. script 안의 동적 문구는 범위 밖.

_BENEFIT = re.compile(r"우대|할인|감면|면제|무료")
_PUBLIC = re.compile(r"봉화군(?!민)|군청|지자체|시청|도청|정부|공공기관|국비|도비|군비")
_SUPPORT = re.compile(r"지원|보조|인센티브")
_HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
_ATTRS = ("placeholder", "title", "alt", "aria-label")
_AFTER_WON = "에은는이을의으과와도만부씩대짜권선까상어미초"
_MONEY = re.compile(r"(\d[\d,]*)(?:\s*[~\-–]\s*(\d[\d,]*))?\s*(만\s*)?원(?=$|[^가-힣]|[" + _AFTER_WON + "])")
_KR_MONEY = re.compile(r"\d+\s*만\s*\d+\s*천?\s*원|\d+\s*천\s*원")


def _under(node: _Node, tags: set) -> bool:
    n = node
    while n is not None:
        if n.tag in tags:
            return True
        n = n.parent
    return False


def _phrases(root: _Node):
    """(문장, 소유 노드, 출처) — 텍스트 노드와 지정 속성. script 등은 트리에서 이미 빠짐."""
    for t, owner in root.texts():
        yield t, owner, "text"
    for n in root.walk():
        if _under(n, _NON_TEXT):
            continue
        for a in _ATTRS:
            v = (n.attrs.get(a) or "").strip()
            if v:
                yield v, n, f"@{a}"


def _money(t: str):
    """[(원문, 값 또는 None, 사유)] — 값이 None 이면 요금으로 해석할 수 없는 금액."""
    out, taken = [], []
    for m in _KR_MONEY.finditer(t):
        out.append((m.group(0), None, "한글 단위가 섞인 금액 표기 — 해석 불가"))
        taken.append(m.span())
    for m in _MONEY.finditer(t):
        if any(a <= m.start() < b for a, b in taken):
            continue
        lo, hi, man = m.group(1), m.group(2), m.group(3)
        if hi or man:
            out.append((m.group(0), None, "범위·만 원 단위 금액 — 요금이 아님(지원금·견적 등)"))
            continue
        out.append((m.group(0), int(lo.replace(",", "")), ""))
    return out


def _coverage_checks(profile: Profile, root: _Node, sec: _Node, cards, js_prices) -> list[CheckResult]:
    res: list[CheckResult] = []
    pricing = [profile.field(k) for k in profile.keys() if k.startswith(("price.", "discount."))]
    mapped = " ".join(f.source.get("item") or "" for f in pricing)
    labels = [x for x in ((f.price_check or {}).get("notice_label") for f in pricing) if x]

    # G1
    for t, owner in sec.texts():
        if any(owner.within(c) for c in cards) or _under(owner, _HEADINGS) or not _BENEFIT.search(t):
            continue
        ok = any(lb in t for lb in labels) or f"'{t}'" in mapped
        res.append(CheckResult("(G1 혜택 고지)", ok,
                               "계약 대응 확인" if ok else
                               f"{owner.line}행 부근 계약에 없는 혜택 문구: {t!r}"))

    # G1b
    for t, owner, src in _phrases(root):
        if _PUBLIC.search(t) and _SUPPORT.search(t):
            res.append(CheckResult("(G1b 공적 지원 주장)", False,
                                   f"{owner.line}행 부근 {src} 공공 재원 지원 주장 — 계약 근거 없음"
                                   f" (군 지원 확정 안내 금지): {t!r}"))

    # G2
    confirmed = {f.value: f.key for f in pricing if f.key.startswith("price.") and f.status == "confirmed"}
    other = {f.value: f"{f.key}({f.status})" for f in pricing
             if f.key.startswith("price.") and f.status != "confirmed" and f.value is not None}
    for t, owner, src in _phrases(root):
        if owner.within(sec):
            continue
        for raw, val, why in _money(t):
            where = f"{owner.line}행 부근 {src} {raw!r}"
            if val is None:
                res.append(CheckResult("(G2 영역 밖 금액)", False, f"{where}: {why} — 문장 {t!r}"))
            elif val in confirmed:
                res.append(CheckResult("(G2 영역 밖 금액)", True, f"{where} = {confirmed[val]}"))
            elif val in other or val in js_prices.values():
                cat = [k for k, v in js_prices.items() if v == val]
                ref = other.get(val) or f"카탈로그 {', '.join(cat)} 와 같은 값이지만 계약 confirmed 요금 아님"
                res.append(CheckResult("(G2 영역 밖 금액)", False,
                                       f"{where}: 확정되지 않은 금액 ({ref}) — 문장 {t!r}"))
            else:
                res.append(CheckResult("(G2 영역 밖 금액)", False,
                                       f"{where}: 계약에 없는 금액 — 문장 {t!r}"))
    return res


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
        root, sec, notices, loose_pct, cards = _read(html)
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
    results.extend(_coverage_checks(profile, root, sec, cards, prices))
    return results


def main(argv: list[str] | None = None) -> int:
    profile = load_profile()
    js = CATALOG_PATH.read_text(encoding="utf-8")
    html = NOTICE_PATH.read_text(encoding="utf-8")
    results = run_checks(profile, js, html)
    failed = [r for r in results if not r.ok]
    print("※ 코드 대조 결과 — 저장소 파일 기준. 운영 배포(라이브 사이트) 확인이 아니다.\n")
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
