# prototypes/evidence/ANT-007/stop_prototype.ps1
param (
    [int]$Port = 4192
)

$targetDir = $PSScriptRoot
$pidFile = Join-Path $targetDir ".server.pid"
$shutdownUrl = "http://127.0.0.1:$Port/api/evidence/shutdown"

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "⏹ ANT-007 시제품 서버 종료 시도 (포트: $Port)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

$stopped = $false

# 1. API Shutdown 호출 시도
try {
    $res = Invoke-RestMethod -Uri $shutdownUrl -Method Post -TimeoutSec 2 -ErrorAction Stop
    if ($res.ok -eq $true) {
        Write-Host "✔ API를 통해 정상 종료되었습니다." -ForegroundColor Green
        $stopped = $true
    }
} catch {
    # API 무응답 시 PID 파일 기반 종료
}

# 2. PID 파일 기반 종료
if (Test-Path $pidFile) {
    try {
        $pidNum = Get-Content $pidFile -Raw
        $pidNum = $pidNum.Trim()
        if ($pidNum -match '^\d+$') {
            Stop-Process -Id ([int]$pidNum) -Force -ErrorAction SilentlyContinue
            Write-Host "✔ PID $pidNum 프로세스를 종료했습니다." -ForegroundColor Green
            $stopped = $true
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    } catch {}
}

if (-not $stopped) {
    Write-Host "ℹ 실행 중인 ANT-007 서버가 없거나 이미 종료되었습니다." -ForegroundColor Gray
}
