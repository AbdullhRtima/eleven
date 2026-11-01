#!/usr/bin/env bash
# Install eleven into a project as ./eleven, hidden from git via .git/info/exclude.
#   ./install.sh [project_dir]            install; never overwrites existing files
#   ./install.sh --update [project_dir]   also refresh AGENTS.md, agents/, templates/, docs/, ui/
# The project's own files (project.md, work/, decisions/) are never overwritten.
set -euo pipefail

update=0
if [[ "${1:-}" == "--update" ]]; then update=1; shift; fi

kit="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$(cd "${1:-.}" && pwd)"
dest="$project/eleven"

if [[ "$dest" == "$kit" ]]; then
  echo "This is the kit itself. Run it against a project: $0 /path/to/project" >&2
  exit 1
fi

mkdir -p "$dest/work" "$dest/decisions"
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
