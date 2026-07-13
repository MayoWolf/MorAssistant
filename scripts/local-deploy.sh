#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

repository_root=$(cd "$(dirname "$0")/.." && pwd)
keychain_account=${USER:-$(id -un)}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

keychain_read() {
  security find-generic-password -a "$keychain_account" -s "$1" -w 2>/dev/null
}

keychain_ensure_random() {
  local service=$1
  local encoding=$2
  local value
  if value=$(keychain_read "$service"); then
    print -r -- "$value"
    return
  fi
  case "$encoding" in
    hex) value=$(openssl rand -hex 32) ;;
    base64) value=$(openssl rand -base64 32) ;;
    *) echo "Unsupported secret encoding: $encoding" >&2; exit 1 ;;
  esac
  security add-generic-password -a "$keychain_account" -s "$service" -w "$value" -U >/dev/null
  print -r -- "$value"
}

require_command docker
require_command jq
require_command openssl
require_command security
require_command tailscale

if ! docker info >/dev/null 2>&1; then
  open -gja Docker
  for _ in {1..60}; do
    if docker info >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop did not become ready." >&2
  exit 1
fi

tailscale up
funnel_host=$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')
if [[ -z "$funnel_host" || "$funnel_host" == "null" ]]; then
  echo "Tailscale did not return a Funnel hostname." >&2
  exit 1
fi

export APP_ORIGIN=${MORASSISTANT_PANEL_ORIGIN:-https://morassistant-onshape.netlify.app}
export ONSHAPE_REDIRECT_URI="https://${funnel_host}/oauth/onshape/callback"
export SESSION_SECRET=$(keychain_ensure_random com.morassistant.session-secret hex)
export SESSION_ENCRYPTION_KEY=$(keychain_ensure_random com.morassistant.session-encryption-key base64)
export INSTALLATION_TOKEN=$(keychain_ensure_random com.morassistant.installation-token hex)
export ONSHAPE_CLIENT_ID=${ONSHAPE_CLIENT_ID:-$(keychain_read com.morassistant.onshape-client-id || true)}
export ONSHAPE_CLIENT_SECRET=${ONSHAPE_CLIENT_SECRET:-$(keychain_read com.morassistant.onshape-client-secret || true)}

if [[ -z "$ONSHAPE_CLIENT_ID" || -z "$ONSHAPE_CLIENT_SECRET" ]]; then
  echo "Onshape OAuth credentials are missing from macOS Keychain." >&2
  echo "Run scripts/store-onshape-credentials.sh, then retry." >&2
  exit 1
fi

cd "$repository_root"
docker compose up --detach --build

for _ in {1..30}; do
  if curl --fail --silent "http://127.0.0.1:3000/health" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent "http://127.0.0.1:3000/health" >/dev/null

tailscale funnel --bg 3000 >/dev/null
curl --fail --silent "https://${funnel_host}/health" >/dev/null

echo "MorAssistant backend is healthy at https://${funnel_host}"
echo "Onshape OAuth callback: ${ONSHAPE_REDIRECT_URI}"
