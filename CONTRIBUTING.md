# Contributing to MorAssistant

Thanks for helping improve MorAssistant. The project is an approval-first Onshape right-panel extension, so changes that affect CAD mutations, authentication, or user data need especially careful review.

## Development setup

Requirements are Node.js 22 or newer, npm, and a current Codex CLI.

```bash
npm ci
npm run check
```

Use `npm run mock:pipeline` for a deterministic manual UI test that does not access a real Onshape document or OpenAI account.

## Pull requests

- Keep each pull request focused and explain the user-visible behavior.
- Add or update tests for every behavior change.
- Preserve preview-before-approval and stale-plan protections.
- Never commit OAuth tokens, Codex credential directories, `.env` files, customer CAD payloads, or production document identifiers.
- Run `npm run check` and `npm audit --omit=dev` before requesting review.
- Use a disposable Onshape document for any live integration test.

## Feature operations

New CAD mutation types require a closed schema, deterministic validation against a freshly read feature tree, explicit approval, microversion guards, regeneration inspection, and captured fixtures from a dedicated test document.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
