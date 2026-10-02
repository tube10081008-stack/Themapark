"""CLAUDE-008 — 01/04 build_deploy_zip.ps1 합성 회귀시험.

실제 운영 설정·키를 읽지 않는다. 임시 폴더에 합성 git 저장소를 만들고
저장소의 실제 패키징 스크립트를 복사해 PowerShell 로 실행한다.
비밀값은 모두 SENTINEL 가짜 값이다.

실행: python -m unittest discover -s tests/packaging -v
PowerShell: 환경변수 PWSH 에 하나 이상(os.pathsep 로 구분) 지정. 없으면 PATH 에서
  Windows 는 powershell.exe(5.1)와 pwsh(7) 를 모두, 그 밖에는 pwsh 를 찾는다.
  찾은 셸마다 같은 시험 묶음을 따로 만든다 (예: Project01Tests_ps51, Project01Tests_pwsh).
임시 폴더 위치: 환경변수 BONGPLAY_TEST_WORKDIR (없으면 시스템 임시 폴더).
  git 객체 파일은 읽기 전용이라 Windows 에서 기본 정리가 WinError 5 로 실패할 수 있어
  읽기 전용 속성을 풀고 지운다.
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_01 = REPO_ROOT / "01_봉플레이_운영시스템" / "build_deploy_zip.ps1"
SCRIPT_04 = REPO_ROOT / "04_봉뜨락_업무로그_AI" / "build_deploy_zip.ps1"

SENTINEL = "SENTINEL-FAKE-SECRET-DO-NOT-SHIP"


def _shell_label(path: str) -> str:
    name = Path(path).name.lower()
    return "ps51" if name.startswith("powershell") else "pwsh"


def _find_shells() -> list[tuple[str, str]]:
    env = os.environ.get("PWSH")
    if env:
        paths = [p for p in env.split(os.pathsep) if p]
    else:
        names = ("powershell", "pwsh") if os.name == "nt" else ("pwsh",)
        paths = [found for found in (shutil.which(n) for n in names) if found]
    shells: list[tuple[str, str]] = []
    for path in paths:
        label = _shell_label(path)
        while label in {l for l, _ in shells}:
            label += "_"
        shells.append((label, path))
    return shells


SHELLS = _find_shells()


def _force_rmtree(path: Path) -> None:
    def _onerror(func, target, _exc):
        try:
            os.chmod(target, stat.S_IWRITE)
            func(target)
        except OSError:
            pass

    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_onerror)
    else:
        shutil.rmtree(path, onerror=_onerror)


def make_dir_link(link: Path, target: Path, case: unittest.TestCase) -> str:
    """폴더 링크 생성. Windows 는 관리자 권한이 필요 없는 정션, 그 밖에는 심볼릭 링크."""
    if os.name == "nt":
        res = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
        if res.returncode != 0:
            case.skipTest("정션 생성 실패로 건너뜀: " + res.stderr.decode("mbcs", "replace").strip())
        return "junction"
    try:
        os.symlink(target, link, target_is_directory=True)
    except OSError as exc:
        case.skipTest(f"폴더 심볼릭 링크 생성 불가로 건너뜀: {exc}")
    return "symlink"


def make_file_link(link: Path, target: Path, case: unittest.TestCase) -> None:
    try:
        os.symlink(target, link)
    except OSError as exc:  # Windows 개발자 모드·관리자 권한이 없으면 실패
        case.skipTest(f"파일 심볼릭 링크 생성 권한이 없어 건너뜀: {exc}")


def _b64url(obj: dict) -> str:
    raw = json.dumps(obj, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def fake_jwt(role: str) -> str:
    header = _b64url({"alg": "HS256", "typ": "JWT"})
    payload = _b64url({"iss": "sentinel", "role": role, "ref": "sentinelproj"})
    return f"{header}.{payload}.SENTINELsignatureSENTINELsig"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


GITIGNORE = "*.zip\n**/assets/config.js\n"

CONFIG_TEMPLATE = (
    "window.BONGPLAY_CONFIG = {\n"
    "  supabaseUrl: 'https://YOUR_PROJECT_ID.supabase.co',\n"
    "  supabaseAnonKey: 'YOUR_ANON_PUBLIC_KEY',\n"
    "  gasDeploymentId: 'YOUR_DEPLOYMENT_ID'\n"
    "};\n"
)


def good_config() -> str:
    return (
        "window.BONGPLAY_CONFIG = {\n"
        "  supabaseUrl: 'https://sentinelproj.supabase.co',\n"
        f"  supabaseAnonKey: '{fake_jwt('anon')}',\n"
        "  gasDeploymentId: 'SENTINEL_DEPLOYMENT'\n"
        "};\n"
    )


# 정상적으로 포함되어야 하는 파일
NORMAL_01 = {
    "index.html": "<!doctype html><title>합성 봉플레이</title>\n",
    "manifest.json": '{"name": "synthetic"}\n',
    "sw.js": "const CACHE = ['./assets/config.js'];\n",
    "netlify.toml": '[build]\n  publish = "."\n',
    "_redirects": "/master /pages/master.html 200\n",
    "pages/master.html": "<p>마스터</p>\n",
    "pages/style.css": "body{}\n",
    "forms/index.html": "<p>양식</p>\n",
    "forms/form-script.js": "console.log('form');\n",
    "assets/bongplay-site.js": "/* placeholder=\"eyJhbGci...\" AIzaSy... */\n",
    "assets/print.css": "@media print{}\n",
    "assets/images/icons/logo.png": "\x89PNG-synthetic",
    "netlify/functions/notify.mjs": "export default async () => new Response(process.env.NOTIFY_SECRET ? 'ok' : 'no');\n",
}

# 공개 배포에 들어가면 안 되는 추적 파일 (중첩·대소문자 변형 포함)
BLOCKED_01 = {
    "assets/config.template.js": CONFIG_TEMPLATE,
    "assets/secret-config.js": f"var k='{SENTINEL}';\n",
    "assets/Credentials.js": f"var k='{SENTINEL}';\n",
    "pages/Service-Account.js": f"var k='{SENTINEL}';\n",
    "pages/.ENV": f"KEY={SENTINEL}\n",
    "forms/.env.js": f"var k='{SENTINEL}';\n",
    "assets/.env.production": f"KEY={SENTINEL}\n",
    "assets/Server.PEM": f"{SENTINEL}\n",
    "netlify/functions/.env": f"KEY={SENTINEL}\n",
    "netlify/functions/admin.KEY": f"{SENTINEL}\n",
    "pages/Tests/spec.html": f"<p>{SENTINEL}</p>\n",
    "pages/evidence/shot.html": f"<p>{SENTINEL}</p>\n",
    "assets/images/RAW/orig.png": f"{SENTINEL}",
    "assets/images/tmp/x.png": f"{SENTINEL}",
    "pages/old.html.bak": f"{SENTINEL}\n",
    "pages/draft.html~": f"{SENTINEL}\n",
    "database/schema.sql": f"-- {SENTINEL}\n",
    "backend_ai/app.py": f"# {SENTINEL}\n",
    "docs/plan.md": f"{SENTINEL}\n",
    "_보관/old.html": f"{SENTINEL}\n",
    "assets/drive-archive.gs": f"// {SENTINEL}\n",
    "README.md": f"{SENTINEL}\n",
    "assets/images/README.txt": f"{SENTINEL}\n",
}

NORMAL_04 = {
    "netlify.toml": '[build]\n  publish = "public"\n',
    "netlify/functions/api.mjs": "// 계정 비밀키 (-----BEGIN PRIVATE KEY----- ...) 는 환경변수로만\nexport default async () => new Response('ok');\n",
    "public/index.html": "<p>업무로그</p>\n",
    "public/archive.html": "<p>아카이브</p>\n",
    "public/img/logo.svg": "<svg/>\n",
}

BLOCKED_04 = {
    "README.md": f"{SENTINEL}\n",
    "format_spreadsheet.gs": f"// {SENTINEL}\n",
    "public/tests/spec.html": f"<p>{SENTINEL}</p>\n",
    "public/Evidence/shot.png": f"{SENTINEL}",
    "public/raw/data.json": f'{{"k": "{SENTINEL}"}}\n',
    "public/.env.json": f'{{"k": "{SENTINEL}"}}\n',
    "public/service_account.json": f'{{"k": "{SENTINEL}"}}\n',
    "public/keys/server.KEY": f"{SENTINEL}\n",
    "public/TMP/a.js": f"var k='{SENTINEL}';\n",
    "netlify/functions/.env.local": f"KEY={SENTINEL}\n",
}


class PackagingCases:
    """셸별 시험 묶음의 공통 본체. 아래에서 셸마다 unittest.TestCase 와 결합한다."""

    pwsh = ""
    project_dir = ""
    script = SCRIPT_01
    zip_names: tuple = ()
    report_name = ""
    manifest_path = ""

    def setUp(self) -> None:
        base = os.environ.get("BONGPLAY_TEST_WORKDIR") or None
        self.tmp = Path(tempfile.mkdtemp(prefix="c008_", dir=base))
        self.addCleanup(_force_rmtree, self.tmp)
        self.repo = self.tmp / "repo"
        self.proj = self.repo / self.project_dir
        self.proj.mkdir(parents=True)
        self.git("init", "-q")
        self.git("config", "user.name", "synthetic")
        self.git("config", "user.email", "synthetic@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.autocrlf", "false")

    # ---- 도구 ----
    def git(self, *args: str) -> str:
        res = subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, check=True)
        return res.stdout

    def write(self, rel: str, content: str | bytes) -> Path:
        p = self.proj / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        data = content.encode("utf-8") if isinstance(content, str) else content
        p.write_bytes(data)
        return p

    def populate(self, files: dict) -> None:
        for rel, content in files.items():
            self.write(rel, content)

    def commit(self) -> str:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "synthetic", "--allow-empty")
        return self.git("rev-parse", "HEAD").strip()

    def run_script(self, *extra: str) -> subprocess.CompletedProcess:
        target = self.proj / "build_deploy_zip.ps1"
        if not target.exists():
            raise AssertionError("스크립트 복사가 커밋 전에 필요함")
        return subprocess.run(
            [self.pwsh, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(target), *extra],
            cwd=str(self.proj), capture_output=True, timeout=120,
        )

    def install_script(self) -> None:
        shutil.copyfile(self.script, self.proj / "build_deploy_zip.ps1")

    def zip_path(self, i: int = 0) -> Path:
        return self.proj / self.zip_names[i]

    def read_zip(self) -> dict:
        with zipfile.ZipFile(self.zip_path()) as zf:
            return {n: zf.read(n) for n in zf.namelist()}

    def report(self) -> dict:
        return json.loads((self.proj / self.report_name).read_text(encoding="utf-8"))

    def assert_ok(self, res: subprocess.CompletedProcess) -> None:
        self.assertEqual(res.returncode, 0, msg=res.stderr.decode("utf-8", "replace") + res.stdout.decode("utf-8", "replace"))

    def assert_fail(self, res: subprocess.CompletedProcess, needle: str) -> None:
        err = res.stderr.decode("utf-8", "replace")
        self.assertNotEqual(res.returncode, 0, msg="실패해야 하는데 성공함: " + res.stdout.decode("utf-8", "replace"))
        self.assertIn(needle, err)
        for name in self.zip_names:
            self.assertFalse((self.proj / name).exists(), f"실패 시 {name} 이 남으면 안 됨")
            self.assertFalse((self.proj / (name + ".partial")).exists())

    def assert_provenance(self, head: str, dirty: bool = False) -> None:
        entries = self.read_zip()
        zip_bytes = self.zip_path().read_bytes()
        rep = self.report()
        manifest_raw = entries[self.manifest_path]
        manifest = json.loads(manifest_raw.decode("utf-8"))

        self.assertEqual(manifest["commit"], head)
        self.assertRegex(manifest["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(manifest["dirty"], dirty)
        self.assertEqual(manifest["format"], "replayce-deploy-manifest/1")
        self.assertEqual(set(manifest), {"format", "project", "commit", "dirty", "public_config", "files"})

        listed = {f["path"]: f for f in manifest["files"]}
        self.assertEqual(set(listed), set(entries) - {self.manifest_path})
        for path, rec in listed.items():
            self.assertEqual(rec["sha256"], sha256(entries[path]), path)
            self.assertEqual(rec["bytes"], len(entries[path]), path)
        self.assertEqual([f["path"] for f in manifest["files"]], sorted(listed))

        # 계정명·로컬 절대 경로·환경변수가 공개 표식에 없어야 함
        text = manifest_raw.decode("utf-8")
        for bad in {str(self.tmp), str(self.repo), getpass.getuser(), os.environ.get("HOME", "/nonexistent-home")}:
            if bad and len(bad) > 2:
                self.assertNotIn(bad, text)
        self.assertNotIn(SENTINEL, text)

        # ZIP 해시는 ZIP 밖 보고서에만 (순환 없음)
        self.assertEqual(rep["commit"], head)
        self.assertEqual(rep["dirty"], dirty)
        self.assertEqual(rep["manifest_sha256"], sha256(manifest_raw))
        self.assertEqual(rep["file_count"], len(listed))
        self.assertEqual([z["name"] for z in rep["zips"]], list(self.zip_names))
        for i, z in enumerate(rep["zips"]):
            self.assertEqual(z["sha256"], sha256(self.zip_path(i).read_bytes()))
        self.assertNotIn(self.report_name, entries)
        self.assertNotIn(sha256(zip_bytes).encode(), b"".join(entries.values()))

        for name, data in entries.items():
            self.assertNotIn(SENTINEL.encode(), data, name)
            self.assertNotIn("\\", name)


class Project01Cases(PackagingCases):
    project_dir = "01_합성_운영시스템"
    script = SCRIPT_01
    zip_names = ("bongplay_deploy.zip",)
    report_name = "bongplay_deploy.verify.json"
    manifest_path = "deploy-manifest.json"

    def setUp(self) -> None:
        super().setUp()
        (self.repo / ".gitignore").write_text(GITIGNORE, encoding="utf-8")
        self.populate(NORMAL_01)
        self.populate(BLOCKED_01)
        self.install_script()
        self.head = self.commit()

    def test_normal_files_preserved_and_secrets_excluded(self):
        self.write("assets/config.js", good_config())
        res = self.run_script()
        self.assert_ok(res)
        entries = self.read_zip()
        expected = set(NORMAL_01) | {"assets/config.js", self.manifest_path}
        self.assertEqual(set(entries), expected)
        for rel, content in NORMAL_01.items():
            self.assertEqual(entries[rel], content.encode("utf-8"), rel)
        excluded = {e["path"] for e in self.report()["excluded"]}
        self.assertTrue(set(BLOCKED_01) <= excluded, set(BLOCKED_01) - excluded)
        self.assertIn("build_deploy_zip.ps1", excluded)

    def test_provenance_manifest_and_report(self):
        cfg = good_config()
        self.write("assets/config.js", cfg)
        self.assert_ok(self.run_script())
        self.assert_provenance(self.head)
        manifest = json.loads(self.read_zip()[self.manifest_path])
        self.assertEqual(manifest["project"], "01_bongplay_ops")
        pc = manifest["public_config"]
        self.assertEqual(len(pc), 1)
        self.assertEqual(pc[0]["path"], "assets/config.js")
        self.assertEqual(pc[0]["sha256"], sha256(cfg.encode("utf-8")))
        self.assertFalse(pc[0]["tracked_in_git"])
        self.assertEqual(self.report()["public_config"], pc)

    def test_rerun_is_deterministic_and_outputs_not_dirty(self):
        self.write("assets/config.js", good_config())
        self.assert_ok(self.run_script())
        first = self.zip_path().read_bytes()
        self.assert_ok(self.run_script())
        self.assertEqual(sha256(self.zip_path().read_bytes()), sha256(first))

    def test_missing_public_config_fails_without_dummy(self):
        self.write("assets/config.js", good_config())
        self.assert_ok(self.run_script())  # 오래된 ZIP 이 남는지도 함께 확인
        (self.proj / "assets/config.js").unlink()
        res = self.run_script()
        self.assert_fail(res, "assets/config.js")
        self.assertFalse((self.proj / "assets/config.js").exists(), "더미 설정을 만들면 안 됨")
        self.assertFalse((self.proj / self.report_name).exists())

    def test_placeholder_config_fails(self):
        self.write("assets/config.js", CONFIG_TEMPLATE)
        self.assert_fail(self.run_script(), "YOUR_")

    def test_service_role_jwt_in_config_fails(self):
        self.write("assets/config.js", good_config().replace(fake_jwt("anon"), fake_jwt("service_role")))
        self.assert_fail(self.run_script(), "service_role")

    def test_private_key_body_in_public_asset_fails(self):
        self.write("assets/config.js", good_config())
        body = base64.b64encode((SENTINEL * 3).encode()).decode()
        self.write("assets/bongplay-site.js", f"var k=`-----BEGIN PRIVATE KEY-----\n{body}\n-----END PRIVATE KEY-----`;\n")
        self.commit()
        self.assert_fail(self.run_script(), "개인 키")

    def test_dirty_tracked_change_fails(self):
        self.write("assets/config.js", good_config())
        self.write("pages/master.html", "<p>changed</p>\n")
        self.assert_fail(self.run_script(), "커밋되지 않은 변경")

    def test_dirty_untracked_file_fails_and_allow_dirty_records(self):
        self.write("assets/config.js", good_config())
        self.write("pages/new.html", "<p>new</p>\n")
        self.assert_fail(self.run_script(), "커밋되지 않은 변경")
        res = self.run_script("-AllowDirty")
        self.assert_ok(res)
        self.assert_provenance(self.head, dirty=True)
        # 추적되지 않은 파일은 -AllowDirty 에서도 후보가 아님
        self.assertNotIn("pages/new.html", self.read_zip())

    def test_ignored_untracked_file_not_packaged(self):
        self.write("assets/config.js", good_config())
        (self.repo / ".gitignore").write_text(GITIGNORE + "**/pages/firebase-config.js\n", encoding="utf-8")
        self.commit()
        self.write("pages/firebase-config.js", f"var k='{SENTINEL}';\n")
        self.assert_ok(self.run_script())
        self.assertNotIn("pages/firebase-config.js", self.read_zip())

    def test_tracked_symlink_to_outside_fails(self):
        outside = self.tmp / "outside_secret.js"
        outside.write_text(f"var k='{SENTINEL}';\n", encoding="utf-8")
        self.write("assets/config.js", good_config())
        make_file_link(self.proj / "assets" / "linked.js", outside, self)
        self.commit()
        self.assert_fail(self.run_script(), "링크")

    def test_public_config_symlink_to_outside_fails(self):
        outside = self.tmp / "outside_config.js"
        outside.write_text(good_config(), encoding="utf-8")
        make_file_link(self.proj / "assets" / "config.js", outside, self)
        self.assert_fail(self.run_script(), "링크")

    def test_symlinked_directory_fails(self):
        if os.name == "nt":
            self.skipTest("git 이 Windows 에서 폴더 링크를 추적하는 방식이 달라 건너뜀 — 정션 시험이 대신 검사")
        outside = self.tmp / "outside_dir"
        outside.mkdir()
        (outside / "a.html").write_text(f"<p>{SENTINEL}</p>\n", encoding="utf-8")
        self.write("assets/config.js", good_config())
        make_dir_link(self.proj / "pages" / "linked", outside, self)
        self.commit()
        self.assert_fail(self.run_script(), "링크")

    def test_tracked_directory_replaced_by_link_fails(self):
        # 추적 폴더(forms)를 프로젝트 밖으로 옮기고 그 자리에 정션/심볼릭 링크를 둔다.
        # -AllowDirty 로 dirty 판정을 넘겨도 링크 검사에서 실패해야 한다.
        self.write("assets/config.js", good_config())
        outside = self.tmp / "outside_forms"
        shutil.move(str(self.proj / "forms"), str(outside))
        (outside / "index.html").write_text(f"<p>{SENTINEL}</p>\n", encoding="utf-8")
        make_dir_link(self.proj / "forms", outside, self)
        self.assert_fail(self.run_script("-AllowDirty"), "링크")

    def test_outside_git_repo_fails(self):
        plain = self.tmp / "plain"
        plain.mkdir()
        shutil.copyfile(self.script, plain / "build_deploy_zip.ps1")
        res = subprocess.run([self.pwsh, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(plain / "build_deploy_zip.ps1")],
                             cwd=str(plain), capture_output=True, timeout=120)
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse((plain / "bongplay_deploy.zip").exists())


class Project04Cases(PackagingCases):
    project_dir = "04_합성_업무로그"
    script = SCRIPT_04
    zip_names = ("worklog_deploy.zip", "bongchat_deploy.zip")
    report_name = "worklog_deploy.verify.json"
    manifest_path = "public/deploy-manifest.json"

    def setUp(self) -> None:
        super().setUp()
        (self.repo / ".gitignore").write_text(GITIGNORE, encoding="utf-8")
        self.populate(NORMAL_04)
        self.populate(BLOCKED_04)
        self.install_script()
        self.head = self.commit()

    def test_normal_files_preserved_and_secrets_excluded(self):
        self.assert_ok(self.run_script())
        entries = self.read_zip()
        self.assertEqual(set(entries), set(NORMAL_04) | {self.manifest_path})
        for rel, content in NORMAL_04.items():
            self.assertEqual(entries[rel], content.encode("utf-8"), rel)
        excluded = {e["path"] for e in self.report()["excluded"]}
        self.assertTrue(set(BLOCKED_04) <= excluded, set(BLOCKED_04) - excluded)

    def test_provenance_and_alias_zip(self):
        self.assert_ok(self.run_script())
        self.assert_provenance(self.head)
        self.assertEqual(self.zip_path(0).read_bytes(), self.zip_path(1).read_bytes())
        manifest = json.loads(self.read_zip()[self.manifest_path])
        self.assertEqual(manifest["project"], "04_bongchat_worklog")
        self.assertEqual(manifest["public_config"], [])

    def test_missing_required_file_fails(self):
        self.git("rm", "-q", "--", f"{self.project_dir}/public/archive.html")
        self.commit()
        self.assert_fail(self.run_script(), "public/archive.html")

    def test_secret_in_function_source_fails(self):
        self.write("netlify/functions/api.mjs", "const key = 'sk-ant-SENTINELfakeSENTINELfakeSENTINEL';\n")
        self.commit()
        self.assert_fail(self.run_script(), "Anthropic")

    def test_dirty_fails(self):
        self.write("public/index.html", "<p>changed</p>\n")
        self.assert_fail(self.run_script(), "커밋되지 않은 변경")


def _shell_version(path: str) -> str:
    try:
        res = subprocess.run(
            [path, "-NoProfile", "-NonInteractive", "-Command",
             "'{0} {1}' -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition"],
            capture_output=True, timeout=60,
        )
        return res.stdout.decode("utf-8", "replace").strip() or "unknown"
    except OSError as exc:
        return f"실행 불가: {exc}"


def _make_suite_classes() -> None:
    if not SHELLS:
        @unittest.skip("PowerShell 이 없어 패키징 시험을 실행하지 못함 — 환경변수 PWSH 로 경로 지정")
        class PackagingNoShell(unittest.TestCase):
            def test_shell_missing(self):
                pass

        globals()["PackagingNoShell"] = PackagingNoShell
        return
    for label, path in SHELLS:
        version = _shell_version(path)
        for cases in (Project01Cases, Project04Cases):
            name = cases.__name__.replace("Cases", "Tests") + "_" + label
            cls = type(name, (cases, unittest.TestCase), {
                "pwsh": path,
                "__doc__": f"{cases.__name__} on {label} ({version})",
            })
            globals()[name] = cls
        print(f"[packaging] {label}: {path} -> PowerShell {version}", file=sys.stderr)


_make_suite_classes()


if __name__ == "__main__":
    unittest.main()
