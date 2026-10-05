# Contributing

## Get running

```bash
pnpm install      # Node 22+, pnpm
pnpm dev          # run the app (first run seeds an Echo friend and ASI)
pnpm test         # unit tests
```

Start with [docs/architecture.md](docs/architecture.md). The one contract every agent integration targets is
`src/shared/events.ts`; [docs/harnesses.md](docs/harnesses.md) shows how to add one.

## Rules

- `pnpm typecheck && pnpm lint && pnpm test` must pass; `pnpm test:e2e` for UI changes.
- A new harness ships with unit tests against a mock, and a live test in `test/live/` (skipped unless `ASI_LIVE=1`).
- One focused commit per change, each independently testable.
- Never commit secrets, certificates, API keys or private API documentation. Credentials live in the macOS Keychain.
- All artwork and sounds must be original. No third-party Messenger assets.
