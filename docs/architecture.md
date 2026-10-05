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

## Usage and limits

Two kinds of numbers, kept apart. **Spend** is a log (`usage_log`) with one row per call or turn, written from `{ t: 'usage' }` events; each
adapter publishes a delta (Claude's `total_cost_usd` and Codex's cumulative counters are differenced; ACP uses the prompt result, not the
context-size update). Cost is stored only when an agent reports it, so totals count how many calls were priced and the UI says
"not reported" instead of $0. Rows copy the chat, agent and workspace names, so totals survive deleting any of them. **Limits** are the
agents' own subscription windows: Claude Code sends `rate_limit_event` with each turn (5-hour and weekly utilisation), Codex answers
`account/rateLimits/read` and `account/usage/read` (including usage outside the app). They are stored as settings (`limits:<provider>`) with
the time we learned them; a window whose reset time has passed renders as reset. Codex is probed for free on Refresh; Claude only reports
while answering, so its Refresh sends one tiny request. Everything sent to a model first goes through `src/shared/redact.ts`.

## Isolated chats (git worktrees)

"New chat in its own worktree" (`src/main/worktrees.ts`) runs `git worktree add -b asi/<name>` from the repo's current HEAD into
`<app data>/worktrees/<repo>/<name>` (outside the repo, so it stays clean). The chat stores `worktree_path` and `branch`, and every
place that used the workspace folder (the agent's cwd, `!cmd`, `/open`, pictures in `.attachments/`, the attachment viewer, "continue in
Terminal") uses the chat's worktree instead. When the workspace is a sub-folder of a repo, the agent starts in the same sub-folder of
the worktree. Removal never forces: a worktree with uncommitted changes stays (and you are told where), a branch with unmerged commits
stays, and "Delete all chats" follows the same rules. A folder that is not a repo, or a repo with no commits, gets a clear message and
nothing is created.

## Chat titles

A chat's title has a source (`chats.title_source`), and a better source may replace a worse one: `default` ("New chat") →
`rule` (your first message, filler words dropped, `src/shared/title.ts`) → `model` → `agent`. A title you typed (or a chat created
with one) is `user` and is never replaced.

- **Agent**: harnesses emit `{ t: 'title' }` when the agent names its own session (ACP `session_info_update`, Codex
  `thread/name/updated`). Claude Code and Pi do not announce titles in their headless modes.
- **Model**: after the first exchange, a connected general chat model (`llm` brain) writes a 2–6 word title
  (`src/asi/titler.ts`). Clef and Jev classify and cannot write text, so they never title. It tries at most twice per chat and a
  failure keeps the rule title.

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
