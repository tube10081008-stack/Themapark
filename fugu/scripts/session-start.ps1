[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& (Join-Path $PSScriptRoot 'snapshot.ps1')
Write-Output ''
Write-Output '=== Read before acting ==='
Write-Output (Join-Path $root 'INDEX.md')
Write-Output (Join-Path $root 'SNAPSHOT.md')
Write-Output (Join-Path $root 'FACTS.md')
Write-Output (Join-Path $root 'OPEN_QUESTIONS.md')
Write-Output ''
Write-Output '=== Session rules ==='
Write-Output 'Evidence needs file:line or an executed test.'
Write-Output 'Separate current implementation from target workflow.'
Write-Output 'Do not edit project source until scope is explicit.'
