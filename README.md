<p align="center">
  <img src="assets/morassistant-readme-hero.svg" alt="MorAssistant — approval-first AI CAD copilot inside Onshape" width="100%" />
</p>

<p align="center">
  <a href="https://app.netlify.com/projects/morassistant-onshape/deploys"><img alt="Netlify deploy status" src="https://api.netlify.com/api/v1/badges/4ef420f0-7183-4032-82c2-a5ff089fef5b/deploy-status" /></a>
  <a href="LICENSE"><img alt="Apache License 2.0" src="https://img.shields.io/badge/license-Apache--2.0-187A5A.svg" /></a>
  <img alt="Node 22 or newer" src="https://img.shields.io/badge/node-%E2%89%A522-187A5A.svg" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg" />
  <img alt="Onshape integrated cloud app" src="https://img.shields.io/badge/Onshape-integrated%20cloud%20app-187A5A.svg" />
  <img alt="GPT-5.6 Sol pinned at high reasoning" src="https://img.shields.io/badge/Codex-GPT--5.6%20Sol%20%C2%B7%20high-111827.svg" />
</p>

<p align="center">
  <strong>Describe a CAD edit. Inspect the exact operations. Approve only when they look right.</strong>
</p>

<p align="center">
  <a href="https://morassistant-onshape.netlify.app">Panel</a>
  ·
  <a href="docs/onshape-installation.md">Install in Onshape</a>
  ·
  <a href="docs/onshape-capability-curriculum.md">177-tool curriculum</a>
  ·
  <a href="docs/personal-tailscale-deployment.md">Personal deployment</a>
  ·
  <a href="docs/app-store-release-checklist.md">App Store release</a>
  ·
  <a href="SECURITY.md">Security</a>
</p>

---

## AI CAD, without the leap of faith

MorAssistant is a free, open-source **Onshape right-panel copilot** powered by Codex. It lives beside the feature tree—like other native Onshape integrations—and behaves as a persistent chat in both Part Studios and Assemblies rather than a one-shot prompt box:

1. describe the change in plain language;
2. receive a small, structured plan tied to the current feature IDs and values;
3. review every proposed operation;
4. select **Approve & apply**;
5. keep talking in the same thread—“make it wider,” “move those holes,” or “now fillet it”;
6. keep Onshape Undo available as the familiar escape hatch.

> [!IMPORTANT]
> MorAssistant is an installable Onshape application, **not a standalone CAD website**. The Netlify page is the iframe UI used by Onshape; the persistent API is the trusted boundary that owns OAuth, validates plans, and applies approved operations.

The personal deployment pins **GPT‑5.6 Sol at high reasoning effort**, verifies the model exposed by the signed-in Codex runtime, displays that proof in the panel, and refuses to plan if Codex attempts to fall back to a different model.

### What “Adam-like” means here

Each Part Studio and Assembly has its own durable Codex conversation. The visible transcript survives panel reloads, the underlying app-server thread survives backend restarts, and follow-up turns retain names, dimensions, component references, corrections, and design intent. Before every new reply, MorAssistant still re-reads the live feature tree or assembly definition so conversation memory never overrides actual CAD state. If a saved Codex rollout cannot be reopened, the backend seeds a replacement thread from the recent encrypted transcript.

The agent operates on the model’s real feature history, not on a screenshot and not by hallucinating CAD JSON. Sol chooses from a typed CAD vocabulary; deterministic builders compile common intent into native Onshape features; the trusted host checks dependencies and regeneration after every operation. The raw-feature route remains an escape hatch for less common Part Studio features, not the default for basic geometry. Informational follow-ups can return a normal chat answer with no CAD operations and no approval button.

### Why it is different

| Native workflow | Approval is a boundary | Stale-plan protection | Isolated credentials |
|:--|:--|:--|:--|
| Opens from the Part Studio or Assembly element sidebar. | Planning cannot mutate CAD. Apply is a separate request. | A preview is rejected when its feature, instance, occurrence transform, source tuple, or microversion is no longer current. | Onshape tokens stay in encrypted storage; each Codex user gets a separate `CODEX_HOME`. |

## From a sentence to a native parametric model

MorAssistant does not draw pixels and it does not upload a mesh. It reads and edits Onshape's actual feature database.

```mermaid
flowchart TD
  U["1 · Understand the request"] --> R["2 · Read the active model"]
  R --> G["3 · Build dependency + geometry context"]
  G --> P["4 · Produce a typed native plan"]
  P --> V{"Trusted validation passes?"}
  V -->|"No · return exact feedback"| P
  V -->|"Yes"| A["5 · Show every operation for approval"]
  A -->|"Approved"| E["6 · Apply one operation"]
  E --> C{"Onshape verification passes?"}
  C -->|"Yes · more work"| E
  C -->|"Yes · complete"| D["Native Onshape model updated"]
  C -->|"No"| S["Stop immediately + prepare recovery plan"]
  S --> A
```

The model context is deliberately CAD-shaped:

| Context | What the agent receives | Why it matters |
|:--|:--|:--|
| Feature definitions | IDs, names, types, editable expressions, bounded native BTM payloads, exact hashes | Enables precise edits without guessing existing identifiers |
| Dependency graph | Direct `dependsOn` and `usedBy` edges for every feature | Exposes downstream blast radius before replace/delete operations |
| Design intent signals | Repeated literal expressions and existing `#variable` references | Supports variable extraction and parametric cleanup |
| Geometry | Solid/body, face, edge, and vertex counts plus bounded body details | Gives the planner topology evidence instead of only feature names |
| Physical properties | Part count, volume, mass, and centroid when Onshape can calculate them | Helps check scale and geometric plausibility |
| Rebuild state | Per-feature Onshape status before and after each edit | Separates pre-existing problems from failures introduced by the plan |
| Assembly definition | Exact instance IDs, source documents/versions/configurations, mates, occurrence paths, and absolute 4×4 transforms | Enables guarded component insertion and placement without inventing library records or instance paths |
| FRCDesignLib bridge | Prompt-matched FRCDesignApp catalog entries enriched with authenticated Onshape part IDs | Lets the agent import the same versioned FRC components exposed by the installed library app |
| Tool curriculum | 177 built-in sketch, solid, surface, curve, sheet-metal, frame, assembly, inspection, and metadata lessons | Teaches prerequisites, method, and verification—not just toolbar names |
| Live feature specs | Exact feature types and parameter definitions returned by the active Part Studio | Adapts to the current Onshape release and installed custom FeatureScript tools |
| Live web research | Current primary sources for season rules, standards, products, and physical dimensions | Grounds requests such as the 2026 FRC season or regulation sports equipment in verifiable facts |
| Live activity | Detailed reasoning summaries, web-search activity, inspection, and validation state | Replaces an opaque loading animation without exposing private chain-of-thought |
| Conversation context | Persistent Codex thread plus the visible prompt/plan transcript for the active element | Makes “it,” “those wheels,” “the last sketch,” and other follow-ups refer to earlier turns |

Read-only geometric analysis uses Onshape's FeatureScript evaluation API. Persistent changes use Onshape's native Feature API, so the result remains editable, ordered, parametric CAD. Invalid model output is not merely rejected: the validation failure is fed back into the same planning thread for up to three bounded repair passes.

## Use it inside Onshape

For a private installation:

1. Open the MorAssistant listing in the Onshape App Store and select **Subscribe**.
2. Refresh Onshape and open a **workspace Part Studio or Assembly**.
3. Select the MorAssistant cube icon in the element right sidebar.
4. If requested, grant **Onshape access** under **My account → Applications**.
5. Select **Continue with ChatGPT** once to connect Codex—no OpenAI API key is requested.
6. Enter a prompt, review the plan, then approve it.

Example prompts:

```text
Create five sketches, all different-size squares on the Top plane
Create a 25 mm × 40 mm rectangle sketch named Mounting Profile
Extrude Mounting Profile 15 mm as a new body
Create a toy car with four separate wheels whose axles run left-to-right
Add a 3 mm fillet to the outer edges of Base Extrusion
Using the official 2026 FRC game manual, create the legal starting-volume envelope and cite the rule
Research the regulation size of an American football, state any modeling assumptions, and create a dimensioned construction plan
Rename Sketch 1 to Base Profile
Rename Extrude 1 to Base Extrusion
Change Base Extrusion depth from 4 mm to 6 mm
In this assembly, list the existing hex shafts, wheels, and mates
Find the matching compliant wheel in FRCDesignLib and import two of them
Place the imported wheels on the existing 1/2-inch hex shaft
Suppress the selected bearing, but do not delete it
```

The complete Developer Portal configuration and private-install test are in [docs/onshape-installation.md](docs/onshape-installation.md).

## What works today

MorAssistant now uses two complementary knowledge layers. The versioned **177-tool curriculum** teaches modeling intent for the complete Sketch, Part Studio, sheet-metal, frame, and Assembly tool families. Before every plan, the backend also reads Onshape's live `featurespecs` catalog and sends the relevant exact schemas to Sol. New built-ins and document-specific custom FeatureScript features therefore do not depend on a future MorAssistant release. See **[the full capability curriculum and execution matrix →](docs/onshape-capability-curriculum.md)**.

| Capability | Status | Guardrail |
|:--|:--:|:--|
| Read the active Part Studio model | ✅ | Feature payload, dependency, topology, mass-property, and rebuild inspection |
| Evaluate FeatureScript for geometry analysis | ✅ | Read-only lambda evaluation; no persistent mutation |
| Research current real-world facts | ✅ | First-party live web search, primary-source preference, source links in every researched preview |
| Show planning progress live | ✅ | Detailed reasoning summaries plus inspection, research, and trusted-validation events; raw private reasoning is never exposed |
| Continue an element conversation | ✅ | Durable app-server thread per Part Studio or Assembly, encrypted thread mapping, reloadable transcript, and live-model refresh on every turn |
| Answer without changing CAD | ✅ | Natural assistant response with an empty operation list and no apply action |
| Self-correct an invalid generated plan | ✅ | Up to three schema + live feature-tree validation passes |
| Create rectangle, square, and circle sketches in 3D | ✅ | Typed Top, Front, and Right datum-plane geometry with explicit world-axis mapping |
| Build cylinders and blind/offset extrudes | ✅ | Typed `NEW`, `ADD`, `REMOVE`, and `INTERSECT` operations with direction, symmetry, and starting offset |
| Validate real-world spatial intent | ✅ | Axis, side, symmetry, clearance, and proportion reasoning plus deterministic bilateral wheel compilation and a hard vehicle-orientation check |
| Cut round holes and pockets | ✅ | Circle + guarded `REMOVE` extrude recipe |
| Fillet feature-created edges | ✅ | FeatureScript resolves live edge transient IDs, then native fillet input is regenerated and verified |
| Chamfer feature-created edges | ✅ | FeatureScript resolves current edges, then a typed equal-offset native chamfer is compiled and verified |
| Understand the full Onshape modeling toolbar | ✅ | 177 versioned lessons with prerequisites, workflows, synonyms, and verification rules |
| Discover current and custom Part Studio features | ✅ | Authenticated live `featurespecs` read, one-hour bounded cache, exact parameter schemas |
| Create other standard native Part Studio features | 🧪 Schema-driven | Relevant live feature spec + exact exemplars + bounded BTM payload + Onshape regeneration validation |
| Replace a complete existing feature | ✅ Beta | Exact SHA-256 snapshot match plus microversion guard |
| Delete an existing feature | ✅ | Exact ID/name match, high-risk preview, explicit approval |
| Rename existing features | ✅ | Exact feature ID and current-name match |
| Update existing quantity expressions | ✅ | Exact parameter ID and current-expression match |
| Verify every operation against regeneration | ✅ | Stop immediately on the first newly introduced Onshape error |
| Read the active Assembly | ✅ | Instances, source tuples, mates/features, occurrence paths, suppression state, and absolute transforms |
| Search and import FRCDesignLib components | ✅ | Public FRCDesignApp catalog discovery plus authenticated Onshape version/part resolution; only trusted exact source tuples validate |
| Place Assembly instances | ✅ | Absolute object-to-world 4×4 transforms in meters, exact occurrence paths, snapshot hashes, and post-apply verification |
| Suppress, unsuppress, and delete Assembly instances | ✅ | Exact instance ID/name/state checks; deletion is always high risk |
| Roll back an incomplete component insertion | ✅ | If placement fails after insertion, the new instance is deleted before the failure is returned |
| Prepare a recovery plan after failure | ✅ | Re-reads partially changed state; recovery requires a fresh approval |
| Reject replay and double approval | ✅ | Durable plan status plus concurrency guards |
| Survive backend restarts | ✅ | Encrypted SQLite sessions and persistent Codex credentials |
| Edit versions | Refused | Versions are immutable; only `w` contexts are accepted |
| Edit dimensions in custom configurations | Refused | Renames remain available; ambiguous configured edits fail closed |
| Create implicit mates from guessed geometry | Refused | Placement is supported; mate creation waits for exact connector/entity evidence rather than hallucinated geometry |
| Drawings, releases, and document administration | Roadmap | These element-specific workflows are not disguised as Part Studio or Assembly operations |

Common operations use dedicated typed builders. For a cylinder, Sol emits a circle sketch on the plane normal to the desired axis and an extrude—not an opaque blob. Starting offsets allow separated geometry on either side of a center plane, including four real toy-car wheels instead of vertical cylinders or full-width rollers. A deterministic spatial compiler pairs vehicle wheels across both chassis sides instead of trusting sampled direction booleans. For a round hole, the agent emits a circular profile plus a `REMOVE` extrude. Fillets and chamfers add one read-only FeatureScript selection pass because Onshape’s native Feature API requires current edge transient IDs; those IDs are resolved immediately before the guarded mutation.

Everything else in the active Part Studio can use the bounded native-feature fallback: Codex proposes the exact payload, the panel labels it as a native operation, the API validates its structure and references, and Onshape performs final feature validation after approval. Assemblies use a separate typed API vocabulary for insert, place, suppress, unsuppress, and delete. Drawings, release workflows, implicit mate geometry, and persistent custom FeatureScript definitions are not silently treated as either Part Studio or Assembly operations.

For the detailed data flow, trust boundaries, state machine, and failure behavior, read **[Architecture: how MorAssistant reasons and recovers →](docs/architecture.md)**.

## The trust boundary

```mermaid
flowchart LR
  U["Designer in Onshape"] -->|prompt| P["Right-panel UI<br/>React · Netlify"]
  P -->|same-origin /api/*| N["Netlify HTTPS proxy"]
  N -->|credentialed HTTPS| A["Trusted API<br/>Fastify"]

  subgraph Backend["Persistent private backend"]
    A --> S["Encrypted sessions<br/>SQLite · AES-256-GCM"]
    A --> I["Model inspector<br/>features · assemblies · geometry"]
    I --> C["Codex app-server<br/>isolated CODEX_HOME"]
    C -->|strict JSON plan| A
    A --> V["Schema + live-model<br/>validation + repair feedback"]
  end

  V -->|preview only| P
  U -->|explicit approval| P
  P -->|apply saved plan ID| A
  A -->|approved typed operation| O["Onshape OAuth + Feature / Assembly API"]
  O -->|regeneration after every operation| A
```

The model never receives an Onshape OAuth token, never sends arbitrary REST requests, and never performs CAD mutations during planning. It can use Codex's first-party live web search for public knowledge, while arbitrary command-line network access remains disabled. The API accepts only the typed operation set defined in `@morassistant/cad-command-schema`.

### Safety properties

- **Preview before mutation** — creating a plan and applying it are separate endpoints.
- **Timeout-resistant planning** — the panel starts a background planning job and polls it, so a long Codex turn never depends on a CDN request timeout.
- **Visible live work** — the panel streams inspection state, detailed reasoning summaries, web-research activity, correction passes, and final trusted validation instead of showing a generic skeleton.
- **Source-backed research** — current rules and dimensions are researched with a preference for FIRST, governing bodies, standards, and manufacturer documentation; used sources are clickable in the preview.
- **Strict structured output** — Codex output is normalized and parsed through a closed schema.
- **Verified model runtime** — the configured Sol model and reasoning effort must exist in the signed-in model catalog; a mismatched thread is stopped before planning.
- **Bounded self-repair** — invalid generated plans receive precise validator feedback for at most three attempts.
- **Dependency-aware impact** — direct downstream dependents are surfaced before whole-feature replacement or deletion.
- **Current-state validation** — feature names, parameter expressions, assembly instance identities, occurrence transforms, trusted component sources, and Onshape microversions must still match.
- **Per-operation verification** — execution stops on the first operation that introduces a new regeneration error.
- **Approval-gated recovery** — a failed run can generate an alternate plan from the refreshed model, but cannot apply it automatically.
- **Rate-aware inspection** — unchanged-microversion geometry evidence and verified feature snapshots are cached in encrypted storage, duplicate reads are avoided, and Onshape `Retry-After` windows are honored automatically.
- **Throttle-safe continuation** — if Onshape throttles feature-list reads, planning uses the last verified snapshot and approved mutations retain `rejectMicroversionSkew: true`; successful mutation responses advance the guarded snapshot without guessing.
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
- exact model-catalog verification and high-effort turn pinning;
- the current Codex app-server sandbox and structured-output protocol;
- plan validation against a live feature snapshot;
- complete-curriculum routing and exact live feature-spec delivery to the planner;
- dependency, topology, FeatureScript, and mass-property inspection;
- bounded correction of an initially invalid Codex plan;
- approval-gated circle, rectangle, extrude/cut, fillet, native feature creation, whole-feature replacement, deletion, rename, and dimension mutations;
- per-operation regeneration inspection, fail-fast execution, and approval-gated recovery planning;
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
