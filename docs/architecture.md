# Architecture

Electron app (electron-vite, React, TypeScript). One local libSQL database. No server.

```
renderer windows (React)           main process                         child processes
─────────────────────────          ─────────────────────────────        ────────────────────────
contacts · chat · tabs · ⌘K   ←IPC→ ChatService ─ HarnessManager ──────→ claude -p (stream-json)
doodle (Excalidraw) · browser       Ingestor (events → messages)         codex app-server
options · onboarding · toast        MCP bridge  (127.0.0.1, token)  ←──  opencode acp / gemini / hermes (ACP)
                                    Voice (Apple helper / MLX sidecar)   any CLI in a PTY · HTTP agents
                                    ASI (any decision model) · Discovery      python sidecar (Cohere Transcribe)
                                    libSQL repo (+ FTS5)                 asi-speech (Swift)
```

* **Events, not screens.** Every harness emits the same `AgentEvent` stream (`src/shared/events.ts`). `src/main/ingest.ts`
  persists it as messages and drives presence/status; windows only render messages. A new agent never needs UI work.
* **Windows are thin.** They read through `window.asi.api.*` (every repo method, `REPO_METHODS` is unit-tested against
  the repo) and refetch when main broadcasts `asi:changed`.
* **Safety lives in main.** Modes, the dangerous gate (global switch AND per-friend opt-in), permission decisions, path
  checks (`readInsideWorkspace`), URL rules (`isAllowedNavigation`, http/https only) and secrets (keychain via
  `safeStorage`) are enforced in the main process, not the UI.
* **Local only.** Voice never leaves the Mac; the optional decision model is the only network call ASI makes (a local model makes none), and only when
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

## ASI's decision model

ASI asks typed questions (yes/no, pick-one, score) and gets probabilities back (`src/asi/decider.ts`). Anything that
answers that shape can be the brain, set up in Add a friend › ASI brain:

| Provider | Talks to | Notes |
|---|---|---|
| `clef` | Cloudflare Workers AI `@cf/cloudflare/clef`, `clef-flash` | purpose-built, ~40 ms |
| `systemone` | `POST {endpoint}/v1/systemone` | Jev, via its own API or OpenRouter (`typesafe/jev-1.13`), or any server with the same shape |
| `llm` | `POST {endpoint}/chat/completions` | any OpenAI-compatible chat model, including local Ollama / LM Studio. Its JSON answers are validated and normalized |

Local rules (`heuristicRisk`) are always a floor: a model can raise a risk label, never lower it, and any failure falls back
to the rules alone. Keys live in the keychain; endpoints must be https unless they are on this Mac. To add another
provider, write a `Decider` (`decide(state, questions) -> answers`) and a case in `src/asi/brain.ts`.

## Testing seams

Env hooks used by tests: `ASI_USER_DATA`, `ASI_NO_SEED`, `ASI_SKIP_ONBOARDING`, `ASI_NO_TOAST`, `ASI_TEST_PATH`,
`ASI_TEST_FOLDER`, `ASI_TEST_FILES`, `ASI_VOICE_FAKE`, `ASI_FAKE_RECORDER`, `ASI_VOICE_MODELS_JSON`,
`ASI_VOICE_SKIP_RUNTIME`, `ASI_DISCOVERY_HOME`, `ASI_CLEF_BASE`. None changes behavior unless set.
