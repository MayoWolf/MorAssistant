# MorAssistant

[![Netlify Status](https://api.netlify.com/api/v1/badges/4ef420f0-7183-4032-82c2-a5ff089fef5b/deploy-status)](https://app.netlify.com/projects/morassistant-onshape/deploys)

MorAssistant is an installable, approval-first Onshape right-panel copilot. Its product shape is similar to Adam: users add it through Onshape, launch it inside a Part Studio, describe an edit, review the proposed operations, and apply them without leaving CAD.

It is **not a standalone end-user application**. The hosted React page, API, Codex workers, and MCP adapter are backend components of the Onshape extension. The only AI connection presented inside the installed panel is **Continue with ChatGPT**, which authorizes that user through Codex OAuth without asking for an OpenAI API key.

This repository is a working MVP for the deliberately narrow first milestone:

- read and summarize the current feature tree;
- intelligently rename existing features;
- update existing quantity expressions;
- reject stale plans when a feature or expression changed after preview;
- stop execution on the first failed operation;
- inspect regeneration status after applying changes;
- connect each installed user's session to its own Codex credential directory.

It does **not** yet create sketches, extrudes, holes, fillets, or patterns. Those operations need captured, versioned, known-good Onshape payload fixtures before they should be enabled.

## Architecture

```text
Installed Onshape application
└── Part Studio element right panel (React)
        │ credentialed HTTPS
        ▼
Hosted extension backend (Fastify)
├── Onshape OAuth and refresh
├── AES-GCM encrypted SQLite sessions and approval plans
├── deterministic plan validator / executor
└── one Codex app-server process + persistent CODEX_HOME per user session
        │
        └── structured CAD plan (no direct REST access)

Internal Onshape MCP adapter
└── list_features / rename_feature / update_dimension / inspect_regeneration_errors
```

The API executes approved plans directly through the same typed Onshape client used by the MCP adapter. The model never sees an OAuth token, never constructs arbitrary Onshape requests, and never applies a change during the planning turn.

## Installation lifecycle

1. The user subscribes to the app in the Onshape App Store, or an administrator assigns the private app.
2. The user grants Onshape access under My account → Applications. This is the Onshape OAuth grant required for feature API access.
3. The user opens a workspace Part Studio and launches MorAssistant in the element right panel.
4. Inside the panel, the user selects **Continue with ChatGPT** once to authorize Codex.
5. Future prompts, previews, approvals, and results remain inside the Onshape panel.

See [Onshape installation configuration](docs/onshape-installation.md) for the exact Developer Portal URLs and extension settings. The [App Store release and test checklist](docs/app-store-release-checklist.md) covers private beta, QA, and public submission.

MorAssistant is free and open-source software under the [Apache License 2.0](LICENSE). It is an independent project and is not affiliated with, endorsed by, or sponsored by Onshape, PTC, or OpenAI.

The public panel origin is [morassistant-onshape.netlify.app](https://morassistant-onshape.netlify.app). For a personal installation, the persistent API/Codex container runs locally and is exposed through Tailscale Funnel. See [Personal deployment with Tailscale Funnel](docs/personal-tailscale-deployment.md).

## Local setup

Requirements: Node.js 22 or newer, npm, and a current `codex` CLI with `codex app-server` support.

```bash
cp .env.example .env
npm install
npm run dev
```

Environment files are not automatically loaded by Node. For local development, export the values first (or use your preferred environment loader):

```bash
set -a
source .env
set +a
npm run dev
```

The panel runs at `http://127.0.0.1:5173`; the API runs at `http://127.0.0.1:3000`.

For a local panel smoke test, use:

```text
http://127.0.0.1:5173/?documentId=DOCUMENT_ID&workspaceOrVersion=w&workspaceId=WORKSPACE_ID&elementId=ELEMENT_ID
```

## Onshape application setup

1. Register a private OAuth application in Onshape Developer Portal or your company's Developer Settings.
2. Configure `/oauth/onshape/start` as the application OAuth URL and add the callback from `ONSHAPE_REDIRECT_URI` as its OAuth redirect URI.
3. Give the app the minimum document read/write scopes needed for Part Studio feature access.
4. Add an **Element right panel** extension with **Part Studio** context.
5. Use this production action URL (replace the host):

```text
https://your-panel.example/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceId={$workspaceOrVersionId}&elementId={$elementId}&configuration={$configuration}
```

Editing versions is intentionally rejected. The panel accepts only `workspaceOrVersion=w`.

Onshape OAuth belongs to app installation and permission management. The installed panel does not show a separate “Connect Onshape” button; if access is missing, it directs the user back to My account → Applications.

Onshape requires public extension pages and OAuth callbacks to use HTTPS. Set `APP_ORIGIN` to the panel origin and use secure cookies. The panel and API may share an origin or use separate HTTPS origins with credentialed CORS.

The panel can instead be hosted on Netlify while the API runs on a separate persistent container. Set `VITE_API_ORIGIN` during the Netlify build and set the API's `APP_ORIGIN` to the exact Netlify panel origin. See [Netlify frontend deployment](docs/netlify-deployment.md).

The zero-cost personal procedure is documented in [Personal deployment with Tailscale Funnel](docs/personal-tailscale-deployment.md). A generic managed-container procedure remains in [Persistent backend deployment](docs/backend-deployment.md).

Personal deployments use a private installation token stored in macOS Keychain. The Onshape OAuth URL carries it as a query value, while the extension carries it in a URL fragment that is removed into session storage before API calls. This binds the private iframe and durable Codex session without depending on third-party cookies; it is not the authentication design for a public multi-user release.

## Codex authentication and model selection

`Continue with ChatGPT` starts Codex app-server's `chatgptDeviceCode` login. The server creates a separate directory under `CODEX_USERS_ROOT` for each application session and starts one app-server process with that directory as `CODEX_HOME`. In production, both that root and `SESSION_DB_PATH` live on the same persistent private volume. Session payloads—including Onshape OAuth tokens and CAD plans—are encrypted with AES-256-GCM before SQLite writes them.

`CODEX_MODEL` is optional. When omitted, app-server uses the signed-in user's configured/default model. This avoids assuming that an undocumented or account-ineligible model slug exists. If you set it, use a model ID returned by app-server's model catalog for the target account.

Web sessions and Codex credentials survive container restarts. Sessions unused for 90 days and their isolated credential directories are removed during startup. A plan that was in the `applying` state during a restart is permanently failed closed so it cannot be replayed accidentally.

## Internal MCP adapter development

This process is an internal backend component, not another product the Onshape user installs. For local development it receives its token through the environment, never through tool arguments:

```bash
MOR_ONSHAPE_ACCESS_TOKEN=... npm run mcp
```

Optional MCP environment variables are `ONSHAPE_BASE_URL` and `ONSHAPE_API_VERSION`.

## Verification

```bash
npm run check
```

This runs TypeScript checks, production builds, unit tests, and a deterministic full-pipeline integration test. The integration test starts mock Onshape OAuth/API servers and a fake Codex app-server, then proves authorization, Codex sign-in, structured planning, approval, guarded mutation, replay protection, and concurrent duplicate-apply protection.

To keep the same test stack running for manual browser testing:

```bash
npm run mock:pipeline
```

Open the printed application URL with this path:

```text
/?documentId=document&workspaceOrVersion=w&workspaceId=workspace&elementId=element&server=PRINTED_ONSHAPE_ORIGIN
```

First visit `/oauth/onshape/start` on the printed app origin, then use the panel's **Continue with ChatGPT** flow. This stack is deterministic and never touches a real Onshape document or OpenAI account.

## Security and production gaps

- Add a separate append-only, encrypted audit-event store; sessions, OAuth refresh tokens, and plans are already durable and encrypted.
- Bind the session to the authenticated Onshape user instead of relying on an opaque browser session ID.
- Confirm OAuth grants and feature payloads on every Enterprise stack offered at launch. Runtime stack selection is restricted to the configured origin and HTTPS `*.onshape.com` origins.
- Add capacity-aware horizontal scaling; the current single-volume service caps active Codex workers, terminates idle workers, and cleans up expired credential directories.
- Store before/after feature payload hashes in an append-only audit log.
- Capture real v13 fixture payloads from a dedicated Onshape test document before enabling feature creation.
- Run the documented live integration matrix against a disposable Onshape document; automated tests intentionally do not mutate external services.

Useful primary references: [Codex app-server protocol](https://developers.openai.com/codex/app-server), [Onshape OAuth](https://onshape-public.github.io/docs/auth/oauth/), [Onshape extensions](https://onshape-public.github.io/docs/app-dev/extensions/), and [Onshape feature access](https://onshape-public.github.io/docs/api-adv/featureaccess/).

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md), and follow the [code of conduct](CODE_OF_CONDUCT.md).

## License

Copyright 2026 Wolf Nazari.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
