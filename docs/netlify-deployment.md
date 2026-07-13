# Netlify frontend deployment

Netlify hosts MorAssistant's static Onshape right-panel UI and provides its public HTTPS origin. The Fastify API and Codex workers must run on a separate persistent container service.

Current panel origin: `https://morassistant-onshape.netlify.app`

## Architecture

```text
Onshape iframe
  -> Netlify HTTPS panel
  -> same-origin /api requests
  -> Netlify HTTPS proxy
  -> persistent Fastify container
  -> Onshape OAuth/API + per-user Codex app-server
```

Netlify Functions are not used for the API. The Codex worker starts a child process, waits for interactive sign-in and planning events, and needs durable encrypted user state. Those requirements do not fit a short-lived serverless invocation.

## Netlify settings

The root `netlify.toml` configures:

- build command: `npm run build -w @morassistant/onshape-panel`
- publish directory: `apps/onshape-panel/dist`
- Node.js 22
- a same-origin `/api/*` proxy to the personal Funnel backend
- iframe-compatible CSP and security headers
- immutable caching for hashed assets

The checked-in personal deployment keeps the browser on the public panel origin:

```text
VITE_API_ORIGIN=https://morassistant-onshape.netlify.app
```

The matching `[[redirects]]` rule proxies `/api/*` to the Tailscale Funnel. This prevents Brave/Chromium from treating the request as public-to-private when Tailscale split DNS resolves the Funnel hostname to the Mac's `100.x` address. It also removes any dependency on a browser local-network permission prompt.

Forks should replace the proxy destination and `VITE_API_ORIGIN` with their own panel and Funnel origins. Managed multi-user deployments can instead set `VITE_API_ORIGIN` directly to the managed API origin and remove the personal proxy rule.

## Backend settings

Deploy the repository's API service to a container host with an encrypted database and persistent credential storage. Set:

```text
NODE_ENV=production
APP_ORIGIN=https://morassistant-onshape.netlify.app
ONSHAPE_REDIRECT_URI=https://api.your-domain.example/oauth/onshape/callback
SESSION_DB_PATH=/data/morassistant.sqlite
CODEX_USERS_ROOT=/data/codex-users
```

For the single-user zero-cost deployment, run the backend through Tailscale Funnel as described in [Personal deployment with Tailscale Funnel](personal-tailscale-deployment.md), then use that printed HTTPS origin as the `to` destination in Netlify's `/api/*` proxy rule.

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
