# ============================================================
# 봉챗 (봉뜨락 업무로그 & 아카이브) — Netlify 배포 패키징 스크립트
# ------------------------------------------------------------
# 규칙:
# 1. POSIX 표준 슬래시(/) 100% 보장 (Netlify Drop 인식)
# 2. 불필요한 임시 파일 및 숨김 파일 제외
# ============================================================

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$src = (Get-Location).Path
$zip = Join-Path $src "worklog_deploy.zip"
$zipBongchat = Join-Path $src "bongchat_deploy.zip"

if (Test-Path $zip) { Remove-Item -Force $zip }
if (Test-Path $zipBongchat) { Remove-Item -Force $zipBongchat }

$fileStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$zipArchive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create)

$excludePrefixes = @('.git/', 'node_modules/', 'tmp/')
$excludeExts = @('.zip', '.ps1', '.bak')
$excludeNames = @('.gitignore')

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

# Copy to bongchat_deploy.zip as alias
Copy-Item $zip $zipBongchat -Force

Write-Host "[성공] worklog_deploy.zip & bongchat_deploy.zip 생성 완료: $((Get-Item $zip).Length) bytes ($addedCount 개 파일 패키징)"
