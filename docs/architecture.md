# Architecture

Electron app (electron-vite, React, TypeScript). One local libSQL database. No server.

```
renderer windows (React)           main process                         child processes
─────────────────────────          ─────────────────────────────        ────────────────────────
contacts · chat · tabs · ⌘K   ←IPC→ ChatService ─ HarnessManager ──────→ claude -p (stream-json)
doodle (Excalidraw) · browser       Ingestor (events → messages)         codex app-server
options · onboarding · toast        MCP bridge  (127.0.0.1, token)  ←──  opencode acp / gemini / hermes (ACP)
                                    Voice (Apple helper / MLX sidecar)   any CLI in a PTY · HTTP agents
                                    ASI (decider: Clef) · Discovery      python sidecar (Cohere Transcribe)
                                    libSQL repo (+ FTS5)                 asi-speech (Swift)
```

* **Events, not screens.** Every harness emits the same `AgentEvent` stream (`src/shared/events.ts`). `src/main/ingest.ts`
  persists it as messages and drives presence/status; windows only render messages. A new agent never needs UI work.
* **Windows are thin.** They read through `window.asi.api.*` (every repo method, `REPO_METHODS` is unit-tested against
  the repo) and refetch when main broadcasts `asi:changed`.
* **Safety lives in main.** Modes, the dangerous gate (global switch AND per-friend opt-in), permission decisions, path
  checks (`readInsideWorkspace`), URL rules (`isAllowedNavigation`, http/https only) and secrets (keychain via
  `safeStorage`) are enforced in the main process, not the UI.
* **Local only.** Voice never leaves the Mac; the optional Clef brain is the only network call ASI makes, and only when
  you connect it. The in-app browser has its own session, no preload, no permissions.

## Map

| Area | Where |
|---|---|
| Harnesses | `src/harness/{acp,claude,codex,pty,http}`, `registry.ts`, `manager.ts`, `fake-agent.ts` |
| Chat pipeline | `src/main/{chat-service,ingest,notifications}.ts` |
| Data | `src/main/db/{migrations,repo}.ts` (append-only migrations) |
| ASI | `src/asi/{agent,decider,brain,discovery}.ts`, `src/main/{adopt,secrets}.ts` |
| Tools for agents | `src/main/mcp-bridge.ts` |
| Windows | `src/main/windows.ts`, `src/renderer/src/*.tsx` |
| Voice | `src/main/{voice,cohere-engine,model-manager,voice-runtime,voice-setup}.ts`, `native/` |
| Release | `scripts/`, `build/entitlements.mac.plist`, `docs/releasing.md` |

## Testing seams

Env hooks used by tests: `ASI_USER_DATA`, `ASI_NO_SEED`, `ASI_SKIP_ONBOARDING`, `ASI_NO_TOAST`, `ASI_TEST_PATH`,
`ASI_TEST_FOLDER`, `ASI_TEST_FILES`, `ASI_VOICE_FAKE`, `ASI_FAKE_RECORDER`, `ASI_VOICE_MODELS_JSON`,
`ASI_VOICE_SKIP_RUNTIME`, `ASI_DISCOVERY_HOME`, `ASI_CLEF_BASE`. None changes behavior unless set.
