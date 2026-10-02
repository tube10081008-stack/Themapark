# ============================================================
# 봉플레이 스마트 운영시스템 — Netlify 배포 패키징 스크립트
# ------------------------------------------------------------
# 규칙:
# 1. POSIX 표준 슬래시(/) 100% 보장 (Netlify Drop 인식 보장)
# 2. SQL 스키마, 파이썬 백엔드, 내부 기획서 웹 유출 원천 차단
# 3. 허용 목록 방식: git 추적 파일 중 허용 경로만 + 명시된 공개 설정(assets/config.js)
#    (.env 변형·키/인증서·자격증명·VCS·임시·시험·증거·원시 자료는 2차 차단 규칙으로 한 번 더 막음)
# 4. 필수 공개 설정이 없거나 템플릿 자리표시자가 남아 있으면 실패 (더미 설정 자동 삽입 없음)
# 5. 심볼릭 링크·정션을 지나는 파일이 있으면 실패 (프로젝트 밖 파일 유입 차단)
# 6. 커밋되지 않은 변경이 있으면 기본 실패 (-AllowDirty 로만 예외, 표식에 기록)
# 7. ZIP 안 deploy-manifest.json: 전체 commit SHA·프로젝트 구분·형식 버전·파일 해시
#    (계정명·로컬 절대 경로·환경변수·생성 시각은 기록하지 않음)
# 8. 최종 ZIP SHA-256 은 ZIP 밖 bongplay_deploy.verify.json 에 기록
# 사용: 01_봉플레이_운영시스템 폴더에서 .\build_deploy_zip.ps1
# ============================================================

[CmdletBinding()]
param(
    # 기본값은 기존과 같이 현재 폴더. 합성 시험에서는 다른 폴더를 지정한다.
    [string]$ProjectRoot = (Get-Location).Path,
    # 커밋되지 않은 변경이 있어도 만들 때만 사용. 표식과 보고서에 dirty=true 로 남는다.
    [switch]$AllowDirty
)

# ---- 프로젝트별 설정 --------------------------------------------------------
$ProjectId = '01_bongplay_ops'
$ZipNames = @('bongplay_deploy.zip')
$ReportName = 'bongplay_deploy.verify.json'
$ManifestPath = 'deploy-manifest.json'
$FormatVersion = 'replayce-deploy-manifest/1'
$ReportFormat = 'replayce-deploy-verify/1'
$RequiredFiles = @('index.html', 'netlify.toml', 'assets/config.js')
# 브라우저에 공개되는 설정 (Supabase URL·anon 키 등). git 에서 무시되므로 해시를 따로 기록한다.
$PublicConfigFiles = @('assets/config.js')
$ConfigPlaceholders = @('YOUR_PROJECT_ID', 'YOUR_ANON_PUBLIC_KEY', 'YOUR_DEPLOYMENT_ID')
$AllowPatterns = @(
    '^index\.html$', '^manifest\.json$', '^sw\.js$', '^netlify\.toml$', '^_redirects$', '^_headers$',
    '^pages/[^/]+\.(html|css|js)$',
    '^forms/[^/]+\.(html|css|js)$',
    '^assets/[^/]+\.(js|css)$',
    '^assets/images/(?:[^/]+/)*[^/]+\.(png|jpe?g|gif|svg|webp|ico)$',
    '^netlify/functions/[^/]+\.(mjs|js)$'
)
# 허용 패턴에 걸리지만 배포하지 않는 파일
$ExcludeExact = @('assets/config.template.js')

# ---------------------------------------------------------------------------
# 이하 공통 패키징 본체 (01/04 스크립트에 같은 내용으로 들어 있음)
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# 경로 이름에 들어가면 패키징하지 않는 폴더 (대소문자 무시, 모든 깊이)
$DeniedSegments = @(
    '.git', '.svn', '.hg', 'node_modules', '.netlify', '__pycache__', '.vscode', '.idea',
    'tmp', 'temp', 'test', 'tests', '__tests__', 'fixtures', 'evidence', 'qa', 'raw',
    'backup', 'backups', 'database', 'backend_ai', 'docs', '_보관'
)
# 파일 이름 차단 규칙 (대소문자 무시) — 허용 목록 뒤의 2차 방어선
$DeniedNamePatterns = @(
    '^\.env$', '^\.env\.', '\.env$', '^\.envrc$', '^\.dev\.vars',
    '\.(pem|key|p8|p12|pfx|jks|keystore|crt|cer|der|csr|asc|gpg|kdbx|ovpn)$',
    '^id_(rsa|dsa|ecdsa|ed25519)', 'credential', 'secret', 'service[-_]?account', 'adminsdk',
    '^\.npmrc$', '^\.netrc$', '^\.htpasswd$', '^\.pgpass$',
    '\.(bak|tmp|temp|swp|swo|log|orig|rej|old)$', '~$', '^#.*#$',
    '^\.ds_store$', '^thumbs\.db$', '^desktop\.ini$',
    '\.(zip|7z|tar|gz|tgz|rar|ps1|psm1|bat|cmd|sh|sql|sqlite|db|py|ipynb|gs|md|csv|tsv|xlsx?|docx?|hwpx?|pdf)$'
)
# 내용 검사 대상 확장자
$TextExtensions = @('.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.toml', '.txt', '.svg', '.xml', '.webmanifest', '')

$FixedTime = New-Object DateTimeOffset 2000, 1, 1, 0, 0, 0, ([TimeSpan]::Zero)
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Stop-Build([string]$Message) {
    throw "[실패] $Message"
}

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Bytes)
    } finally {
        $sha.Dispose()
    }
    return (-join ($hash | ForEach-Object { $_.ToString('x2') }))
}

function Test-Denied([string]$Rel) {
    $parts = $Rel.Split('/')
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        foreach ($seg in $DeniedSegments) {
            if ($parts[$i].ToLowerInvariant() -eq $seg.ToLowerInvariant()) {
                return "차단 폴더($($parts[$i]))"
            }
        }
    }
    $name = $parts[$parts.Length - 1]
    foreach ($pat in $DeniedNamePatterns) {
        if ($name -imatch $pat) {
            return "차단 이름 규칙($pat)"
        }
    }
    return $null
}

function Test-Allowed([string]$Rel) {
    foreach ($ex in $ExcludeExact) {
        if ($Rel -ieq $ex) { return $false }
    }
    foreach ($pat in $AllowPatterns) {
        # 허용 목록은 대소문자를 구분한다 (배포 경로는 저장소의 실제 이름과 같아야 함)
        if ($Rel -cmatch $pat) { return $true }
    }
    return $false
}

function Invoke-Git([string]$Root, [string[]]$GitArgs) {
    $out = & git -c core.quotepath=false -C $Root @GitArgs 2>$null
    if ($LASTEXITCODE -ne 0) {
        Stop-Build "git $($GitArgs[0]) 실행 실패 (git 저장소 안에서 실행해야 합니다)"
    }
    return $out
}

function Split-NulOutput($Out) {
    if ($null -eq $Out) { return @() }
    $joined = (@($Out) -join "`n")
    return @($joined.Split([char]0) | Where-Object { $_ -ne '' })
}

function Assert-NoLinkOnPath([string]$Root, [string]$Rel) {
    # 루트 아래의 각 경로 단계가 심볼릭 링크·정션(재분석 지점)이 아니어야 한다
    $cur = $Root
    foreach ($part in $Rel.Split('/')) {
        $cur = [System.IO.Path]::Combine($cur, $part)
        if (-not ([System.IO.File]::Exists($cur) -or [System.IO.Directory]::Exists($cur))) {
            return
        }
        $attr = [System.IO.File]::GetAttributes($cur)
        if (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            Stop-Build "링크·재분석 지점 발견: $Rel (프로젝트 밖 파일 유입 방지를 위해 중단)"
        }
    }
}

function Assert-NoSecretContent([string]$Rel, [byte[]]$Bytes) {
    $ext = [System.IO.Path]::GetExtension($Rel).ToLowerInvariant()
    if ($TextExtensions -notcontains $ext) { return }
    $text = [System.Text.Encoding]::UTF8.GetString($Bytes)

    $rules = [ordered]@{
        '개인 키 본문'          = '-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}'
        '서비스 계정 private_key' = '"private_key"\s*:\s*"-----BEGIN'
        'Anthropic 키'          = 'sk-ant-[A-Za-z0-9_\-]{20,}'
        'Google API 키'         = 'AIza[0-9A-Za-z_\-]{35}'
        'Discord 웹훅 주소'     = 'discord(app)?\.com/api/webhooks/[0-9]{5,}/[A-Za-z0-9_\-]{20,}'
    }
    foreach ($k in $rules.Keys) {
        if ($text -match $rules[$k]) {
            Stop-Build "비밀값으로 보이는 내용($k) 발견: $Rel"
        }
    }

    # JWT 형식이면 payload 의 role 을 확인해 service_role 키를 막는다
    $jwtMatches = [regex]::Matches($text, 'eyJ[A-Za-z0-9_\-]{8,}\.(eyJ[A-Za-z0-9_\-]{8,})\.[A-Za-z0-9_\-]{8,}')
    foreach ($m in $jwtMatches) {
        $payload = $m.Groups[1].Value.Replace('-', '+').Replace('_', '/')
        switch ($payload.Length % 4) {
            2 { $payload += '==' }
            3 { $payload += '=' }
        }
        $decoded = ''
        try {
            $decoded = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
        } catch {
            $decoded = ''
        }
        if ($decoded -match '"role"\s*:\s*"service_role"') {
            Stop-Build "service_role 권한 JWT 발견: $Rel (공개 배포에는 anon 키만 허용)"
        }
    }
}

function Get-OwnOutputNames {
    $names = @()
    foreach ($z in $ZipNames) { $names += $z; $names += "$z.partial" }
    $names += $ReportName
    $names += "$ReportName.partial"
    return $names
}

function New-DeployZip {
    if (-not [System.IO.Directory]::Exists($ProjectRoot)) {
        Stop-Build "프로젝트 폴더가 없습니다: $ProjectRoot"
    }
    $root = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd([char]'/', [char]'\')
    $ownOutputs = @(Get-OwnOutputNames)
    # 이전 산출물은 먼저 지운다 (이번 실행이 실패하면 오래된 ZIP 이 남아 배포되는 일을 막음)
    foreach ($o in $ownOutputs) {
        $op = [System.IO.Path]::Combine($root, $o)
        if ([System.IO.File]::Exists($op)) { [System.IO.File]::Delete($op) }
    }

    # 1) 출처: 전체 commit SHA
    $commit = (@(Invoke-Git $root @('rev-parse', 'HEAD')) -join '').Trim()
    if ($commit -notmatch '^[0-9a-f]{40}$') {
        Stop-Build "commit SHA 를 확인할 수 없습니다"
    }

    # 2) dirty checkout 기본 실패 (이 스크립트의 산출물은 제외)
    $statusArgs = @('status', '--porcelain', '-z', '--untracked-files=all', '--', '.')
    foreach ($o in $ownOutputs) { $statusArgs += ":(exclude,top)$($ProjectPrefix)$o" }
    $dirtyEntries = @(Split-NulOutput (Invoke-Git $root $statusArgs))
    $dirty = ($dirtyEntries.Count -gt 0)
    if ($dirty -and -not $AllowDirty) {
        Stop-Build "커밋되지 않은 변경 $($dirtyEntries.Count)건이 있습니다. 커밋 후 다시 실행하세요 (-AllowDirty 는 표식에 dirty=true 로 기록됨)"
    }

    # 3) 후보 = git 추적 파일 + 명시된 공개 설정 파일 (무시된 기타 파일은 후보가 아님)
    $tracked = @(Split-NulOutput (Invoke-Git $root @('ls-files', '-z', '--full-name', '--', '.')))
    $candidates = New-Object System.Collections.Generic.List[string]
    $prefixLen = $ProjectPrefix.Length
    foreach ($t in $tracked) {
        if ($prefixLen -gt 0) {
            if (-not $t.StartsWith($ProjectPrefix, [System.StringComparison]::Ordinal)) { continue }
            $candidates.Add($t.Substring($prefixLen))
        } else {
            $candidates.Add($t)
        }
    }
    foreach ($p in $PublicConfigFiles) {
        if (-not $candidates.Contains($p)) { $candidates.Add($p) }
    }

    $selected = New-Object System.Collections.Generic.List[string]
    $excluded = New-Object System.Collections.Generic.List[object]
    foreach ($rel in $candidates) {
        if ($rel -match '(^|/)\.\.(/|$)' -or $rel.Contains(':') -or $rel.StartsWith('/') -or $rel.Contains('\')) {
            Stop-Build "허용되지 않는 경로 형식: $rel"
        }
        if ($ownOutputs -contains $rel) { continue }
        $full = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $rel))
        if (-not $full.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::Ordinal)) {
            Stop-Build "프로젝트 밖 경로: $rel"
        }
        # 링크 검사는 허용·차단 판정보다 먼저 (제외될 파일이라도 링크가 있으면 명시적으로 실패)
        Assert-NoLinkOnPath $root $rel
        $reason = Test-Denied $rel
        if ($null -ne $reason) {
            $excluded.Add([ordered]@{ path = $rel; reason = $reason })
            continue
        }
        if (-not (Test-Allowed $rel)) {
            $excluded.Add([ordered]@{ path = $rel; reason = '허용 목록 밖' })
            continue
        }
        if (-not [System.IO.File]::Exists($full)) {
            if ($PublicConfigFiles -contains $rel) { continue }
            Stop-Build "추적 파일이 작업 폴더에 없습니다: $rel"
        }
        $selected.Add($rel)
    }

    # 4) 필수 파일 — 없으면 명시적으로 실패 (더미 설정을 자동으로 넣지 않음)
    foreach ($req in $RequiredFiles) {
        if (-not $selected.Contains($req)) {
            Stop-Build "필수 파일 누락: $req (더미 설정을 자동으로 넣지 않습니다. 실제 공개 설정을 준비한 뒤 다시 실행하세요)"
        }
    }
    if ($selected.Contains($ManifestPath)) {
        Stop-Build "배포 표식 경로와 같은 이름의 파일이 있습니다: $ManifestPath"
    }

    # 5) 파일 읽기·내용 검사·해시 (정렬 순서 고정)
    $sorted = @($selected.ToArray())
    [Array]::Sort($sorted, [System.StringComparer]::Ordinal)
    $fileRecords = New-Object System.Collections.Generic.List[object]
    $payloads = @{}
    $publicConfig = New-Object System.Collections.Generic.List[object]
    foreach ($rel in $sorted) {
        $bytes = [System.IO.File]::ReadAllBytes([System.IO.Path]::Combine($root, $rel))
        Assert-NoSecretContent $rel $bytes
        $hash = Get-Sha256Hex $bytes
        if ($PublicConfigFiles -contains $rel) {
            $text = [System.Text.Encoding]::UTF8.GetString($bytes)
            foreach ($ph in $ConfigPlaceholders) {
                if ($text.Contains($ph)) {
                    Stop-Build "공개 설정에 템플릿 자리표시자($ph)가 남아 있습니다: $rel"
                }
            }
            $isTracked = $tracked -contains ($ProjectPrefix + $rel)
            $publicConfig.Add([ordered]@{ path = $rel; sha256 = $hash; bytes = $bytes.Length; tracked_in_git = $isTracked })
        }
        $payloads[$rel] = $bytes
        $fileRecords.Add([ordered]@{ path = $rel; sha256 = $hash; bytes = $bytes.Length })
    }

    # 6) 공개 배포 표식 (계정명·로컬 절대 경로·환경변수·시각을 넣지 않음)
    $manifest = [ordered]@{
        format        = $FormatVersion
        project       = $ProjectId
        commit        = $commit
        dirty         = $dirty
        public_config = @($publicConfig.ToArray())
        files         = @($fileRecords.ToArray())
    }
    $manifestBytes = $Utf8NoBom.GetBytes(($manifest | ConvertTo-Json -Depth 6) + "`n")
    $manifestHash = Get-Sha256Hex $manifestBytes

    # 7) ZIP 작성 (임시 파일에 쓰고 성공 시 교체)
    $zipPath = [System.IO.Path]::Combine($root, $ZipNames[0])
    $partial = "$zipPath.partial"
    if ([System.IO.File]::Exists($partial)) { [System.IO.File]::Delete($partial) }
    try {
        $fileStream = [System.IO.File]::Open($partial, [System.IO.FileMode]::CreateNew)
        try {
            $zipArchive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create)
            try {
                $entryNames = @($sorted) + @($ManifestPath)
                foreach ($rel in $entryNames) {
                    if ($rel -eq $ManifestPath) { $content = $manifestBytes } else { $content = $payloads[$rel] }
                    $entry = $zipArchive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
                    $entry.LastWriteTime = $FixedTime
                    $entryStream = $entry.Open()
                    try {
                        $entryStream.Write($content, 0, $content.Length)
                    } finally {
                        $entryStream.Dispose()
                    }
                }
            } finally {
                $zipArchive.Dispose()
            }
        } finally {
            $fileStream.Dispose()
        }
        if ([System.IO.File]::Exists($zipPath)) { [System.IO.File]::Delete($zipPath) }
        [System.IO.File]::Move($partial, $zipPath)
    } catch {
        if ([System.IO.File]::Exists($partial)) { [System.IO.File]::Delete($partial) }
        throw
    }

    $zipBytes = [System.IO.File]::ReadAllBytes($zipPath)
    $zipHash = Get-Sha256Hex $zipBytes
    $zipRecords = New-Object System.Collections.Generic.List[object]
    $zipRecords.Add([ordered]@{ name = $ZipNames[0]; sha256 = $zipHash; bytes = $zipBytes.Length })
    for ($i = 1; $i -lt $ZipNames.Count; $i++) {
        $aliasPath = [System.IO.Path]::Combine($root, $ZipNames[$i])
        [System.IO.File]::Copy($zipPath, $aliasPath, $true)
        $zipRecords.Add([ordered]@{ name = $ZipNames[$i]; sha256 = $zipHash; bytes = $zipBytes.Length })
    }

    # 8) 검증 보고서 — ZIP 밖에 둔다 (ZIP 해시를 ZIP 안에 넣는 순환을 피함)
    $report = [ordered]@{
        format          = $ReportFormat
        project         = $ProjectId
        commit          = $commit
        dirty           = $dirty
        zips            = @($zipRecords.ToArray())
        manifest_path   = $ManifestPath
        manifest_sha256 = $manifestHash
        file_count      = $fileRecords.Count
        public_config   = @($publicConfig.ToArray())
        excluded        = @($excluded.ToArray())
    }
    $reportPath = [System.IO.Path]::Combine($root, $ReportName)
    [System.IO.File]::WriteAllBytes($reportPath, $Utf8NoBom.GetBytes(($report | ConvertTo-Json -Depth 6) + "`n"))

    $zipList = ($ZipNames -join ' & ')
    Write-Host "[성공] $zipList 생성 완료: $($zipBytes.Length) bytes ($($fileRecords.Count) 개 파일 패키징 + 배포 표식 $ManifestPath)"
    Write-Host "       commit $commit$(if ($dirty) { ' (dirty)' })"
    Write-Host "       ZIP SHA-256 $zipHash -> $ReportName"
}

$prevOutEnc = $null
try {
    try {
        $prevOutEnc = [Console]::OutputEncoding
        [Console]::OutputEncoding = $Utf8NoBom
    } catch {
        $prevOutEnc = $null
    }
    # 프로젝트 폴더의 저장소 내 위치(접두 경로)를 구한다
    $prefixOut = & git -C $ProjectRoot rev-parse --show-prefix 2>$null
    if ($LASTEXITCODE -ne 0) { Stop-Build "git 저장소 안의 프로젝트 폴더에서 실행해야 합니다: $ProjectRoot" }
    $ProjectPrefix = (@($prefixOut) -join '').Trim()
    New-DeployZip
    $code = 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $code = 1
} finally {
    if ($null -ne $prevOutEnc) {
        try { [Console]::OutputEncoding = $prevOutEnc } catch { }
    }
}
exit $code
