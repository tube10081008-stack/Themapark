@echo off
set PORT=%1
if "%PORT%"=="" set PORT=4192

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_prototype.ps1" -Port %PORT%
