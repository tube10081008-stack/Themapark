[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json')
)

$ErrorActionPreference = 'Stop'
$fuguRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$projectRoot = (Resolve-Path $config.projectRoot).Path

Write-Output '=== Fugu status ==='
Write-Output ('Fugu:     {0}' -f $fuguRoot)
Write-Output ('Project:  {0}' -f $projectRoot)
Write-Output ('Git repo: {0}' -f (Test-Path -LiteralPath (Join-Path $projectRoot '.git')))
Write-Output ('Snapshot: {0}' -f (Test-Path -LiteralPath (Join-Path $fuguRoot 'snapshot.json')))
Write-Output ''

if (Test-Path -LiteralPath (Join-Path $fuguRoot 'SNAPSHOT.md')) {
    Get-Content -LiteralPath (Join-Path $fuguRoot 'SNAPSHOT.md') -Encoding UTF8 | Select-Object -First 24
}

Write-Output ''
Write-Output '=== High-risk pattern scan (evidence only; review before acting) ==='
$patterns = @(
    'Math\.sin\(',
    'totalRevenue\s*\*\s*0\.3',
    'totalRevenue\s*\*\s*0\.7',
    'endsWith\(phone\.slice',
    'consents\[0\]',
    'getOrdersByDate'
)
$sourceFiles = Get-ChildItem -LiteralPath $projectRoot -File -Recurse -Force |
    Where-Object { $_.Extension -in @('.js','.html','.sql','.mjs','.py') -and $_.FullName -notmatch '\\(node_modules|\.git)\\' }
foreach ($pattern in $patterns) {
    $matches = Select-String -Path $sourceFiles.FullName -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
    $count = @($matches).Count
    Write-Output ("{0}: {1} match(es)" -f $pattern, $count)
    $matches | Select-Object -First 5 | ForEach-Object {
        $rel = $_.Path.Substring($projectRoot.Length).TrimStart('\','/')
        Write-Output ("  {0}:{1}" -f $rel, $_.LineNumber)
    }
}
