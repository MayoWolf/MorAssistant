#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
repository_root=$(cd "$(dirname "$0")/.." && pwd)

tailscale funnel reset >/dev/null 2>&1 || true
cd "$repository_root"
docker compose down
