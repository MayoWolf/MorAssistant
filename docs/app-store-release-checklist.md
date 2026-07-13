# Onshape App Store release and test checklist

MorAssistant is an **Integrated Cloud App** with an **Element right panel** extension. Its hosted page is displayed by Onshape in an iframe; it is not marketed or installed as a separate web app.

## 1. Prepare a production deployment

Deploy the panel to a public HTTPS origin such as Netlify and deploy the API/Codex worker to a persistent HTTPS container service. The API must be reachable continuously from the regions in which the app will be offered. Set `VITE_API_ORIGIN` in the panel build when the origins differ.

Set these production values in the host's secret manager:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
APP_ORIGIN=https://morassistant-onshape.netlify.app
SESSION_SECRET=<at least 32 random characters>
SESSION_ENCRYPTION_KEY=<separate high-entropy secret>
INSTALLATION_TOKEN=<private token for a personal deployment>
ONSHAPE_CLIENT_ID=<Developer Portal key>
ONSHAPE_CLIENT_SECRET=<Developer Portal secret>
ONSHAPE_REDIRECT_URI=https://api.your-domain.example/oauth/onshape/callback
ONSHAPE_AUTHORIZATION_URL=https://oauth.onshape.com/oauth/authorize
ONSHAPE_TOKEN_URL=https://oauth.onshape.com/oauth/token
ONSHAPE_BASE_URL=https://cad.onshape.com
ONSHAPE_API_VERSION=v13
CODEX_COMMAND=codex
CODEX_USERS_ROOT=<encrypted persistent volume path>
```

The encrypted SQLite store and Codex credential directories survive restarts. Before a public multi-user launch, replace the private installation-token binding with verified Onshape user identity, add capacity-aware scaling and quotas, and publish deletion/retention policies for OAuth tokens, plans, and Codex credential directories. The checked-in installation-token mode is deliberately limited to a controlled private deployment.

Also prepare:

- monitored uptime and error alerts;
- an actively monitored support URL and support email;
- privacy policy, terms, and data-retention/deletion documentation;
- a rollback procedure and a frozen release version;
- the included [SVG icon](../assets/morassistant-onshape-icon.svg), plus listing hero and screenshot images.

## 2. Register the Onshape OAuth application

For an individual developer, open the [Onshape Developer Portal](https://cad.onshape.com/appstore/dev-portal/). Company, Classroom, and Enterprise administrators can instead use Developer Settings.

1. Open **OAuth applications** and choose **Create new OAuth application**.
2. Enter `MorAssistant`, a reverse-domain primary format such as `com.yourcompany.morassistant`, and a short summary.
3. Select **Integrated Cloud App**.
4. Add `https://api.your-domain.example/oauth/onshape/callback` as the redirect URL.
5. Set the OAuth URL to `https://api.your-domain.example/oauth/onshape/start`.
6. Select only the document permissions needed to read and update Part Studio features. Do not request global or unrelated permissions.
7. Create the application and immediately place the displayed client key and one-time-visible secret in the production secret manager.

The OAuth URL is the Onshape installation grant. The panel intentionally does not show an extra “Connect Onshape” button. **Continue with ChatGPT** is a separate Codex sign-in inside the installed panel.

For a private single-user deployment, append `?installationToken=YOUR_TOKEN` to the OAuth URL. The backend validates it with a timing-safe comparison and maps the OAuth callback to the same owner session used by the panel.

## 3. Add the right-panel extension

Open the new OAuth application's **Extensions** tab, select **Add extension**, and enter:

- Name: `MorAssistant`
- Location: **Element right panel**
- Context: **Part Studio**
- Action URL:

```text
https://morassistant-onshape.netlify.app/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceId={$workspaceOrVersionId}&elementId={$elementId}&configuration={$configuration}
```

For a private single-user deployment, append `#installationToken=YOUR_TOKEN`. The panel moves it into session storage and removes it from the visible URL before making API requests. Do not use a shared installation token for a public multi-user release.

- Icon: `assets/morassistant-onshape-icon.svg` or a PNG exported to the dimensions requested by the portal

Onshape automatically adds default query parameters for this location, including `server`, `companyId`, `userId`, `locale`, and `clientId`. MorAssistant validates `server` and only permits editable workspace (`w`) contexts.

## 4. Create a private App Store entry

On the application's **Details** tab, select **Create store entry** and fill in:

- Type: **Integrated Cloud App** (must match registration)
- Category: the closest current AI/design-automation category offered by the portal
- Team visibility: only the beta team initially
- Description: explain that the app runs in the Onshape right panel, previews operations, and requires approval before editing
- Support URL and support email: actively monitored destinations
- Vendor and version
- Summary/hero images and narrow-panel screenshots

Keep the entry private. For an individual account, find the private listing in the App Store and select **Subscribe**. For a company account, an administrator can assign the app to users or teams in Developer Settings. Refresh the Onshape browser after subscription/assignment.

## 5. Test locally without external accounts

Run the automated suite:

```bash
npm ci
npm run check
npm audit --omit=dev
```

Expected result: all workspace typechecks/builds succeed, the production dependency audit is clean, and all tests pass. The full-pipeline test covers:

- iframe-compatible security headers;
- valid and invalid Onshape OAuth state;
- state-changing request origin checks;
- Codex device-code completion, including an immediate-event race;
- model output schema and live feature-tree validation;
- approval before mutation;
- Onshape microversion skew guards;
- regeneration inspection;
- replay and concurrent duplicate-apply rejection;
- workspace-only and expected-Onshape-stack enforcement.

For a manual deterministic UI pass, run `npm run mock:pipeline`, visit the printed app origin's `/oauth/onshape/start`, and then open the panel URL described in the README. Confirm the narrow panel completes sign-in, preview, approval, and success with no browser console errors.

The private installation token binds the iframe to the owner session without third-party cookies. A public multi-user release must replace that private token with a per-user identity and OAuth handoff design.

## 6. Test the private installation in real Onshape

Use a disposable document owned by the beta team, never a production design.

1. In **My account → Applications**, grant Onshape access to MorAssistant.
2. Refresh Onshape and open a workspace Part Studio.
3. Launch MorAssistant from the right panel.
4. Select **Continue with ChatGPT**, open the verification page, enter the one-time code, and return to Onshape.
5. Ask `Rename Extrude 1 to Base Extrusion`. Verify that the preview names the exact existing feature ID/name and does not change CAD yet.
6. Select **Approve & apply**. Verify the feature changes once, the result reports success, and Onshape Undo restores it.
7. Ask for an existing quantity change such as `Change Extrude 1 depth from 4 mm to 6 mm`. Verify the expression and units before and after approval, then undo.
8. Create a plan, manually modify the target feature in Onshape, and then approve the old plan. It must reject the stale preview without applying it.
9. Double-click approval or issue simultaneous approvals. Only one apply may succeed.
10. Revoke MorAssistant under **My account → Applications**, let the token expire or trigger an API call, and verify the panel reports that Onshape access is missing.

Run the wider release matrix:

- empty Part Studio; sketches, surfaces, and wire-only studios; suppressed/failed features;
- feature trees with more than 20 and more than 100 features;
- standard and configured Part Studios (configured studios currently allow renames but reject dimension edits with an explicit message);
- workspace versus version (versions must be read-only/rejected here);
- rename and dimension changes that create regeneration errors;
- expired/revoked Onshape grants and failed/cancelled Codex sign-in;
- browser refresh, API restart, slow network, 429 responses, and temporary Onshape/Codex outages;
- Chrome, Edge, Firefox, and Safari at narrow right-panel widths;
- personal and company-owned documents, plus every supported Onshape stack;
- browser console/network review with no avoidable errors or sensitive values in logs.

Record the app version, browser, test document, expected result, actual result, and evidence for every case. Onshape recommends at least five active beta testers before launch.

## 7. Request Onshape QA and publish

Complete Onshape's developer agreement and launch checklist, then contact Developer Relations to open the required QA/release request. Provide:

- the private App Store entry and frozen version;
- supported browsers, regions, account types, and Onshape stacks;
- OAuth and Codex sign-in instructions for reviewers;
- a disposable test document and safe prompts;
- support escalation, privacy policy, terms, status page, and rollback contacts;
- the completed test matrix and known limitations.

Do not change code while Onshape QA is evaluating the submitted build. Resolve findings in a new version and repeat the relevant tests. After approval, change the listing visibility according to Onshape's release instructions and verify the public subscription/install flow with an account that was not part of the beta.

Primary Onshape references: [App development](https://onshape-public.github.io/docs/app-dev/), [extensions](https://onshape-public.github.io/docs/app-dev/extensions/), [App Store workflow](https://onshape-public.github.io/docs/app-store/), [launch checklist](https://onshape-public.github.io/docs/app-store/checklist/), [testing guidelines](https://onshape-public.github.io/docs/app-store/testingguidelines/), and [quality considerations](https://onshape-public.github.io/docs/app-store/quality/).
