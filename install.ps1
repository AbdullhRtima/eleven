# Install eleven into a project as .\eleven, hidden from git via .git\info\exclude.
#   .\install.ps1 [project_dir]            install; never overwrites existing files
#   .\install.ps1 -Update [project_dir]    git pull the kit, then refresh AGENTS.md, agents\, templates\, docs\, ui\
#   .\install.ps1 -WithSync                also install eleven-sync (phone app, paid beta; needs Node 20+), no question asked
#   .\install.ps1 -NoSync                  never install eleven-sync and never ask
# GNU-style flags work too (--update, --with-sync, --no-sync), before or after project_dir.
# The project's own files (project.md, work\, decisions\) are never overwritten.
# eleven-sync is installed project-local into eleven\.sync-bin: its source is copied there (no npm, no
# admin, no global install, nothing written inside the kit) with an eleven-sync.cmd launcher, and the
# choice is saved in eleven\.sync, so -Update keeps it updated.
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File install.ps1 <project_dir>
#
# Flags are read from $args by hand: a param block would not accept "--update" (PowerShell takes it as a path).
# Works on Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = "Stop"

$Update = $false; $WithSync = $false; $NoSync = $false; $Project = $null
foreach ($a in $args) {
  $s = [string]$a
  switch -Regex ($s) {
    '^--?update$'    { $Update = $true; break }
    '^--?with-?sync$' { $WithSync = $true; break }
    '^--?no-?sync$'  { $NoSync = $true; break }
    '^-'             { [Console]::Error.WriteLine("Unknown option: $s (try -Update, -WithSync, -NoSync)"); exit 1 }
    default {
      if ($null -ne $Project) { [Console]::Error.WriteLine("Only one project directory, got: $Project and $s"); exit 1 }
      $Project = $s
    }
  }
}
if ($null -eq $Project) { $Project = "." }
if ($WithSync -and $NoSync) { [Console]::Error.WriteLine("Use either -WithSync or -NoSync, not both."); exit 1 }

function Invoke-Native {
  # Run a program and capture its exit code and output in $script:nativeCode / $script:nativeOut.
  # Windows PowerShell 5.1 turns anything a program writes to stderr into a terminating error while
  # $ErrorActionPreference is "Stop", so relax it inside this function only (the setting is local here).
  $ErrorActionPreference = "Continue"
  $script:nativeCode = 0
  $script:nativeOut = ""
  try {
    $program = $args[0]
    $rest = @($args | Select-Object -Skip 1)   # a variable, so @rest can splat it
    $script:nativeOut = ((& $program @rest 2>&1 | ForEach-Object { "$_" }) -join "`n")
    $script:nativeCode = $LASTEXITCODE
  } catch {
    $script:nativeCode = 127   # program not found
    $script:nativeOut = "$_"
  }
}

if (-not (Test-Path -LiteralPath $Project -PathType Container)) {
  [Console]::Error.WriteLine("Project folder not found: $Project"); exit 1
}
$kit = $PSScriptRoot
$project = (Resolve-Path -LiteralPath $Project).Path
$dest = Join-Path $project "eleven"

if ((Resolve-Path -LiteralPath $kit).Path -eq $dest) {
  [Console]::Error.WriteLine("This is the kit itself. Run it against a project: .\install.ps1 C:\path\to\project")
  exit 1
}

if ($Update) {
  if (Test-Path -LiteralPath (Join-Path $kit ".git")) {
    # The kit is a git clone: fetch the newest version first. Local edits in the kit are never overwritten.
    Invoke-Native git -C $kit status --porcelain --untracked-files=no
    if ($script:nativeOut.Trim()) {
      [Console]::Error.WriteLine("The kit at $kit has local changes, so it cannot be updated safely.")
      @($script:nativeOut -split "`r?`n" | Where-Object { $_ } | Select-Object -First 10) | ForEach-Object { [Console]::Error.WriteLine("  $_") }
      [Console]::Error.WriteLine("Commit or stash them (git -C `"$kit`" stash), then run -Update again.")
      exit 1
    }
    Write-Host "Updating the kit: git pull --ff-only in $kit"
    Invoke-Native git -C $kit pull --ff-only
    if ($script:nativeCode -eq 0) {
      Write-Host $script:nativeOut
    } else {
      [Console]::Error.WriteLine("Could not update the kit (no network, no upstream branch, or it diverged):")
      [Console]::Error.WriteLine($script:nativeOut)
      [Console]::Error.WriteLine("Continuing with the kit as it is on disk.")
    }
  } else {
    Write-Host "The kit is not a git clone; skipping git pull and using it as it is."
  }
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
# The UI test suite is for kit development only.
Remove-Item (Join-Path $dest "ui\test") -Recurse -Force -ErrorAction SilentlyContinue
$projectMd = Join-Path $dest "project.md"
if (-not (Test-Path $projectMd)) { Copy-Item (Join-Path $kit "templates\project.md") $projectMd }

Invoke-Native git -C $project rev-parse --git-dir
if ($script:nativeCode -eq 0) {
  Invoke-Native git -C $project rev-parse --path-format=absolute --git-path info/exclude
  $exclude = $script:nativeOut.Trim()
  New-Item -ItemType Directory -Force (Split-Path $exclude) | Out-Null
  if (-not (Test-Path $exclude) -or -not (Select-String -Path $exclude -Pattern '^/eleven/$' -Quiet)) {
    Add-Content -Path $exclude -Value "/eleven/"
  }
  Write-Host "Hidden from git via $exclude"
} else {
  Write-Host "Not a git repo; add /eleven/ to your ignore file yourself if you need to."
}

function Install-Sync {
  # Install eleven-sync into eleven\.sync-bin. A problem here never fails the kit install.
  Invoke-Native node --version
  if ($script:nativeCode -ne 0) {
    [Console]::Error.WriteLine("eleven-sync needs Node 20 or newer, and Node was not found.")
    [Console]::Error.WriteLine("Get it from https://nodejs.org, then run the installer again with -WithSync.")
    return
  }
  $nodeVersion = $script:nativeOut.Trim()
  if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
    [Console]::Error.WriteLine("eleven-sync needs Node 20 or newer; found $nodeVersion.")
    [Console]::Error.WriteLine("Get a newer Node from https://nodejs.org, then run the installer again with -WithSync.")
    return
  }
  $bin = Join-Path $dest ".sync-bin"
  foreach ($name in "eleven-sync", "ledger-core", "eleven-protocol") {
    if (-not (Test-Path -LiteralPath (Join-Path $kit "packages\$name") -PathType Container)) {
      [Console]::Error.WriteLine("eleven-sync did not install: $kit\packages\$name is missing. Use a full clone of the kit.")
      return
    }
  }
  Write-Host "Installing eleven-sync into $bin (project-local, no admin, no npm)"
  try {
    # An older install used npm, which links into the kit with junctions. Drop the links themselves first,
    # so the recursive delete below can never reach into the kit.
    $modules = Join-Path $bin "node_modules"
    if (Test-Path -LiteralPath $modules) {
      Get-ChildItem -LiteralPath $modules -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | ForEach-Object {
        [IO.Directory]::Delete($_.FullName, $false)
      }
    }
    if (Test-Path -LiteralPath $bin) { Remove-Item -LiteralPath $bin -Recurse -Force }
    # Source only (no tests, no node_modules); the relative layout stays, so the packages' relative imports work.
    foreach ($name in "eleven-sync", "ledger-core", "eleven-protocol") {
      $target = Join-Path $bin "packages\$name"
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      # $target exists, so each entry lands inside it (Copy-Item would nest a folder into an existing target).
      Get-ChildItem -LiteralPath (Join-Path $kit "packages\$name") -Force |
        Where-Object { $_.Name -ne "test" -and $_.Name -ne "node_modules" } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force }
    }
    # Launchers find their packages next to themselves, wherever the project is. ASCII, CRLF for cmd.
    $cmd = "@echo off`r`nnode `"%~dp0packages\eleven-sync\bin\eleven-sync.js`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $bin "eleven-sync.cmd"), $cmd, [Text.Encoding]::ASCII)
    $ps1 = "`$dir = Split-Path -Parent `$MyInvocation.MyCommand.Path`r`n& node (Join-Path `$dir `"packages\eleven-sync\bin\eleven-sync.js`") @args`r`nexit `$LASTEXITCODE`r`n"
    [IO.File]::WriteAllText((Join-Path $bin "eleven-sync.ps1"), $ps1, [Text.Encoding]::ASCII)
    Set-Content -Path (Join-Path $dest ".sync") -Value "sync=1" -Encoding ASCII
  } catch {
    [Console]::Error.WriteLine("$_")
    [Console]::Error.WriteLine("eleven-sync did not install. The kit itself is installed; retry with -WithSync.")
    return
  }
  Write-Host "eleven-sync installed: $bin\eleven-sync.cmd"
  Write-Host "The phone app is in private beta: it works once your email is on the beta list."
}

# eleven-sync (optional): wanted if asked for, already chosen earlier (eleven\.sync), or answered "y".
$wantSync = $false
if ($NoSync) {
  $wantSync = $false
} elseif ($WithSync -or (Test-Path -LiteralPath (Join-Path $dest ".sync"))) {
  $wantSync = $true
} elseif ((-not $Update) -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
  $answer = Read-Host "Use eleven on your phone (paid, beta)? This installs eleven-sync and needs Node 20+. [y/N]"
  if ($answer -match '^[Yy]') { $wantSync = $true }
}
if ($wantSync) { Install-Sync }

Write-Host "Installed eleven in $dest"
Write-Host ""
Write-Host "Start your agent in $project and say:"
Write-Host "  Read eleven/AGENTS.md and act as the CTO. Fill eleven/project.md from the codebase."
Write-Host "Watch it work: open eleven\ui\index.html in Chrome or Edge."
