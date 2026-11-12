#!/usr/bin/env bash
# Install eleven into a project as ./eleven, hidden from git via .git/info/exclude.
#   ./install.sh [project_dir]            install; never overwrites existing files
#   ./install.sh --update [project_dir]   git pull the kit, then refresh AGENTS.md, agents/, templates/, docs/, ui/
#   ./install.sh --with-sync              also install eleven-sync (phone app, free beta, invite only; needs Node 22+ and git), no question asked
#   ./install.sh --no-sync                never install eleven-sync and never ask
# Flags can go before or after project_dir. The project's own files (project.md, work/, decisions/)
# are never overwritten.
# eleven-sync is installed project-local into eleven/.sync-bin: its source is copied there (no npm, no
# sudo, no global install, nothing written inside the kit) with an eleven-sync launcher, and the choice
# is saved in eleven/.sync, so --update keeps it updated.
# The eleven-sync source is not in this kit. It lives in the private repo AbdullhRtima/eleven-packages and is
# fetched with your own GitHub access into a cache clone (~/.cache/eleven/eleven-packages; --update refreshes it).
#   ELEVEN_PACKAGES_URL    repo URL (default https://github.com/AbdullhRtima/eleven-packages.git; for SSH use
#                          git@github.com:AbdullhRtima/eleven-packages.git)
#   ELEVEN_PACKAGES_REF    branch or tag (default main)
#   ELEVEN_PACKAGES_CACHE  cache folder (default ~/.cache/eleven/eleven-packages)
set -euo pipefail

# Everything lives in main() so bash has read the whole script before `git pull` can replace this file.
main() {
  local update=0 with_sync=0 no_sync=0 project_arg="" have_project=0 arg
  for arg in "$@"; do
    case "$arg" in
      --update) update=1 ;;
      --with-sync) with_sync=1 ;;
      --no-sync) no_sync=1 ;;
      -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      -*) echo "Unknown option: $arg (try --update, --with-sync, --no-sync)" >&2; return 1 ;;
      *)
        if (( have_project )); then echo "Only one project directory, got: $project_arg and $arg" >&2; return 1; fi
        project_arg="$arg"; have_project=1 ;;
    esac
  done
  if (( with_sync && no_sync )); then echo "Use either --with-sync or --no-sync, not both." >&2; return 1; fi

  local kit project dest
  kit="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if ! project="$(cd "${project_arg:-.}" 2>/dev/null && pwd)"; then
    echo "Project folder not found: ${project_arg:-.}" >&2; return 1
  fi
  dest="$project/eleven"

  if [[ "$dest" == "$kit" ]]; then
    echo "This is the kit itself. Run it against a project: $0 /path/to/project" >&2
    return 1
  fi

  if (( update )) && [[ -e "$kit/.git" ]]; then
    # The kit is a git clone: fetch the newest version first. Local edits in the kit are never overwritten.
    if [[ -n "$(git -C "$kit" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
      echo "The kit at $kit has local changes, so it cannot be updated safely." >&2
      git -C "$kit" status --porcelain --untracked-files=no 2>&1 | head -n 10 | sed 's/^/  /' >&2
      echo "Commit or stash them (git -C \"$kit\" stash), then run --update again." >&2
      return 1
    fi
    echo "Updating the kit: git pull --ff-only in $kit"
    if pull_out="$(git -C "$kit" pull --ff-only 2>&1)"; then
      echo "$pull_out"
    else
      echo "Could not update the kit (no network, no upstream branch, or it diverged):" >&2
      echo "$pull_out" >&2
      echo "Continuing with the kit as it is on disk." >&2
    fi
  elif (( update )); then
    echo "The kit is not a git clone; skipping git pull and using it as it is."
  fi

  mkdir -p "$dest/work" "$dest/decisions"
  local item
  for item in AGENTS.md README.md install.sh install.ps1 agents templates docs ui; do
    if (( update )); then
      rm -rf "${dest:?}/$item"
      cp -R "$kit/$item" "$dest/"
    else
      cp -Rn "$kit/$item" "$dest/" 2>/dev/null || true
    fi
  done
  rm -rf "$dest/ui/test"   # the UI test suite is for kit development only
  [[ -f "$dest/project.md" ]] || cp "$kit/templates/project.md" "$dest/project.md"

  if git -C "$project" rev-parse --git-dir >/dev/null 2>&1; then
    local exclude
    exclude="$(git -C "$project" rev-parse --path-format=absolute --git-path info/exclude)"
    mkdir -p "$(dirname "$exclude")"
    grep -qxF "/eleven/" "$exclude" 2>/dev/null || echo "/eleven/" >> "$exclude"
    echo "Hidden from git via $exclude"
  else
    echo "Not a git repo; add /eleven/ to your ignore file yourself if you need to."
  fi

  # eleven-sync (optional): wanted if asked for, already chosen earlier (eleven/.sync), or answered "y".
  local want_sync=0
  if (( no_sync )); then
    want_sync=0
  elif (( with_sync )) || [[ -f "$dest/.sync" ]]; then
    want_sync=1
  elif (( ! update )) && [[ -t 0 && -t 1 ]]; then
    local answer=""
    read -r -p "Use eleven on your phone (free beta, invite only)? This installs eleven-sync and needs Node 22+. [y/N] " answer || true
    [[ "$answer" =~ ^[Yy] ]] && want_sync=1
  fi
  if (( want_sync )); then install_sync "$kit" "$dest"; fi

  echo "Installed eleven in $dest"
  echo
  echo "Start your agent in $project and say:"
  echo "  Read eleven/AGENTS.md and act as the CTO. Fill eleven/project.md from the codebase."
  echo "Watch it work: open eleven/ui/index.html in Chrome or Edge."
}

# Install eleven-sync into eleven/.sync-bin. A problem here never fails the kit install.
install_sync() {
  local dest="$2" node_major
  if ! command -v node >/dev/null 2>&1; then
    echo "eleven-sync needs Node 22 or newer, and Node was not found." >&2
    echo "Get it from https://nodejs.org, then run the installer again with --with-sync." >&2
    return 0
  fi
  node_major="$(node --version | sed 's/^v//; s/\..*//')"
  if ! [[ "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
    echo "eleven-sync needs Node 22 or newer; found $(node --version)." >&2
    echo "Get a newer Node from https://nodejs.org, then run the installer again with --with-sync." >&2
    return 0
  fi
  local src
  if ! src="$(fetch_packages)"; then return 0; fi
  echo "Installing eleven-sync into $dest/.sync-bin (project-local, no sudo, no npm)"
  local bin="$dest/.sync-bin" pkg entry
  rm -rf "${bin:?}"
  if ! mkdir -p "$bin/packages"; then
    echo "eleven-sync did not install (cannot write $bin). The kit itself is installed; retry with --with-sync." >&2
    return 0
  fi
  # Source only (no tests, no node_modules); the relative layout stays, so the packages' relative imports work.
  for pkg in eleven-sync ledger-core eleven-protocol; do
    mkdir -p "$bin/packages/$pkg"
    for entry in "$src/$pkg"/* "$src/$pkg"/.[!.]*; do
      [[ -e "$entry" ]] || continue
      case "$(basename "$entry")" in test|node_modules|.git) continue ;; esac
      cp -R "$entry" "$bin/packages/$pkg/"
    done
  done
  # The launcher finds its packages next to itself, wherever the project is.
  cat > "$bin/eleven-sync" <<'LAUNCHER'
#!/bin/sh
dir="$(cd "$(dirname "$0")" && pwd)"
exec node "$dir/packages/eleven-sync/bin/eleven-sync.js" "$@"
LAUNCHER
  chmod 755 "$bin/eleven-sync"
  echo "sync=1" > "$dest/.sync"
  echo "eleven-sync installed: $bin/eleven-sync"
  echo "The phone app is a free beta, invite only: it works once your email is on the beta list."
}

# Print the folder that holds the three packages (a cache clone of the private eleven-packages repo) on stdout.
# On any problem: print plain steps on stderr, print nothing, return 1. Messages never go to stdout.
fetch_packages() {
  local url="${ELEVEN_PACKAGES_URL:-https://github.com/AbdullhRtima/eleven-packages.git}"
  local ref="${ELEVEN_PACKAGES_REF:-main}"
  local cache="${ELEVEN_PACKAGES_CACHE:-$HOME/.cache/eleven/eleven-packages}"
  local out pkg
  if ! command -v git >/dev/null 2>&1; then
    echo "eleven-sync needs git to fetch it, and git was not found." >&2
    echo "Install git, then run this again with --with-sync." >&2
    sync_access_help >&2; return 1
  fi
  # Never hang on a credential prompt when nobody is at a terminal.
  if [[ ! -t 0 ]]; then export GIT_TERMINAL_PROMPT=0; fi
  if [[ -d "$cache/.git" ]]; then
    # Always refresh, so a new project never gets an old copy; offline falls back to the cached copy.
    if :; then
      echo "Updating eleven-sync from $url ($ref)" >&2
      if out="$(git -C "$cache" remote set-url origin "$url" 2>&1 \
          && git -C "$cache" fetch --quiet --depth 1 origin "$ref" 2>&1 \
          && git -C "$cache" reset --quiet --hard FETCH_HEAD 2>&1)"; then
        :
      else
        echo "Could not update eleven-sync: $out" >&2
        echo "Using the copy already downloaded in $cache." >&2
      fi
    fi
  else
    echo "Fetching eleven-sync from $url ($ref)" >&2
    mkdir -p "$(dirname "$cache")" 2>/dev/null || true
    local tmp="$cache.tmp.$$"
    rm -rf "$tmp"
    if ! out="$(git clone --quiet --depth 1 --branch "$ref" "$url" "$tmp" 2>&1)"; then
      rm -rf "$tmp"
      echo "$out" | head -n 5 | sed 's/^/  /' >&2
      sync_access_help >&2; return 1
    fi
    rm -rf "$cache"
    mv "$tmp" "$cache"
  fi
  for pkg in eleven-sync ledger-core eleven-protocol; do
    if [[ ! -d "$cache/packages/$pkg" ]]; then
      echo "eleven-sync did not install: packages/$pkg is missing in $cache (wrong ELEVEN_PACKAGES_REF?)." >&2
      return 1
    fi
  done
  echo "$cache/packages"
}

sync_access_help() {
  echo "eleven-sync is in a private repo. Ask the owner for access to github.com/AbdullhRtima/eleven-packages,"
  echo "then sign in to GitHub (for example gh auth login) and run this again with --with-sync."
  echo "The kit itself is installed."
}

main "$@"
exit $?
