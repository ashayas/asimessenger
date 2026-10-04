# Harnesses: how agents plug in

Every friend is a **harness**: something that turns "you typed a message" into a stream of normalized events
(`src/shared/events.ts`: text, thinking, tool, permission, question, attachment, links, status, turn_end). The UI only
knows those events, so a new harness never needs UI work.

| Harness | Transport | Used for |
|---|---|---|
| `claude` | `claude -p` stream-json + `--permission-prompt-tool stdio` | Claude Code |
| `codex` | `codex app-server` JSON-RPC | Codex |
| `pi` | `pi --mode rpc` (JSONL) + a bundled gate extension | Pi |
| `acp` | Agent Client Protocol over stdio | OpenCode, Gemini CLI, Hermes, anything ACP |
| `pty` | a real pseudo-terminal | any CLI with no protocol |
| `http` | manifest-driven HTTP (SSE / NDJSON / JSON) | hosted agents, e.g. Cohere North in a fork |
| `asi`, `echo`, `fake` | in-process | ASI, a smoke-test friend, tests |

All structured harnesses also get **ASI's MCP tools** (`ask_user`, `send_attachment`, `open_url`, `open_drawing`,
`set_status`) injected, so questions and attachments behave the same everywhere.

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

### Cohere North (template: confirm the field names against your instance's API reference)

North's API is `https://{instance}/api` with a Bearer token ([reference](https://private.docs.cohere.com/reference/overview)).
Start from the manifest above, point `baseUrl` at your instance, set `send.path` to your chat endpoint and map the
streamed text field. A fork can ship this as a preset in `src/shared/presets.ts` plus a test against a mock server.

## Add a protocol (code)

1. `src/harness/<name>/session.ts`: implement `AgentSession` (`send`, `interrupt`, `respond`, `setMode`, `dispose`, `subscribe`).
   Emit events; never touch the database. Keep a mock of the real thing under `test/fixtures/` for unit tests.
2. `src/harness/<name>/factory.ts`: a `HarnessFactory` that starts the process/connection from a `SessionContext`
   (`friend`, `cwd`, `mode`, `resumeId`, `mcp`).
3. Register it in `src/harness/registry.ts`.
4. Add a live contract test in `test/live/` (skipped unless `ASI_LIVE=1`): reply, Deny leaves no file, Allow writes it,
   Nudge interrupts, resume remembers.

Honor the mode: Ask prompts for edits and shell commands, Plan is read-only, Dangerous only when the friend allows it.
