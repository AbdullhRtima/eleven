#!/usr/bin/env bash
# Install eleven into a project as ./eleven, hidden from git via .git/info/exclude.
#   ./install.sh [project_dir]            install; never overwrites existing files
#   ./install.sh --update [project_dir]   git pull the kit, then refresh AGENTS.md, agents/, templates/, docs/, ui/
# Flags can go before or after project_dir. The project's own files (project.md, work/, decisions/)
# are never overwritten.
set -euo pipefail

# Everything lives in main() so bash has read the whole script before `git pull` can replace this file.
main() {
  local update=0 project_arg="" have_project=0 arg
  for arg in "$@"; do
    case "$arg" in
      --update) update=1 ;;
      -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      -*) echo "Unknown option: $arg (try --update)" >&2; return 1 ;;
      *)
        if (( have_project )); then echo "Only one project directory, got: $project_arg and $arg" >&2; return 1; fi
        project_arg="$arg"; have_project=1 ;;
    esac
  done

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

  echo "Installed eleven in $dest"
  echo
  echo "Start your agent in $project and say:"
  echo "  Read eleven/AGENTS.md and act as the CTO. Fill eleven/project.md from the codebase."
  echo "Watch it work: open eleven/ui/index.html in Chrome or Edge."
}

main "$@"
exit $?
