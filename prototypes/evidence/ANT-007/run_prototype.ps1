# prototypes/evidence/ANT-007/run_prototype.ps1
param (
    [int]$Port = 4192
)

$targetDir = $PSScriptRoot
$serverScript = Join-Path $targetDir "server.js"
$nodeExe = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path $nodeExe)) {
    $nodeExe = "node"
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "🚀 ANT-007 실증 데이터 시제품 서버 기동 (포트: $Port)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# 4189 포트 점유 여부 확인 경고
if ($Port -eq 4189) {
    Write-Warning "경고: 4189 포트는 기존 지오 시험 환경 포트입니다. 기본 4192 또는 다른 포트를 사용하세요."
}

# 서버 백그라운드 프로세스 기동
$proc = Start-Process -FilePath $nodeExe -ArgumentList "`"$serverScript`" --port $Port" -PassThru -WindowStyle Hidden

Start-Sleep -Milliseconds 800

# 기동 확인
$readyUrl = "http://127.0.0.1:$Port/ready"
try {
    $res = Invoke-RestMethod -Uri $readyUrl -Method Get -TimeoutSec 3 -ErrorAction Stop
    if ($res.ok -eq $true) {
        Write-Host "✔ 서버 기동 성공 (PID: $($res.server_pid), 포트: $Port)" -ForegroundColor Green
        Write-Host "🌐 웹 화면 접속 URL: http://127.0.0.1:$Port/" -ForegroundColor Yellow
        Write-Host "🔍 준비 확인 URL:    http://127.0.0.1:$Port/ready" -ForegroundColor Yellow
        Write-Host "⏹ 서버 종료 명령:    .\stop_prototype.ps1 -Port $Port" -ForegroundColor Gray
    }
} catch {
    Write-Host "❌ 서버 기동 확인 실패: $_" -ForegroundColor Red
}
