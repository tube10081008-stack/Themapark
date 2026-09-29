[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json'),
    [switch]$FullHash
)

$ErrorActionPreference = 'Stop'
$fuguRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$projectRoot = (Resolve-Path $config.projectRoot).Path
$jsonPath = Join-Path $fuguRoot 'snapshot.json'
$mdPath = Join-Path $fuguRoot 'SNAPSHOT.md'

$excludeDirs = @($config.snapshot.excludeDirectories)
$excludePatterns = @($config.snapshot.excludeFilePatterns)

function Test-Excluded([string]$relativePath, [bool]$isDirectory) {
    $parts = $relativePath -split '[\\/]'
    if ($parts | Where-Object { $excludeDirs -contains $_ }) { return $true }
    foreach ($pattern in $excludePatterns) {
        if ((Split-Path $relativePath -Leaf) -like $pattern) { return $true }
    }
    return $false
}

function Get-Rel([string]$fullPath) {
    return $fullPath.Substring($projectRoot.Length).TrimStart('\', '/').Replace('\', '/')
}

$previous = $null
if (Test-Path -LiteralPath $jsonPath) {
    try { $previous = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $previous = $null }
}
$previousMap = @{}
if ($previous -and $previous.files) {
    foreach ($item in $previous.files) { $previousMap[$item.path] = $item }
}

$records = New-Object System.Collections.Generic.List[object]
$excluded = New-Object System.Collections.Generic.List[string]
$files = Get-ChildItem -LiteralPath $projectRoot -File -Recurse -Force
foreach ($file in $files) {
    $relative = Get-Rel $file.FullName
    if (Test-Excluded $relative $false) {
        $excluded.Add($relative)
        continue
    }

    $old = $previousMap[$relative]
    $needsHash = $FullHash -or (-not $old) -or
        ([int64]$old.length -ne [int64]$file.Length) -or
        ([string]$old.lastWriteTimeUtc -ne [string]$file.LastWriteTimeUtc.ToUniversalTime().ToString('o'))
    $hash = if ($needsHash) { (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } else { $old.sha256 }

    $records.Add([ordered]@{
        path = $relative
        length = [int64]$file.Length
        lastWriteTimeUtc = $file.LastWriteTimeUtc.ToUniversalTime().ToString('o')
        sha256 = $hash
    })
}

$records = @($records | Sort-Object path)
$oldPaths = @($previousMap.Keys)
$newPaths = @($records | ForEach-Object { $_.path })
$added = @($newPaths | Where-Object { $_ -notin $oldPaths })
$removed = @($oldPaths | Where-Object { $_ -notin $newPaths })
$changed = @()
foreach ($item in $records) {
    $old = $previousMap[$item.path]
    if ($old -and $old.sha256 -ne $item.sha256) { $changed += $item.path }
}

$snapshot = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    projectRoot = $projectRoot
    mode = if ($FullHash) { 'full-hash' } else { 'changed-files' }
    fileCount = $records.Count
    excludedCount = $excluded.Count
    files = $records
    excluded = @($excluded | Sort-Object)
    diff = [ordered]@{
        added = $added
        changed = $changed
        removed = $removed
    }
}
$snapshot | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $jsonPath -Encoding UTF8

$folderRows = $records | ForEach-Object {
    $top = ($_.path -split '/')[0]
    [PSCustomObject]@{ top = $top; length = [int64]$_.length }
} | Group-Object top | ForEach-Object {
    [PSCustomObject]@{
        folder = $_.Name
        files = $_.Count
        mb = [math]::Round((($_.Group | Measure-Object length -Sum).Sum / 1MB), 2)
    }
} | Sort-Object folder

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Project snapshot')
$lines.Add('')
$lines.Add(('- generated: {0}' -f $snapshot.generatedAt))
$lines.Add(('- root: `{0}`' -f $projectRoot))
$lines.Add(('- tracked files: **{0}**; excluded files: **{1}**; mode: `{2}`' -f $records.Count, $excluded.Count, $snapshot.mode))
$lines.Add('')
$lines.Add('## Diff from previous snapshot')
$lines.Add(('- added: **{0}**' -f $added.Count))
$lines.Add(('- changed: **{0}**' -f $changed.Count))
$lines.Add(('- removed: **{0}**' -f $removed.Count))
if ($added.Count -gt 0) { $lines.Add(''); $lines.Add('### Added'); $added | ForEach-Object { $lines.Add(('- `{0}`' -f $_)) } }
if ($changed.Count -gt 0) { $lines.Add(''); $lines.Add('### Changed'); $changed | ForEach-Object { $lines.Add(('- `{0}`' -f $_)) } }
if ($removed.Count -gt 0) { $lines.Add(''); $lines.Add('### Removed'); $removed | ForEach-Object { $lines.Add(('- `{0}`' -f $_)) } }
$lines.Add('')
$lines.Add('## Top-level summary')
$lines.Add('| Folder/file | Files | MB |')
$lines.Add('|---|---:|---:|')
foreach ($row in $folderRows) { $lines.Add(('| `{0}` | {1} | {2} |' -f $row.folder, $row.files, $row.mb)) }
$lines.Add('')
$lines.Add('## Exclusion policy')
$lines.Add('Large media, archives, secrets, build output, and `_보관` are excluded from hashes by design. If an excluded file matters to a decision, inspect it explicitly and record the result in `FACTS.md`.')
$lines | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Output ('Snapshot updated: {0}' -f $mdPath)
Write-Output ('Added={0}; Changed={1}; Removed={2}; Tracked={3}; Excluded={4}' -f $added.Count, $changed.Count, $removed.Count, $records.Count, $excluded.Count)
