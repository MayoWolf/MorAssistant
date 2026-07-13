# Netlify frontend deployment

Netlify hosts MorAssistant's static Onshape right-panel UI and provides its public HTTPS origin. The Fastify API and Codex workers must run on a separate persistent container service.

Current panel origin: `https://morassistant-onshape.netlify.app`

## Architecture

```text
Onshape iframe
  -> Netlify HTTPS panel
  -> credentialed HTTPS API requests
  -> persistent Fastify container
  -> Onshape OAuth/API + per-user Codex app-server
```

Netlify Functions are not used for the API. The Codex worker starts a child process, waits for interactive sign-in and planning events, and needs durable encrypted user state. Those requirements do not fit a short-lived serverless invocation.

## Netlify settings

The root `netlify.toml` configures:

- build command: `npm run build -w @morassistant/onshape-panel`
- publish directory: `apps/onshape-panel/dist`
- Node.js 22
- iframe-compatible CSP and security headers
- immutable caching for hashed assets

Set this build environment variable after the API has a public origin:

```text
VITE_API_ORIGIN=https://api.your-domain.example
```

Until that variable is set, the panel makes same-origin API calls. A static-only preview will render correctly but cannot complete OAuth or planning.

## Backend settings

Deploy the repository's API service to a container host with an encrypted database and persistent credential storage. Set:

```text
NODE_ENV=production
APP_ORIGIN=https://morassistant-onshape.netlify.app
ONSHAPE_REDIRECT_URI=https://api.your-domain.example/oauth/onshape/callback
SESSION_DB_PATH=/data/morassistant.sqlite
CODEX_USERS_ROOT=/data/codex-users
```

For the single-user zero-cost deployment, run the backend through Tailscale Funnel as described in [Personal deployment with Tailscale Funnel](personal-tailscale-deployment.md), then use that printed HTTPS origin for `VITE_API_ORIGIN`.

The personal deployment also sets `INSTALLATION_TOKEN` only on the backend. Never put it in a `VITE_` environment variable. Add it to the private Onshape OAuth URL and to the extension action URL fragment as documented in the personal deployment guide; the fragment is consumed in the browser and is not sent to Netlify.

For a managed container host, mount a persistent private volume at `/data`. Add `SESSION_SECRET`, the separate `SESSION_ENCRYPTION_KEY`, and the remaining secrets from `.env.example` through the container host's secret manager. Never add them to Netlify's frontend build environment because `VITE_` values are public in the browser bundle.

## Onshape application URLs

```text
OAuth URL:
https://api.your-domain.example/oauth/onshape/start

OAuth callback:
https://api.your-domain.example/oauth/onshape/callback

Extension action URL:
https://morassistant-onshape.netlify.app/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceId={$workspaceOrVersionId}&elementId={$elementId}&configuration={$configuration}
```

After both origins are available, run the live private-installation matrix in [the App Store release checklist](app-store-release-checklist.md).
