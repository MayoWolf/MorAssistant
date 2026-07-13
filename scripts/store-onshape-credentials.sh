#!/bin/zsh
set -euo pipefail

keychain_account=${USER:-$(id -un)}

read "client_id?Onshape OAuth client ID: "
read -s "client_secret?Onshape OAuth client secret: "
echo

if [[ -z "$client_id" || -z "$client_secret" ]]; then
  echo "Both values are required." >&2
  exit 1
fi

security add-generic-password -a "$keychain_account" -s com.morassistant.onshape-client-id -w "$client_id" -U >/dev/null
security add-generic-password -a "$keychain_account" -s com.morassistant.onshape-client-secret -w "$client_secret" -U >/dev/null
unset client_id client_secret

echo "Onshape OAuth credentials stored in macOS Keychain."
