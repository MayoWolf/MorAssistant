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
3. creates a private installation token in macOS Keychain;
4. builds the pinned Codex container;
5. starts one Codex worker at most;
6. mounts the `morassistant-data` Docker volume at `/data`;
7. enables a background Funnel to port 3000;
8. verifies both local and public health endpoints.

The printed callback must exactly match the callback registered in Onshape. Set the printed HTTPS origin as Netlify's `VITE_API_ORIGIN`.

Personal deployments use the Keychain item `com.morassistant.installation-token` to bind the private Onshape extension, OAuth grant, and Codex worker to one owner session without relying on third-party cookies. Put that token in the OAuth URL query and the extension action URL fragment. URL fragments are not sent to Netlify:

```text
OAuth URL: https://YOUR-FUNNEL-HOST/oauth/onshape/start?installationToken=YOUR_TOKEN
Action URL: https://morassistant-onshape.netlify.app/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceId={$workspaceOrVersionId}&elementId={$elementId}&configuration={$configuration}#installationToken=YOUR_TOKEN
```

## Start at login

Install the login service with:

```bash
npm run local:install-autostart
```

The installer creates a dedicated runtime clone at `~/Library/Application Support/MorAssistant/repo`, installs a LaunchAgent, and starts it. Keeping the runtime outside Desktop and Documents avoids macOS protected-folder restrictions for background services. At login, it attempts a fast-forward update from `main`, then runs the same idempotent deployment script. If GitHub is unavailable, the last-known-good checkout still starts.

Logs are written to `~/Library/Application Support/MorAssistant/repo/data/backend.log` and `backend.error.log`.

## Operations

```bash
npm run local:deploy  # rebuild, start, and verify
npm run local:stop    # stop Docker service and remove Funnel configuration
docker compose logs --follow api
docker volume inspect morassistant-data
```

The backend is available only while the Mac, Docker Desktop, and Tailscale are running. Funnel is public, so retain the existing secure-cookie, CORS, rate-limit, and approval safeguards even for a single-user deployment.
