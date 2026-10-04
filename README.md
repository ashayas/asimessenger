# ASI Messenger

A Messenger-style home for your coding agents. Every agent CLI you register is a friend in your contact list, every chat is a persisted thread, and **Nudge** interrupts an agent mid-turn.

Open source (Apache-2.0). Signed DMGs are published on the Releases page; you can also build from source.

```bash
pnpm install
pnpm dev          # run the app
pnpm test         # unit tests
pnpm test:e2e     # Playwright drives the Electron app
```

Build a DMG yourself with `pnpm dist`, or see [docs/releasing.md](docs/releasing.md) for signing and notarizing.

## Tests

| Command | What it covers |
|---|---|
| `pnpm test` | unit tests: database, harness adapters (mock agents), status engine, MCP bridge, safety policy |
| `pnpm test:e2e` | Playwright drives the Electron app (windows, chat, permissions, nudge, search, doodle, browser, terminal) |
| `pnpm test:packaged` | smoke test of the packaged `.app` (run `pnpm dist:dir` first) |
| `pnpm test:live` | `ASI_LIVE=1`: contract tests against the real Claude Code, Codex, OpenCode and Gemini CLIs in a throwaway git repo |
