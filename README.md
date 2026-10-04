# ASI Messenger

A Messenger-style home for your coding agents. Every agent CLI you register is a friend in your contact list, every chat is a persisted thread, and **Nudge** interrupts an agent mid-turn.

## What it does

- **Agents are friends.** Claude Code, Codex, OpenCode, Gemini CLI, Hermes, Pi, any ACP agent, any CLI (raw terminal) and any streaming HTTP service. One chat window (or tab) per thread, persisted.
- **Warp-style conversation.** Command blocks, permission cards with risk labels, questions, markdown/code/diff attachments you can reply to by quoting a selection.
- **Nudge** interrupts an agent (with the shake and the sound). Presence, unread badges, toasts and the dock badge tell you who needs you.
- **ASI**, the always-online friend: "status", "who needs me", "what's running outside Messenger", "find …"; optional Cloudflare Clef brain.
- **Safe by default.** Ask mode everywhere; dangerous mode needs a global switch and a per-friend opt-in.
- **Tools built in.** ⌘K search, ⌘1–9 workspaces, Excalidraw doodles saved in `<workspace>/.drawings`, an in-app browser, push-to-talk voice that never leaves your Mac.

Docs: [architecture](docs/architecture.md) · [harnesses](docs/harnesses.md) · [voice](docs/voice.md) · [releasing](docs/releasing.md).

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
