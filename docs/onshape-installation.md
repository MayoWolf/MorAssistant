# Install MorAssistant in Onshape

## Existing MorAssistant subscription

1. In Onshape's Developer settings, open your existing **MorAssistant** OAuth application. Set the URLs below. Keep the existing client ID, secret, and right-panel extensions.
2. Set **Redirect URLs** to `https://morassistant-onshape.netlify.app/oauth/onshape/callback`.
3. Set **OAuth URL** to `https://morassistant-onshape.netlify.app/oauth/onshape/start?installationToken=YOUR_TOKEN` for the personal deployment. Use your existing private installation token in place of `YOUR_TOKEN`.
4. In Onshape, open **My account → Applications → MorAssistant → Onshape access** and grant access. Reload an editable Part Studio or Assembly and open the MorAssistant icon in the right sidebar.
5. Choose **Continue with ChatGPT**, then open the verification page and finish the device-code sign-in. The composer starts on **GPT‑6.2 Sol** with **High** reasoning. It lists the other models and reasoning levels available to your signed-in account.
6. Try “What features are in this tab?” or “What’s in this assembly?” You can attach a named feature or instance with **+ CAD target**. To test editing, ask for a feature rename in a disposable Part Studio and review the proposed change before applying it.

For a fresh private install, follow the registration steps below, create a private store entry and select **Subscribe → Get for free**. See the [Onshape App Store](https://cad.onshape.com/appstore) and [Onshape setup example](https://onshape-public.github.io/docs/app-dev/helloworld/).

## New registration

MorAssistant is delivered as an installable Onshape application extension, comparable in product shape to Adam: users subscribe or are assigned the app, open a Part Studio or Assembly, and launch the copilot from Onshape's element right panel. There is no separate end-user dashboard.

The hosted React page and API are implementation infrastructure for the installed extension. Users should encounter them only inside Onshape or during an OAuth authorization redirect.

## Developer Portal configuration

Create an OAuth application in Onshape Developer Portal, or in Developer Settings for a company-owned private application.

Configure:

- Application/store type: **Integrated Cloud App**
- Primary format: a reverse-domain identifier you control, for example `com.yourcompany.morassistant`
- OAuth URL: `https://your-api.example/oauth/onshape/start`
- OAuth redirect URL: `https://your-api.example/oauth/onshape/callback`
- Extension location: **Element right panel**
- Extension contexts: **Part Studio** and **Assembly**. If the portal exposes one context per extension record, create two element-right-panel records with the same action URL and icon.
- Action URL:

```text
https://morassistant-onshape.netlify.app/?documentId={$documentId}&workspaceOrVersion={$workspaceOrVersion}&workspaceId={$workspaceOrVersionId}&elementId={$elementId}&configuration={$configuration}
```

For the personal deployment, keep the private token in the action URL fragment as `#installationToken=YOUR_TOKEN`. The token is available locally through macOS Keychain Access under `com.morassistant.installation-token`. Treat it like a password.

Request only the document read/write permissions required to inspect and update Part Studio features and Assembly definitions. Onshape OAuth is granted as part of assigning or subscribing to the application. It is not a second connection button inside the panel.

The OAuth start endpoint supports Onshape's `redirectOnshapeUri`: after the grant completes, the callback returns the user to Onshape.

## Private installation test

1. Assign the private application to a test user or create a private App Store entry and subscribe to it.
2. Grant **Onshape access** under My account → Applications.
3. Refresh Onshape.
4. Open a workspace Part Studio and then a workspace Assembly; confirm MorAssistant appears in the right panel in both contexts.
5. Use **Continue with ChatGPT** in the panel to complete Codex device-code OAuth.
6. Create a rename-only plan in a disposable document, inspect the preview, and approve it.
7. Confirm the feature name changed and that Onshape Undo restores it.
8. In a disposable Assembly, ask for an inventory answer, then preview an FRCDesignLib component insertion. Confirm the exact source component and placement are shown before approval.

The app intentionally refuses version contexts; feature editing is limited to workspaces.

## Public App Store release

Before submission, complete Onshape's Launch Checklist and supply the store listing, privacy policy, terms, support contact, monitored subscription email, icons/screenshots, and test credentials or instructions required by Onshape review. All public App Store applications must use Onshape OAuth.

Follow the repository's [App Store release and test checklist](app-store-release-checklist.md) for the complete private-beta and public-QA sequence.
