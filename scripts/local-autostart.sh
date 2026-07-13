#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

repository_root=$(cd "$(dirname "$0")/.." && pwd)

# Keep the dedicated runtime clone current without making startup depend on
# GitHub availability. The existing, last-known-good checkout still starts if
# the Mac is offline or the remote cannot be reached.
if [[ -d "$repository_root/.git" ]]; then
  git -C "$repository_root" fetch --quiet origin main || true
  git -C "$repository_root" merge --ff-only --quiet origin/main || true
fi

exec "$repository_root/scripts/local-deploy.sh"
