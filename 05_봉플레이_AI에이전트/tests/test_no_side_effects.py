"""부수효과 없음 — 파일 생성·수정·삭제·디렉터리 생성을 모두 검사한다 (BEN-004).

- 감시 범위: 모듈 폴더(05_…, data/ 경로 포함), 입력 원본 폴더(01_…/assets, pages),
  별도 작업 폴더(CWD). 원본 store 는 모듈 옆에 data/ 를 만들었으므로 CWD 만 보면 놓친다.
- 파일 경로·내용 해시와 디렉터리 목록을 전후 비교한다.
- 대상 코드는 자식 프로세스에서 -B·PYTHONDONTWRITEBYTECODE 로 실행해 bytecode 쓰기를
  업무 코드의 쓰기와 구분한다. 자식 안에서는 네트워크·subprocess 를 막고, 쓰기 모드 open 과
  파일시스템 변경 함수도 막아 시도 자체를 실패로 만든다.
- 검사기가 실제로 변화를 잡는지(생성·수정·삭제·디렉터리 생성)도 따로 확인한다.
"""

import hashlib
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = MODULE_DIR.parent
INPUT_DIRS = [
    REPO_ROOT / "01_봉플레이_운영시스템" / "assets",
    REPO_ROOT / "01_봉플레이_운영시스템" / "pages",
]

GUARDS = textwrap.dedent("""
    import builtins, io, os, shutil, socket, subprocess, pathlib

    def _deny(*a, **k):
        raise RuntimeError("부수효과 시도 차단")

    socket.socket = _deny
    socket.create_connection = _deny
    subprocess.Popen = _deny
    subprocess.run = _deny
    os.system = _deny
    for name in ("mkdir", "makedirs", "remove", "unlink", "rename", "replace", "rmdir", "removedirs"):
        setattr(os, name, _deny)
    shutil.copy = shutil.copy2 = shutil.move = shutil.rmtree = _deny

    _open = builtins.open
    def _ro_open(file, mode="r", *a, **k):
        if any(c in mode for c in "wax+"):
            raise RuntimeError(f"쓰기 모드 open 차단: {file} {mode}")
        return _open(file, mode, *a, **k)
    builtins.open = io.open = _ro_open
    pathlib.Path.write_text = pathlib.Path.write_bytes = pathlib.Path.touch = _deny
""")

EXERCISE = textwrap.dedent("""
    import sys, os
    sys.path.insert(0, MODULE_DIR)
    from core import gate, profile, price_check, settings

    # 정상 경로
    p = profile.load_profile()
    profile.facility_description(p)
    p.customer_text("hours.open"); p.internal_value("price.tkt_allday")
    for t in ("", "주차장 있나요?", "아이가 다칠 뻔했어요"):
        gate.escalation_hit(t, "inquiry"); gate.escalation_hit(t, "review")
    assert price_check.main([]) == 0

    # 실패·누락 입력 경로
    for bad in ("/nonexistent/site_profile.json",):
        try:
            profile.load_profile(bad)
        except profile.ProfileError:
            pass
    try:
        gate.escalation_hit("x", "unknown")
    except ValueError:
        pass
    os.environ.pop("ANTHROPIC_MODEL", None)
    try:
        settings.require_model()
    except SystemExit:
        pass
    results = price_check.run_checks(p, "", "")
    assert results and not results[0].ok
    print("EXERCISE_OK")
""")

MISBEHAVE = textwrap.dedent("""
    from pathlib import Path
    Path("new.txt").write_text("x")
    Path("keep.txt").write_text("changed")
    Path("gone.txt").unlink()
    Path("newdir").mkdir()
    print("MISBEHAVE_OK")
""")


def snapshot(roots):
    files, dirs = {}, set()
    for root in roots:
        for d, dnames, fnames in os.walk(root):
            dirs.add(os.path.relpath(d, "/"))
            for f in fnames:
                full = os.path.join(d, f)
                with open(full, "rb") as fh:
                    files[os.path.relpath(full, "/")] = hashlib.sha256(fh.read()).hexdigest()
    return files, dirs


def diff(before, after):
    (bf, bd), (af, ad) = before, after
    return {
        "created": sorted(set(af) - set(bf)),
        "deleted": sorted(set(bf) - set(af)),
        "modified": sorted(k for k in set(bf) & set(af) if bf[k] != af[k]),
        "dirs_created": sorted(ad - bd),
        "dirs_deleted": sorted(bd - ad),
    }


def run_child(code, cwd, guarded=True):
    env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_MODEL")}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    src = f"MODULE_DIR = {str(MODULE_DIR)!r}\n" + (GUARDS if guarded else "") + code
    return subprocess.run([sys.executable, "-B", "-c", src], cwd=cwd, env=env,
                          capture_output=True, text=True, timeout=120)


class NoSideEffects(unittest.TestCase):
    def test_core_leaves_everything_unchanged(self):
        with tempfile.TemporaryDirectory() as work:
            (Path(work) / "keep.txt").write_text("sentinel", encoding="utf-8")
            roots = [MODULE_DIR, *INPUT_DIRS, Path(work)]
            before = snapshot(roots)
            proc = run_child(EXERCISE, work)
            after = snapshot(roots)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertIn("EXERCISE_OK", proc.stdout)
        self.assertEqual(diff(before, after), {
            "created": [], "deleted": [], "modified": [], "dirs_created": [], "dirs_deleted": [],
        })
        self.assertFalse((MODULE_DIR / "data").exists())


class DetectorSanity(unittest.TestCase):
    """검사기가 네 종류 변화를 모두 잡는지 — 가드 없이 일부러 쓰는 자식으로 확인."""

    def test_detects_create_modify_delete_mkdir(self):
        with tempfile.TemporaryDirectory() as work:
            (Path(work) / "keep.txt").write_text("sentinel", encoding="utf-8")
            (Path(work) / "gone.txt").write_text("bye", encoding="utf-8")
            before = snapshot([Path(work)])
            proc = run_child(MISBEHAVE, work, guarded=False)
            after = snapshot([Path(work)])
        self.assertIn("MISBEHAVE_OK", proc.stdout, proc.stderr)
        d = diff(before, after)
        self.assertTrue(any(p.endswith("new.txt") for p in d["created"]))
        self.assertTrue(any(p.endswith("keep.txt") for p in d["modified"]))
        self.assertTrue(any(p.endswith("gone.txt") for p in d["deleted"]))
        self.assertTrue(any(p.endswith("newdir") for p in d["dirs_created"]))

    def test_guards_block_write_attempts(self):
        with tempfile.TemporaryDirectory() as work:
            proc = run_child('open("x.txt", "w")', work)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("쓰기 모드 open 차단", proc.stderr)


if __name__ == "__main__":
    unittest.main()
