"""JS 원본에서 배열 리터럴 하나를 **실행하지 않고** 읽는 제한적 정적 파서 (BEN PR-009 R1).

지원하는 것만 받아들이고 나머지는 거부한다. 거부 = ExtractError.

- 토큰 단위로 주석·문자열·템플릿·정규식 리터럴을 구분한다. 주석이나 문자열 안의
  `list_price:` 같은 글자는 속성이 아니다.
- `const NAME = [ {…}, {…} ]` 형태만 읽는다. 원소는 평평한 객체 리터럴이어야 한다.
- 객체 키: 식별자 또는 문자열 리터럴(따옴표 키는 같은 이름으로 정규화 → 중복 검사).
  계산 키 `[k]`, spread `...`, 축약 속성 `{ id }`, 메서드·getter 는 거부.
- 값: 문자열·숫자·true/false/null 리터럴만. 식별자, 연산식, 함수 호출, 중첩 객체·배열,
  `${}` 가 든 템플릿은 거부 (실효 값을 정적으로 확정할 수 없음).
- 키 중복(따옴표 유무 무관)은 거부 — JS 에서는 뒤 값이 이기므로 실효 값이 바뀐다.
- 선언 뒤의 변경도 검사한다: 같은 이름 재선언·재할당, 배열 변경 메서드(push·splice 등),
  인덱스 접근, 그리고 파일 어디서든 감시 속성(list_price·rate)에 대한 대입·증감·delete.
"""

from __future__ import annotations

import re


class ExtractError(Exception):
    """원본 형식이 예상과 다르거나 값이 모호하다."""


# 길이 순으로 — 가장 긴 연산자를 먼저 맞춘다
_OPS = sorted("""
>>>= ... === !== **= <<= >>= >>> &&= ||= ??= => == != <= >= && || ?? ?. ++ -- += -= *= /= %= &= |= ^= ** << >>
{ } ( ) [ ] ; , < > + - * / % & | ^ ! ~ ? : = . @ #
""".split(), key=len, reverse=True)

_ASSIGN = {"=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=",
           "&&=", "||=", "??="}
_REGEX_AFTER = set("( , = : [ ! & | ? { } ; + - * % < > ~ ^".split()) | _ASSIGN | {
    "==", "===", "!=", "!==", "<=", ">=", "&&", "||", "??", "=>", "return", "typeof", "case",
    "do", "else", "in", "instanceof", "new", "delete", "void", "throw", "yield", "await"}
_ARRAY_MUTATORS = {"push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill",
                   "copyWithin"}
_IDENT = re.compile(r"[A-Za-z_$À-￿][\w$À-￿]*")
_NUM = re.compile(r"(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?n?)")


def tokenize(src: str) -> list[tuple[str, str]]:
    """(종류, 값) 목록. 종류: ident / num / str / tpl / regex / op."""
    toks: list[tuple[str, str]] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c.isspace():
            i += 1
            continue
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            if j < 0:
                raise ExtractError("닫히지 않은 주석")
            i = j + 2
            continue
        if c in "'\"":
            j, buf = i + 1, []
            while j < n and src[j] != c:
                if src[j] == "\\":
                    buf.append(src[j:j + 2])
                    j += 2
                    continue
                if src[j] == "\n":
                    raise ExtractError("문자열이 줄바꿈 전에 닫히지 않음")
                buf.append(src[j])
                j += 1
            if j >= n:
                raise ExtractError("닫히지 않은 문자열")
            toks.append(("str", "".join(buf)))
            i = j + 1
            continue
        if c == "`":
            j, depth, raw = i + 1, 0, []
            while j < n:
                ch = src[j]
                if ch == "\\":
                    raw.append(src[j:j + 2])
                    j += 2
                    continue
                if depth == 0 and ch == "`":
                    break
                if src.startswith("${", j):
                    depth += 1
                    raw.append("${")
                    j += 2
                    continue
                if depth and ch == "}":
                    depth -= 1
                raw.append(ch)
                j += 1
            if j >= n:
                raise ExtractError("닫히지 않은 템플릿 문자열")
            toks.append(("tpl", "".join(raw)))
            i = j + 1
            continue
        if c == "/":
            prev = toks[-1] if toks else None
            if prev is None or (prev[0] in ("op", "ident") and prev[1] in _REGEX_AFTER):
                j, in_class = i + 1, False
                while j < n:
                    ch = src[j]
                    if ch == "\\":
                        j += 2
                        continue
                    if ch == "\n":
                        raise ExtractError("정규식 리터럴이 줄바꿈 전에 닫히지 않음")
                    if ch == "[":
                        in_class = True
                    elif ch == "]":
                        in_class = False
                    elif ch == "/" and not in_class:
                        break
                    j += 1
                j += 1
                while j < n and (src[j].isalnum()):
                    j += 1
                toks.append(("regex", src[i:j]))
                i = j
                continue
        if c.isdigit() or (c == "." and i + 1 < n and src[i + 1].isdigit()):
            m = _NUM.match(src, i)
            toks.append(("num", m.group(0)))
            i = m.end()
            continue
        m = _IDENT.match(src, i)
        if m:
            toks.append(("ident", m.group(0)))
            i = m.end()
            continue
        for op in _OPS:
            if src.startswith(op, i):
                toks.append(("op", op))
                i += len(op)
                break
        else:
            raise ExtractError(f"알 수 없는 문자 {c!r} (위치 {i})")
    return toks


def _is(tok, kind, val=None) -> bool:
    return tok[0] == kind and (val is None or tok[1] == val)


def _parse_value(toks, i, where):
    t = toks[i]
    if t[0] == "str":
        return t[1], i + 1
    if t[0] == "num":
        v = t[1].replace("_", "")
        if re.fullmatch(r"\d+", v):
            return int(v), i + 1
        if re.fullmatch(r"\d+\.\d+|\.\d+", v):
            return float(v), i + 1
        raise ExtractError(f"{where}: 지원하지 않는 숫자 표기 {t[1]!r}")
    if t[0] == "ident" and t[1] in ("true", "false", "null"):
        return {"true": True, "false": False, "null": None}[t[1]], i + 1
    if t[0] == "tpl" and "${" not in t[1]:
        return t[1], i + 1
    raise ExtractError(f"{where}: 리터럴이 아닌 값 {t[1]!r} — 실효 값을 정적으로 확정할 수 없음")


def _parse_object(toks, i, where):
    if not _is(toks[i], "op", "{"):
        raise ExtractError(f"{where}: 객체 리터럴이 아닌 원소 {toks[i][1]!r}")
    i += 1
    obj: dict = {}
    while True:
        t = toks[i]
        if _is(t, "op", "}"):
            return obj, i + 1
        if _is(t, "op", "..."):
            raise ExtractError(f"{where}: spread 는 지원하지 않음")
        if _is(t, "op", "["):
            raise ExtractError(f"{where}: 계산 키는 지원하지 않음")
        if t[0] not in ("ident", "str"):
            raise ExtractError(f"{where}: 지원하지 않는 키 {t[1]!r}")
        key = t[1]
        if t[0] == "ident" and key in ("get", "set", "async") and not _is(toks[i + 1], "op", ":"):
            raise ExtractError(f"{where}: 접근자·메서드는 지원하지 않음")
        if not _is(toks[i + 1], "op", ":"):
            raise ExtractError(f"{where}: '{key}' 뒤에 ':' 가 없음 (축약 속성·메서드 불가)")
        if key in obj:
            raise ExtractError(f"{where}: 키 중복 {key!r} — 뒤 값이 실효 값을 바꾼다")
        val, i = _parse_value(toks, i + 2, f"{where}.{key}")
        obj[key] = val
        if _is(toks[i], "op", ","):
            i += 1
            continue
        if _is(toks[i], "op", "}"):
            continue
        raise ExtractError(f"{where}.{key}: 값 뒤에 예상치 못한 토큰 {toks[i][1]!r} (연산식 불가)")


def _decl_index(toks, name) -> int:
    hits = [k for k in range(len(toks) - 3)
            if _is(toks[k], "ident") and toks[k][1] in ("const", "let", "var")
            and _is(toks[k + 1], "ident", name)]
    if len(hits) != 1:
        raise ExtractError(f"{name} 선언이 {len(hits)}개입니다 (정확히 1개여야 함)")
    k = hits[0]
    if toks[k][1] != "const":
        raise ExtractError(f"{name} 은 const 선언이어야 합니다")
    if not (_is(toks[k + 2], "op", "=") and _is(toks[k + 3], "op", "[")):
        raise ExtractError(f"{name} 이 배열 리터럴로 선언되지 않았습니다")
    return k + 3


def _check_mutations(toks, name, watched_props, decl_at: int) -> None:
    for k, t in enumerate(toks):
        if k == decl_at:
            continue  # 선언문 자체
        if _is(t, "ident", name):
            nxt = toks[k + 1] if k + 1 < len(toks) else ("", "")
            prev = toks[k - 1] if k else ("", "")
            if _is(prev, "op", ".") or _is(prev, "op", "?."):
                continue  # 다른 객체의 같은 이름 속성
            if nxt[0] == "op" and nxt[1] in _ASSIGN:
                raise ExtractError(f"{name} 재할당 발견")
            if _is(nxt, "op", "["):
                raise ExtractError(f"{name}[...] 인덱스 접근 발견 — 원소 변경 여부를 정적으로 확정할 수 없음")
            if _is(nxt, "op", ".") and k + 2 < len(toks) and toks[k + 2][1] in _ARRAY_MUTATORS:
                raise ExtractError(f"{name}.{toks[k + 2][1]} 발견 — 배열이 변경될 수 있음")
    for k, t in enumerate(toks):
        # obj.list_price =, obj.list_price++, ++obj.list_price, delete obj.list_price
        if _is(t, "ident") and t[1] in watched_props and k and toks[k - 1][1] in (".", "?."):
            nxt = toks[k + 1][1] if k + 1 < len(toks) else ""
            before = toks[k - 3][1] if k >= 3 else ""
            if nxt in _ASSIGN or nxt in ("++", "--") or before in ("++", "--", "delete"):
                raise ExtractError(f"'{t[1]}' 속성 변경 발견 — 실효 값이 바뀔 수 있음")
        # obj['list_price'] = ...
        if _is(t, "str") and t[1] in watched_props and k and _is(toks[k - 1], "op", "[") \
                and k + 2 < len(toks) and _is(toks[k + 1], "op", "]") \
                and (toks[k + 2][1] in _ASSIGN or toks[k + 2][1] in ("++", "--")):
            raise ExtractError(f"'{t[1]}' 속성 변경 발견 — 실효 값이 바뀔 수 있음")


def read_const_array(src: str, name: str, watched_props=("list_price", "rate")) -> list[dict]:
    """`const NAME = [...]` 의 평평한 객체 목록. 규칙 밖이면 ExtractError."""
    toks = tokenize(src) + [("eof", "")] * 4
    i = _decl_index(toks, name)
    _check_mutations(toks, name, set(watched_props), decl_at=i - 2)
    i += 1
    out: list[dict] = []
    while True:
        if _is(toks[i], "op", "]"):
            break
        obj, i = _parse_object(toks, i, f"{name}[{len(out)}]")
        out.append(obj)
        if _is(toks[i], "op", ","):
            i += 1
            continue
        if not _is(toks[i], "op", "]"):
            raise ExtractError(f"{name}: 원소 뒤에 예상치 못한 토큰 {toks[i][1]!r}")
    if not out:
        raise ExtractError(f"{name}: 항목이 없습니다")
    return out
