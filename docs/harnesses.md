# Harnesses: how agents plug in

Every friend is a **harness**: something that turns "you typed a message" into a stream of normalized events
(`src/shared/events.ts`: text, thinking, tool, permission, question, attachment, links, status, turn_end). The UI only
knows those events, so a new harness never needs UI work.

| Harness | Transport | Used for |
|---|---|---|
| `claude` | `claude -p` stream-json + `--permission-prompt-tool stdio` | Claude Code |
| `codex` | `codex app-server` JSON-RPC | Codex |
| `agy` | `agy -p= --input-format stream-json --output-format stream-json` | Antigravity CLI |
| `pi` | `pi --mode rpc` (JSONL) + a bundled gate extension | Pi |
| `acp` | Agent Client Protocol over stdio | OpenCode, Hermes, anything ACP |
| `pty` | a real pseudo-terminal | any CLI with no protocol |
| `http` | manifest-driven HTTP (SSE / NDJSON / JSON) | hosted agents |
| `asi`, `echo`, `fake` | in-process | ASI, a smoke-test friend, tests |

Claude, Codex, Pi, and compatible ACP harnesses also get **ASI's MCP tools** (`ask_user`, `send_attachment`, `open_url`, `open_drawing`,
`set_status`) injected, so questions and attachments behave the same everywhere.

## ACP

ASI negotiates ACP version 1 and rejects incompatible versions. Initialize and session setup have 30-second deadlines; normal model turns remain unbounded until interrupted. Cancellation resolves outstanding permission requests as cancelled and waits for the prompt result. If the agent ignores cancellation for four seconds, ASI closes its process and resumes the saved session on the next message. Disconnects emit one terminal error, and updates from another session are ignored.

OpenCode's preset injects launch-time permissions: Ask requests edits and commands, Auto-edit permits edits while asking for commands, Plan denies edits, and Dangerous permits all tools. A mode change restarts the adapter with the new policy. Generic ACP agents must supply their own permission policy or a configured mode map; ACP itself does not define ASI's four permission modes. HTTP MCP tools are injected only when the agent advertises support. Unsupported image input is rejected explicitly.

Regression coverage includes stalled startup, incompatible versions, broken pipes, ignored cancellation, pending approvals, reconnect, and image capabilities. Real OpenCode tests exercise approvals, mode changes, MCP, and resume. See [ACP v1 prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn).

## Antigravity

Agy uses a persistent stream-json process. Auto-edit passes `--mode accept-edits`; Dangerous passes
`--dangerously-skip-permissions` after the global and friend opt-ins. Mode changes restart the process while resuming the
conversation. A live contract test in `test/live/agy.live.test.ts` checks replies, mode switching, file writes, and shell commands.

Headless Ask mode reports denied actions instead of pausing for approval. The app shows these as cards; accepting one temporarily
adds the exact rule to Agy's settings and restarts the conversation to retry it. Settings updates are serialized across chats and
existing user rules are preserved. Allow-once rules are removed at turn end and the process is refreshed before the next prompt
so cached grants cannot carry into that turn. These rules are in Agy's shared settings: they are not isolated from other Agy
processes launched while a grant exists. Agy does not currently receive the app's MCP tools.

## Pi

Pi speaks its own JSONL RPC, so ASI Messenger talks to it directly (no ACP adapter). Pi has no permission prompts or MCP,
so the app loads `native/pi/asi-extension.js` with `pi -e`. The extension:

- **gates tools by the chat's mode.** Ask prompts for `bash`, `edit` and `write`. Auto-edit allows edits and still prompts for bash. Plan blocks edits. Dangerous allows everything (and needs both opt-ins). The mode lives in a small file the app rewrites, so switching mode mid-chat takes effect on the next tool call. An unreadable file means Ask.
- **proxies ASI's tools** (`ask_user`, `send_attachment`, ...) to the local MCP bridge.

Sessions are Pi session files under `~/.pi/agent/sessions/asi-messenger/`, so `pi --session <file>` continues any chat in a terminal.
Pick a model with the friend's arguments, e.g. `--provider openrouter --model anthropic/claude-haiku-4.5`; log in once with `pi` and `/login`, or set a provider key.

## Add a service over HTTP (no code)

Add a friend › **HTTP**, paste a manifest, enter the token (kept in the macOS keychain).

```jsonc
{
  "baseUrl": "https://agents.example.com/api",        // https only (http allowed for localhost)
  "send": {
    "path": "/chat",
    "body": { "message": "{{text}}", "conversation_id": "{{session}}" }   // {{session}} is dropped on the first turn
  },
  "stream": "sse",                                      // "sse" | "ndjson" | "json"
  "map": {
    "text": "delta",                                    // dot path to the reply text (a delta when streaming)
    "done": { "path": "finish_reason", "equals": "stop" },
    "session": "conversation_id",                       // remembered and sent back on the next message
    "error": "error.message"
  },
  "cancel": { "path": "/chat/{{session}}/stop" }        // optional; Nudge always drops the connection too
}
```

## Add a protocol (code)

1. `src/harness/<name>/session.ts`: implement `AgentSession` (`send`, `interrupt`, `respond`, `setMode`, `dispose`, `subscribe`).
   Emit events; never touch the database. Keep a mock of the real thing under `test/fixtures/` for unit tests.
2. `src/harness/<name>/factory.ts`: a `HarnessFactory` that starts the process/connection from a `SessionContext`
   (`friend`, `cwd`, `mode`, `resumeId`, `mcp`).
3. Register it in `src/harness/registry.ts`.
4. Add a live contract test in `test/live/` (skipped unless `ASI_LIVE=1`): reply, Deny leaves no file, Allow writes it,
   Nudge interrupts, resume remembers.

Honor the mode: Ask prompts for edits and shell commands, Plan is read-only, Dangerous only when the friend allows it.
