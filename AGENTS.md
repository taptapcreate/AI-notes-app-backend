# AI Notes backend workspace

This is the canonical AI Notes backend repository:
`/Users/pzutshi/Downloads/Personal/Projects/tap-tap-projects/Ai-App-Project/ai-notes-backend`.
Its Git remote is `git@github.com:taptapcreate/AI-notes-app-backend.git`.

The user explicitly asked that future AI Notes backend changes be made here.
`ai-notes-desktop-app/backend-credit-catalog-update` is an older working copy,
not the backend source of truth. Do not make backend changes only in that copy or
ask the user to manually transfer source files when this repository is available.

Merge changes into the current source; preserve newer media pricing, monthly
subscription accounting, provider configuration, and other existing behavior.
Run `npm test` with isolated test databases. Do not use production credentials or
production credits for validation. Never commit `.env`, credentials or dependencies.
Prepare local changes for the user to push. Do not push or deploy without an
explicit request. No desktop build is needed for backend-only changes.
