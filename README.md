<p align="center">
  <img src="assets/morassistant-readme-hero.svg" alt="MorAssistant — approval-first AI CAD copilot inside Onshape" width="100%" />
</p>

<p align="center">
  <a href="https://app.netlify.com/projects/morassistant-onshape/deploys"><img alt="Netlify deploy status" src="https://api.netlify.com/api/v1/badges/4ef420f0-7183-4032-82c2-a5ff089fef5b/deploy-status" /></a>
  <a href="LICENSE"><img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-187A5A.svg" /></a>
  <img alt="Node 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A522-187A5A.svg" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg" />
  <img alt="Onshape integrated cloud app" src="https://img.shields.io/badge/Onshape-integrated%20cloud%20app-187A5A.svg" />
</p>

<p align="center">
  <strong>Describe a CAD edit. Inspect the exact operations. Approve only when they look right.</strong>
</p>

<p align="center">
  <a href="https://morassistant-onshape.netlify.app">Panel</a>
  ·
  <a href="docs/onshape-installation.md">Install in Onshape</a>
  ·
  <a href="docs/personal-tailscale-deployment.md">Personal deployment</a>
  ·
  <a href="docs/app-store-release-checklist.md">App Store release</a>
  ·
  <a href="SECURITY.md">Security</a>
</p>

---

## AI CAD, without the leap of faith

MorAssistant is a free, open-source **Onshape right-panel copilot** powered by Codex. It lives beside the feature tree—like other native Onshape integrations—so the workflow stays inside the Part Studio:

1. describe the change in plain language;
2. receive a small, structured plan tied to the current feature IDs and values;
3. review every proposed operation;
4. select **Approve & apply**;
5. keep Onshape Undo available as the familiar escape hatch.

> [!IMPORTANT]
> MorAssistant is an installable Onshape application, **not a standalone CAD website**. The Netlify page is the iframe UI used by Onshape; the persistent API is the trusted boundary that owns OAuth, validates plans, and applies approved operations.

### Why it is different

| Native workflow | Approval is a boundary | Stale-plan protection | Isolated credentials |
|:--|:--|:--|:--|
| Opens from the Part Studio element sidebar. | Planning cannot mutate CAD. Apply is a separate request. | A preview is rejected if its feature name, parameter expression, or microversion is no longer current. | Onshape tokens stay in encrypted storage; each Codex user gets a separate `CODEX_HOME`. |

## Use it inside Onshape

For a private installation:

1. Open the MorAssistant listing in the Onshape App Store and select **Subscribe**.
2. Refresh Onshape and open a **workspace Part Studio**.
3. Select the MorAssistant cube icon in the element right sidebar.
4. If requested, grant **Onshape access** under **My account → Applications**.
5. Select **Continue with ChatGPT** once to connect Codex—no OpenAI API key is requested.
6. Enter a prompt, review the plan, then approve it.

Example prompts:

```text
Rename Sketch 1 to Base Profile
Rename Extrude 1 to Base Extrusion
Change Base Extrusion depth from 4 mm to 6 mm
```

The complete Developer Portal configuration and private-install test are in [docs/onshape-installation.md](docs/onshape-installation.md).

## What works today

| Capability | Status | Guardrail |
|:--|:--:|:--|
| Read the active Part Studio feature tree | ✅ | Workspace and Onshape-origin validation |
| Rename existing features | ✅ | Exact feature ID and current-name match |
| Update existing quantity expressions | ✅ | Exact parameter ID and current-expression match |
| Inspect post-apply regeneration state | ✅ | Failed regeneration marks the plan failed |
| Reject replay and double approval | ✅ | Durable plan status plus concurrency guards |
| Survive backend restarts | ✅ | Encrypted SQLite sessions and persistent Codex credentials |
| Edit versions | Refused | Versions are immutable; only `w` contexts are accepted |
| Edit dimensions in custom configurations | Refused | Renames remain available; ambiguous configured edits fail closed |
| Create sketches, extrudes, holes, fillets, or patterns | Roadmap | Requires captured, versioned Onshape payload fixtures first |

The narrow scope is intentional. MorAssistant prefers a small set of well-validated edits over broad, opaque automation.

## The trust boundary

```mermaid
flowchart LR
  U["Designer in Onshape"] -->|prompt| P["Right-panel UI<br/>React · Netlify"]
  P -->|same-origin /api/*| N["Netlify HTTPS proxy"]
  N -->|credentialed HTTPS| A["Trusted API<br/>Fastify"]

  subgraph Backend["Persistent private backend"]
    A --> S["Encrypted sessions<br/>SQLite · AES-256-GCM"]
    A --> C["Codex app-server<br/>isolated CODEX_HOME"]
    C -->|strict JSON plan| A
    A --> V["Schema + feature-tree<br/>validation"]
  end

  V -->|preview only| P
  U -->|explicit approval| P
  P -->|apply saved plan ID| A
  A -->|approved typed operation| O["Onshape OAuth + Feature API"]
  O -->|regeneration result| A
```

The model never receives an Onshape OAuth token, never sends arbitrary REST requests, and never performs CAD mutations during planning. The API accepts only the typed operation set defined in `@morassistant/cad-command-schema`.

### Safety properties

- **Preview before mutation** — creating a plan and applying it are separate endpoints.
- **Timeout-resistant planning** — the panel starts a background planning job and polls it, so a long Codex turn never depends on a CDN request timeout.
- **Strict structured output** — Codex output is normalized and parsed through a closed schema.
- **Current-state validation** — feature names, parameter expressions, and Onshape concurrency metadata must still match.
- **Fail closed** — execution stops on the first failed operation.
- **Replay resistance** — pending plans transition atomically and cannot be applied twice.
- **Origin checks** — state-changing browser requests must come from the configured panel origin.
- **Minimum secrets exposure** — Codex child processes inherit a deliberately small environment with no backend OAuth secrets.
- **Encrypted persistence** — OAuth tokens and plans are authenticated-encrypted before SQLite writes.

## Repository map

```text
MorAssistant/
├── apps/onshape-panel/          # narrow React right-panel interface
├── services/api/                # OAuth, sessions, planning, approval, execution
├── services/codex-worker/       # isolated Codex app-server lifecycle
├── services/onshape-mcp/        # internal development MCP adapter
├── packages/cad-command-schema/ # trusted operation and plan contracts
├── packages/onshape-client/     # typed Onshape feature API client
├── packages/shared-types/       # shared context and connection types
├── scripts/                     # mock pipeline + personal deployment tooling
├── docs/                        # install, hosting, and release playbooks
└── assets/                      # application and repository artwork
```

## Local development

### Requirements

- Node.js 22 or newer
- npm
- a current `codex` CLI with `codex app-server`

```bash
git clone https://github.com/MayoWolf/MorAssistant.git
cd MorAssistant
cp .env.example .env
npm install
```

Export the development environment and start both services:

```bash
set -a
source .env
set +a
npm run dev
```

| Service | Default URL |
|:--|:--|
| Onshape panel | `http://127.0.0.1:5173` |
| API | `http://127.0.0.1:3000` |

Example local panel context:

```text
http://127.0.0.1:5173/?documentId=DOCUMENT_ID&workspaceOrVersion=w&workspaceId=WORKSPACE_ID&elementId=ELEMENT_ID
```

## Test the whole pipeline

```bash
npm run check
npm audit --omit=dev
```

`npm run check` runs every workspace typecheck, every production build, the unit suite, and a deterministic end-to-end integration pipeline. That pipeline covers:

- Onshape OAuth state and token exchange;
- Codex device-code completion and event-race handling;
- the current Codex app-server sandbox and structured-output protocol;
- plan validation against a live feature snapshot;
- approval-gated rename and dimension mutations;
- regeneration inspection;
- stale-plan, replay, and concurrent duplicate-apply rejection;
- iframe, CORS, request-origin, workspace, configuration, and Onshape-stack guards.

For a browser-visible test with mock Onshape and Codex services:

```bash
npm run mock:pipeline
```

The mock pipeline is deterministic and never touches a real Onshape document or OpenAI account.

## Deployment

MorAssistant deliberately separates the static panel from the stateful worker:

| Layer | Personal deployment | Public/multi-user deployment |
|:--|:--|:--|
| Panel | Netlify, Git-linked from `main` | Any monitored HTTPS static host |
| API + Codex | Local Docker + Tailscale Funnel | Monitored, horizontally scalable container service |
| Identity | Private installation token bound to one owner | Verified per-user Onshape identity and OAuth handoff |
| Persistence | Local encrypted SQLite + Codex directories | Encrypted durable volume/database with retention controls |

See:

- [Netlify frontend deployment](docs/netlify-deployment.md)
- [Zero-cost personal deployment with Tailscale Funnel](docs/personal-tailscale-deployment.md)
- [Generic persistent backend deployment](docs/backend-deployment.md)

> [!WARNING]
> The private installation-token mode is intentionally single-user. Do not reuse it for a public App Store release. Public distribution requires per-user identity, capacity controls, deletion/retention policy, monitoring, and a continuously available backend.

## Onshape App Store

The app is registered as an **Integrated Cloud App** with an **Element right panel** extension scoped to **Inside part studio**. The release playbook covers the private listing, subscription flow, beta matrix, Onshape QA, and public launch requirements:

**[Read the App Store release and test checklist →](docs/app-store-release-checklist.md)**

Primary references: [Onshape extensions](https://onshape-public.github.io/docs/app-dev/extensions/), [App Store workflow](https://onshape-public.github.io/docs/app-store/), [testing guidelines](https://onshape-public.github.io/docs/app-store/testingguidelines/), and [Codex app-server](https://developers.openai.com/codex/app-server).

## Contributing

Thoughtful contributions are welcome—especially new guarded operations backed by real, versioned Onshape fixtures.

1. Read [CONTRIBUTING.md](CONTRIBUTING.md).
2. Keep planning and execution separated.
3. Add validation and end-to-end coverage for every operation.
4. Run `npm run check` before opening a pull request.

Report suspected vulnerabilities privately through [SECURITY.md](SECURITY.md). Community participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License and trademarks

Copyright © 2026 Wolf Nazari. Licensed under the [Apache License 2.0](LICENSE).

MorAssistant is an independent project and is not affiliated with, endorsed by, or sponsored by Onshape, PTC, OpenAI, or the makers of Adam. Onshape and related marks belong to their respective owners.
