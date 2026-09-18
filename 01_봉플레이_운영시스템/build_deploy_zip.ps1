# ============================================================
# 봉플레이 스마트 운영시스템 — Netlify 배포 패키징 스크립트
# ------------------------------------------------------------
# 규칙:
# 1. POSIX 표준 슬래시(/) 100% 보장 (Netlify Drop 인식 보장)
# 2. SQL 스키마, 파이썬 백엔드, 내부 기획서 웹 유출 원천 차단
# ============================================================

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$src = (Get-Location).Path
$zip = Join-Path $src "bongplay_deploy.zip"

if (Test-Path $zip) { Remove-Item -Force $zip }

$fileStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$zipArchive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create)

# 엄격한 제외 패턴 (SQL 스키마, 파이썬 백엔드, 내부 기획서 웹 유출 원천 차단)
$excludePrefixes = @('database/', 'backend_ai/', 'docs/', '.git/', 'node_modules/', '_보관/', 'tmp/')
$excludeExts = @('.sql', '.py', '.ps1', '.md', '.zip', '.gs', '.bak')
$excludeNames = @('Dockerfile', 'docker-compose.yml', 'requirements.txt', '.gitignore')

$addedCount = 0
$allFiles = Get-ChildItem -Path $src -Recurse -File

foreach ($file in $allFiles) {
    $rel = $file.FullName.Substring($src.Length + 1).Replace('\', '/')
    $skip = $false

    foreach ($p in $excludePrefixes) {
        if ($rel.ToLower().StartsWith($p.ToLower()) -or $rel.ToLower().Contains('/' + $p.ToLower())) {
            $skip = $true
            break
        }
    }

    if (-not $skip) {
        $ext = $file.Extension.ToLower()
        if ($excludeExts -contains $ext) {
            $skip = $true
        }
    }

    if (-not $skip) {
        if ($excludeNames -contains $file.Name) {
            $skip = $true
        }
    }

    if (-not $skip) {
        $entry = $zipArchive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        $content = [System.IO.File]::ReadAllBytes($file.FullName)
        $entryStream.Write($content, 0, $content.Length)
        $entryStream.Dispose()
        $addedCount++
    }
}

$zipArchive.Dispose()
$fileStream.Dispose()

Write-Host "[성공] bongplay_deploy.zip 생성 완료: $((Get-Item $zip).Length) bytes ($addedCount 개 파일 패키징)"
