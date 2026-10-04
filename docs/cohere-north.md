# Adding Cohere North as a friend

A hand-off guide for whoever connects ASI Messenger to Cohere North. It assumes you have never opened this repo and
that you have access to North's internal API documentation, which this repo deliberately does not contain.

North is not built in. ASI Messenger ships a generic way to plug in a remote agent. This guide covers what
exists, what to collect from the North side, how to build the integration, and how to prove it works.

## 1. Goal

A "Cohere North" contact appears in the contact list. You open a chat with it and:

- your messages stream a reply back, like any other friend,
- Nudge stops a running reply,
- a chat resumes the same North conversation after the app restarts,
- anything North wants to ask or get approved (tool calls, questions) shows up as the same cards other friends use,
- the North credential is stored in the macOS keychain, never in the database, repo, logs or a config file.

## 2. Orient yourself in 15 minutes

```bash
git clone https://github.com/ashayas/asimessenger && cd asimessenger
pnpm install          # Node 22+, pnpm
pnpm dev              # runs the app; first run seeds an Echo friend and ASI to click around with
pnpm test             # ~175 unit tests, a few seconds
```

Read these, in this order (about 20 minutes in total):

| File | Why |
|---|---|
| `docs/architecture.md` | the picture: renderer ↔ main ↔ agent processes |
| `src/shared/events.ts` | **the only contract.** Every agent turns what it does into `AgentEvent`s. The UI never knows which agent it talks to |
| `src/harness/types.ts` | `HarnessFactory` and `SessionContext` (the friend, chat, cwd, mode, resume id, MCP endpoint) |
| `src/harness/http/{manifest,session,factory}.ts` | the generic HTTP adapter you will start from (about 180 lines) |
| `test/unit/http-harness.test.ts` | how an adapter is tested against a local mock server |
| `src/harness/pi/session.ts` | a complete adapter for a JSONL-over-stdio agent, with permissions and questions. The best example of the full event surface |
| `docs/harnesses.md` | how each built-in harness works |

## 3. What the generic HTTP harness does and does not do

It is driven by a **manifest** (JSON you paste in *Add a friend › HTTP*, or a preset in code). It handles:

- one POST per message, JSON body from a template (`{{text}}`, `{{session}}`),
- reply as SSE, NDJSON or one JSON document, with dot-path mapping for text, done, conversation id and errors,
- a Bearer token from the keychain, an optional cancel endpoint, Nudge (drops the connection), resume via the conversation id.

It does **not** do, and a North integration probably needs some of these:

| Gap | Why it matters for North |
|---|---|
| Only the text field is mapped | no tool-call cards, thinking, attachments or usage |
| No permission or question events (`respond()` is a no-op) | if North asks for approval before acting, nothing shows up and nothing can be answered |
| Modes are not enforced (`setMode()` is a no-op) | **if a North agent can take actions, Ask/Plan/Dangerous do nothing for it.** See section 7 |
| Bearer token only | no OAuth/PKCE, no per-user login, no token refresh |
| One fixed endpoint | cannot list North's agents and show each as its own contact |

That decides your path in section 5.

## 4. What to collect from Cohere first

Get answers to these before writing code. Most of the work is learning the API, not writing the adapter.

1. **Auth.** Bearer API key, OAuth app (authorization code + PKCE?), per-user tokens, refresh and expiry. Who creates credentials? Which scopes?
2. **Base URL.** One host, or per-customer/instance (`https://{instance}/...`)? Is it reachable from a laptop (VPN, allowlist)?
3. **Send a message.** Endpoint, request body, how to attach a conversation id, how to select *which agent*.
4. **Streaming.** SSE, NDJSON, WebSocket or polling? The exact event types and fields. Capture a real stream to a file and keep it (without secrets) as your test fixture.
5. **Conversations.** How a new conversation is created, how an existing one is resumed, whether history can be fetched.
6. **Agents.** Is there a list-agents endpoint? One friend per agent, or one North friend with a picker?
7. **Tool use and approvals.** Does North run tools server-side? Does it ask the client to approve or answer? What does that event look like and how do you reply to it?
8. **Cancel.** A stop endpoint? Does dropping the connection stop the run on the server?
9. **Files and links.** Can replies contain files, images, citations or URLs worth surfacing as attachments or links?
10. **Errors and limits.** Rate limits, error body shape, status codes that mean "token expired".
11. **A test environment.** A non-production instance and a throwaway credential you can use for live tests.

Keep the answers in your private fork (section 9), not in this public repo.

## 5. Pick a path

### Path A: manifest only (try this first)

Use it if North streams text from one endpoint with a Bearer token and you do not need tools or approvals.

1. Capture a real streamed reply and write the manifest. Map `text`, `done`, `session` and `error` to the right dot paths:

   ```jsonc
   {
     "baseUrl": "https://YOUR-INSTANCE/api",
     "auth": { "type": "bearer", "secret": "north" },
     "send": { "path": "<chat endpoint>", "body": { "message": "{{text}}", "conversation_id": "{{session}}" } },
     "stream": "sse",
     "map": { "text": "<where the reply text is>", "done": { "path": "<field>", "equals": "<value>" }, "session": "<conversation id field>", "error": "<error field>" },
     "cancel": { "path": "<stop endpoint if any>" }
   }
   ```
2. Try it live in the app: *Add a friend › HTTP*, paste the manifest, enter the token.
3. Ship it as a one-click preset: see "Register the friend" below.
4. Add a unit test that serves your captured stream from a local server (copy the pattern in `test/unit/http-harness.test.ts`).

### Path B: a dedicated `north` harness (likely, if you answered yes to approvals, agents or OAuth)

Write an adapter the same way Pi and Claude are written. This is the full recipe:

1. **`src/shared/models.ts`**: add `'north'` to `HarnessKind`.
2. **`src/harness/north/session.ts`**: implement `AgentSession` (`src/shared/events.ts`). Translate North's stream into events:

   | North does this | Emit |
   |---|---|
   | starts thinking / working | `{ t: 'status', phase: 'thinking' }` |
   | text delta | `{ t: 'text', id, delta }` (same `id` for deltas of one message) |
   | reasoning delta | `{ t: 'thinking', id, delta }` |
   | starts / finishes a tool | `{ t: 'tool', id, kind, title, command?, output?, exit?, done }` (emit again with `done: true`) |
   | asks to approve an action | `{ t: 'permission', reqId, tool, summary, options }` and **wait** for `respond(reqId, 'allow-once' \| 'allow-chat' \| 'deny')`, then answer North |
   | asks the user a question | `{ t: 'question', reqId, prompt, choices? }` and wait for `respond(reqId, answerText)` |
   | produces a file or document | `{ t: 'attachment', id, kind, name, body? }` |
   | token usage | `{ t: 'usage', inputTokens, outputTokens, costUsd? }` |
   | finishes | `{ t: 'turn_end', reason: 'done' }` |
   | fails | `{ t: 'turn_end', reason: 'error', error }` (one line, human readable) |

   Also: `interrupt()` must stop the run and resolve once it has (then emit `turn_end` with `reason: 'interrupted'`), `resumeId` is whatever lets you continue the conversation (it is stored on the chat), and a `send()` while a turn is running must not crash. Copy the structure of `src/harness/pi/session.ts`.
3. **`src/harness/north/factory.ts`**: a `HarnessFactory`. It needs the keychain, so take `secrets` as a parameter like `httpFactory(secrets)` does in `src/harness/http/factory.ts`.
4. **Register it**: in `src/harness/registry.ts` (`extra.north`) and pass it from `src/main/index.ts` next to `http: httpFactory(secrets)`.
5. **Availability**: `availability()` in `src/main/friends-service.ts` skips non-CLI harnesses (`http`, `echo`, ...). Add `'north'` to that list, since it has no binary to look for.
6. **Auth UI**: Bearer token entry already exists in *Add a friend › HTTP* (`src/renderer/src/AddFriend.tsx`, `addCustom()` in `friends-service.ts`). Reuse it for a key. For OAuth, add a small sign-in step that runs in the **main** process and stores the token via `secrets.set('north', ...)`. The renderer must never see the token.
7. **Avatar and resume**: add a `north` entry in `src/shared/harness-meta.ts` (letter and two gradient colors). `src/shared/resume.ts` returns `null` for harnesses that cannot be resumed in a terminal, which is right for North.

### Register the friend (both paths)

Add one entry to `PRESETS` in `src/shared/presets.ts`. Presets are CLI-oriented (they look for a binary), so for North either:

- add a small "service" preset that skips detection, or
- keep it out of `PRESETS` and offer a dedicated *Add a friend › Cohere North* form that asks for instance URL + credential and calls `addCustom` / a new `addNorth` in `friends-service.ts`.

The second is cleaner for a service that needs an instance URL.

## 6. Tests: how to prove it works

Match the rest of the repo: an adapter ships with all of these.

1. **Unit tests against a mock North** (`test/unit/north.test.ts`, mock server under `test/fixtures/`). Cover: streamed text, conversation id remembered for the next message, bearer header sent, permission request answered with Allow once and with Deny, question answered, Nudge mid-stream, a 401/429/500 turning into an `error` turn (not a crash or a hang), a dropped connection. Use your captured real stream as a fixture.
2. **A live test** (`test/live/north.live.test.ts`, skipped unless `ASI_LIVE=1`). Read `ASI_NORTH_URL` and `ASI_NORTH_TOKEN` from the environment and skip when they are absent. Copy `test/live/pi.live.test.ts`: reply, a tool/approval round trip, Deny stops the action, Nudge, resume remembers. Never hard-code a credential and never commit one.
3. **An e2e** if you added UI (`test/e2e/`, Playwright drives the real app). See `test/e2e/helpers.ts` and `test/e2e/http-friend.spec.ts`, which adds an HTTP friend against a local server.
4. `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` must pass.

Run live tests with `ASI_LIVE=1 ASI_NORTH_URL=... ASI_NORTH_TOKEN=... pnpm test:live`.

## 7. Safety rules that apply to North

- **Modes must be real.** Ask prompts before edits and shell commands, Plan is read-only, Dangerous needs the global switch **and** the friend's own opt-in (`canUseMode` in `src/shared/safety.ts`). If North can act on the user's behalf and you cannot enforce a mode, do not pretend to: surface that in the friend's blurb, route every approval North offers through a `permission` card, and treat "no approval event available" as Ask-only with actions disabled where the API allows.
- **Credentials**: keychain via `secrets` only. Do not log request headers. Do not put tokens in manifests, URLs or the database. `parseManifest` already refuses plain `http` except to localhost; keep it that way.
- **Data**: North is a remote service, so chat text leaves the Mac to reach it. That is expected for this friend, but say so in the friend's description.
- Never loosen the existing checks (workspace-confined file reads, http(s)-only browser) to make an integration work.

## 8. Definition of done

- [ ] Adding "Cohere North" takes under a minute and needs no terminal.
- [ ] A reply streams, a second message continues the same conversation, and it still does after restarting the app.
- [ ] Nudge stops a running reply within a couple of seconds and the chat stays usable.
- [ ] Every approval/question North raises appears as a card and the answer reaches North; Deny actually denies.
- [ ] Bad token, expired token, rate limit and network loss each show a clear one-line error, never a frozen chat.
- [ ] The credential is only in the keychain (check the database file and the logs).
- [ ] Unit, live (with your test instance) and, if relevant, e2e tests are in and pass; `docs/harnesses.md` mentions the new harness.
- [ ] The commit(s) follow `CONTRIBUTING.md`.

## 9. Where to keep internal information

This repository is public. Cohere-internal material (private API reference, internal hostnames, real captured traffic,
credentials) must not be committed here. Keep North in a **private fork**, and put internal notes in that fork's own
`docs/` folder. If the adapter itself is meant to be public, upstream only the generic parts and keep the
instance-specific values (URLs, tenant names) in configuration.

## 10. Ask the repo

The shapes above come from working code, so when in doubt read the nearest example:

| You need to | Look at |
|---|---|
| stream text and tools from a process | `src/harness/claude/session.ts`, `src/harness/pi/session.ts` |
| ask the user and wait | `onUi()` in `src/harness/pi/session.ts` |
| call a remote HTTP stream | `src/harness/http/session.ts` |
| inject ASI's tools (`ask_user`, `send_attachment`, ...) | `ctx.mcp` in `src/harness/types.ts`, `src/main/mcp-bridge.ts` |
| store a secret | `src/main/secrets.ts` |
| test a streaming adapter | `test/unit/http-harness.test.ts`, `test/unit/pi.test.ts` |
