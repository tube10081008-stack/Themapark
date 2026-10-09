# ANT-006 지오(Aside) 합성 시험 서버 기동 스크립트 (PowerShell)
Write-Host "🚀 지오 합성 시험 환경을 기동합니다..." -ForegroundColor Cyan
& "C:\Program Files\nodejs\node.exe" "01_봉플레이_운영시스템/tests/synthetic_server.js"
