# Install eleven into a project as .\eleven, hidden from git via .git\info\exclude.
#   .\install.ps1 [project_dir]            install; never overwrites existing files
#   .\install.ps1 -Update [project_dir]    also refresh AGENTS.md, agents\, templates\, docs\, ui\
# The project's own files (project.md, work\, decisions\) are never overwritten.
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File install.ps1 <project_dir>
param(
  [switch]$Update,
  [Parameter(Position = 0)][string]$Project = "."
)
$ErrorActionPreference = "Stop"

$kit = $PSScriptRoot
$project = (Resolve-Path $Project).Path
$dest = Join-Path $project "eleven"

if ((Resolve-Path $kit).Path -eq $dest) {
  Write-Error "This is the kit itself. Run it against a project: .\install.ps1 C:\path\to\project"
}

New-Item -ItemType Directory -Force (Join-Path $dest "work"), (Join-Path $dest "decisions") | Out-Null

function Copy-Missing($src, $dst) {
  # Copy a file or folder tree, skipping files that already exist.
  if (Test-Path $src -PathType Leaf) {
    if (-not (Test-Path $dst)) { Copy-Item $src $dst }
    return
  }
  Get-ChildItem $src -Recurse -File | ForEach-Object {
    $target = Join-Path $dst $_.FullName.Substring($src.Length).TrimStart('\', '/')
    if (-not (Test-Path $target)) {
      New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
      Copy-Item $_.FullName $target
    }
  }
}

foreach ($item in "AGENTS.md", "README.md", "install.sh", "install.ps1", "agents", "templates", "docs", "ui") {
  $src = Join-Path $kit $item
  $dst = Join-Path $dest $item
  if ($Update) {
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item $src $dst -Recurse
  } else {
    Copy-Missing $src $dst
  }
}
$projectMd = Join-Path $dest "project.md"
if (-not (Test-Path $projectMd)) { Copy-Item (Join-Path $kit "templates\project.md") $projectMd }

git -C $project rev-parse --git-dir 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  $exclude = (git -C $project rev-parse --path-format=absolute --git-path info/exclude).Trim()
  New-Item -ItemType Directory -Force (Split-Path $exclude) | Out-Null
  if (-not (Test-Path $exclude) -or -not (Select-String -Path $exclude -Pattern '^/eleven/$' -Quiet)) {
    Add-Content -Path $exclude -Value "/eleven/"
  }
  Write-Host "Hidden from git via $exclude"
} else {
  Write-Host "Not a git repo; add /eleven/ to your ignore file yourself if you need to."
}

Write-Host "Installed eleven in $dest"
Write-Host ""
Write-Host "Start your agent in $project and say:"
Write-Host "  Read eleven/AGENTS.md and act as the CTO. Fill eleven/project.md from the codebase."
Write-Host "Watch it work: open eleven\ui\index.html in Chrome or Edge."
