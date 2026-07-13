# Persistent backend deployment

MorAssistant's backend is a long-running Docker service. It cannot run as a Netlify Function because Codex app-server is a child process and each user's `CODEX_HOME` must survive restarts.

The checked-in `Dockerfile` builds the Fastify API and installs the Codex CLI version validated by the test suite. `railway.json` configures `/health` as the deployment health check.

## Railway deployment

Railway can deploy the local repository without GitHub. Install its CLI, sign in, then run these commands from the repository root:

```bash
railway init --name morassistant
railway add --service api
railway volume add --service api --mount-path /data
```

Generate two independent secrets locally:

```bash
openssl rand -hex 32
openssl rand -base64 32
```

Add the following service variables in Railway. Put the first generated value in `SESSION_SECRET` and the second in `SESSION_ENCRYPTION_KEY`.

```text
NODE_ENV=production
HOST=0.0.0.0
APP_ORIGIN=https://morassistant-onshape.netlify.app
SESSION_SECRET=...
SESSION_ENCRYPTION_KEY=...
SESSION_DB_PATH=/data/morassistant.sqlite
CODEX_USERS_ROOT=/data/codex-users
CODEX_MAX_WORKERS=4
CODEX_IDLE_TIMEOUT_MS=900000
ONSHAPE_BASE_URL=https://cad.onshape.com
ONSHAPE_AUTHORIZATION_URL=https://oauth.onshape.com/oauth/authorize
ONSHAPE_TOKEN_URL=https://oauth.onshape.com/oauth/token
ONSHAPE_API_VERSION=v15
```

Deploy and generate the public HTTPS domain:

```bash
railway up --service api
railway domain --service api --port 3000
```

After the domain exists, set these three values together:

```text
ONSHAPE_CLIENT_ID=...
ONSHAPE_CLIENT_SECRET=...
ONSHAPE_REDIRECT_URI=https://YOUR-RAILWAY-DOMAIN/oauth/onshape/callback
```

MorAssistant intentionally refuses a partial Onshape OAuth configuration. The service can boot without those three variables so the Codex connection and hosting path can be tested first.

## Connect Netlify

Set this build-time variable on the existing Netlify site and redeploy the panel:

```text
VITE_API_ORIGIN=https://YOUR-RAILWAY-DOMAIN
```

Then verify:

```bash
curl --fail https://YOUR-RAILWAY-DOMAIN/health
curl --include https://YOUR-RAILWAY-DOMAIN/api/status
```

The first response must be `{"ok":true}`. The status response should return a signed, `Secure`, `HttpOnly`, `SameSite=None` session cookie and report both connections as `disconnected` before authorization.

## Persistence verification

1. Open the Netlify panel and complete **Continue with ChatGPT**.
2. Confirm `/api/status` reports Codex as connected.
3. Restart the Railway deployment without deleting its volume.
4. Reload the same browser session.
5. Confirm Codex is still connected without signing in again.

The encrypted SQLite database is at `/data/morassistant.sqlite`; isolated Codex credential homes are under `/data/codex-users`. Never mount `/data` into another public service or expose it through a file server.
