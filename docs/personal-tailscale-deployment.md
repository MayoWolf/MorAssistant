# Personal deployment with Tailscale Funnel

This is the recommended zero-hosting-cost deployment for a single user. The Netlify panel stays public, while the API, SQLite database, and isolated Codex credentials run in Docker on the user's Mac. Tailscale Funnel supplies the public HTTPS backend origin required by Onshape OAuth.

## Requirements

- Docker Desktop
- Tailscale signed in with Funnel enabled
- `jq`, `openssl`, and the Tailscale CLI
- an Onshape OAuth application with the callback shown by the deployment script

## One-time setup

Store the Onshape client ID and secret in macOS Keychain:

```bash
./scripts/store-onshape-credentials.sh
```

Start the backend and Funnel:

```bash
npm run local:deploy
```

The script:

1. starts Docker Desktop and Tailscale if needed;
2. creates independent session and encryption keys in macOS Keychain;
3. builds the pinned Codex container;
4. starts one Codex worker at most;
5. mounts the `morassistant-data` Docker volume at `/data`;
6. enables a background Funnel to port 3000;
7. verifies both local and public health endpoints.

The printed callback must exactly match the callback registered in Onshape. Set the printed HTTPS origin as Netlify's `VITE_API_ORIGIN`.

## Start at login

Install the checked-in LaunchAgent template after replacing `REPOSITORY_ROOT` with this repository's absolute path. The launch agent runs the same idempotent deployment script when the user signs in.

```bash
mkdir -p ~/Library/LaunchAgents
sed "s|REPOSITORY_ROOT|$PWD|g" scripts/com.morassistant.backend.plist > ~/Library/LaunchAgents/com.morassistant.backend.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.morassistant.backend.plist
```

Logs are written to `data/backend.log` and `data/backend.error.log` in the repository.

## Operations

```bash
npm run local:deploy  # rebuild, start, and verify
npm run local:stop    # stop Docker service and remove Funnel configuration
docker compose logs --follow api
docker volume inspect morassistant-data
```

The backend is available only while the Mac, Docker Desktop, and Tailscale are running. Funnel is public, so retain the existing secure-cookie, CORS, rate-limit, and approval safeguards even for a single-user deployment.
