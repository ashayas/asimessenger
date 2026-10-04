# Harnesses: how agents plug in

Every friend is a **harness**: something that turns "you typed a message" into a stream of normalized events
(`src/shared/events.ts`: text, thinking, tool, permission, question, attachment, links, status, turn_end). The UI only
knows those events, so a new harness never needs UI work.

| Harness | Transport | Used for |
|---|---|---|
| `claude` | `claude -p` stream-json + `--permission-prompt-tool stdio` | Claude Code |
| `codex` | `codex app-server` JSON-RPC | Codex |
| `acp` | Agent Client Protocol over stdio | OpenCode, Gemini CLI, Hermes, Pi adapters, anything ACP |
| `pty` | a real pseudo-terminal | any CLI with no protocol |
| `http` | manifest-driven HTTP (SSE / NDJSON / JSON) | hosted agents, e.g. Cohere North in a fork |
| `asi`, `echo`, `fake` | in-process | ASI, a smoke-test friend, tests |

All structured harnesses also get **ASI's MCP tools** (`ask_user`, `send_attachment`, `open_url`, `open_drawing`,
`set_status`) injected, so questions and attachments behave the same everywhere.

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
