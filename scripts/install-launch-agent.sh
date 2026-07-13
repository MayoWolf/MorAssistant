#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

source_root=$(cd "$(dirname "$0")/.." && pwd)
runtime_root=${MORASSISTANT_RUNTIME_ROOT:-"$HOME/Library/Application Support/MorAssistant"}
runtime_repository="$runtime_root/repo"
launch_agents_directory="$HOME/Library/LaunchAgents"
launch_agent="$launch_agents_directory/com.morassistant.backend.plist"
service_target="gui/$(id -u)/com.morassistant.backend"

mkdir -p "$runtime_root" "$launch_agents_directory"

if [[ -d "$runtime_repository/.git" ]]; then
  git -C "$runtime_repository" fetch origin main
  git -C "$runtime_repository" merge --ff-only origin/main
else
  git clone --branch main --single-branch https://github.com/MayoWolf/MorAssistant.git "$runtime_repository"
fi

mkdir -p "$runtime_repository/data"
escaped_runtime_repository=${runtime_repository//&/\\&}
sed "s|RUNTIME_REPOSITORY_ROOT|$escaped_runtime_repository|g" \
  "$source_root/scripts/com.morassistant.backend.plist" > "$launch_agent"
plutil -lint "$launch_agent"

launchctl bootout "$service_target" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$launch_agent"

echo "Installed MorAssistant login service from $runtime_repository"
echo "Logs: $runtime_repository/data/backend.log"
