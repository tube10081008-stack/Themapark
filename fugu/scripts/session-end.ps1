[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Summary,
    [string]$ChangedFiles = '없음',
    [string]$Tests = '실행하지 않음',
    [string]$Remaining = '없음'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss K'
$entry = @(
    ''
    "## $stamp — 세션 종료"
    "- 요약: $Summary"
    "- 변경 파일: $ChangedFiles"
    "- 테스트: $Tests"
    "- 남은 문제: $Remaining"
)
Add-Content -LiteralPath (Join-Path $root 'LOG.md') -Value $entry -Encoding UTF8
& (Join-Path $PSScriptRoot 'snapshot.ps1')
Write-Output 'Session handoff appended and snapshot refreshed.'
