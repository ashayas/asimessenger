# Antigravity in ASI Messenger

Verified against installed `agy 1.3.3` on October 12, 2026.

## Register it correctly

1. Install Antigravity CLI from Google's distribution and run `agy` in Terminal once to authenticate.
2. In ASI Messenger, choose **Add a Friend → Antigravity → Add**. The executable is resolved from your login-shell PATH.
3. Use the native Antigravity preset. Do not enter `agy` under the generic ACP option. The desktop IDE launcher and Gemini CLI are different integrations.
4. Select the workspace and start a new Antigravity chat. Existing migrated Gemini transcripts remain readable; new turns use an Antigravity conversation.

The preset supplies its transport flags. For standalone diagnostics, use:

```sh
agy --version
agy models
agy --input-format stream-json --output-format stream-json
```

The final command expects newline-delimited user messages on stdin. The persistent process is the documented integration for applications that drive a CLI conversation. It supports text input, result events, resuming by conversation ID, and launch-time model selection. Its result usage counters are cumulative. Claude-style control requests and responses are explicitly unsupported. [Google's headless protocol](https://www.antigravity.google/docs/cli/headless/)

## Permission behavior

ASI maps Auto-edit to `--mode accept-edits`, Plan to `--mode plan`, and Dangerous to `--dangerously-skip-permissions`. Dangerous requires both ASI opt-ins. Ask follows Agy's CLI policy; it does not guarantee a card for every file write or command. Headless denials become ASI retry cards. That compatibility path temporarily edits shared CLI settings and is not a session-isolated approval protocol.

## Full control-plane integration

The current CLI adapter does **not** inject ASI's `ask_user`, `send_attachment`, `open_url`, `open_drawing`, or `set_status` tools. A working text conversation alone does not establish that connection.

Agy supports Streamable HTTP MCP servers, including authorization headers, via its MCP configuration. ASI's endpoint contains a chat ID and uses a per-launch token. Registering one chat's endpoint globally would give other sessions the wrong destination. A production connector needs session-scoped configuration and cleanup, rather than copying one endpoint into the global config. [Google's MCP documentation](https://www.antigravity.google/docs/mcp/)

For a control plane that owns tool approval before execution, Google's Python SDK exposes policy handlers and interactive hooks. It also accepts MCP servers in agent configuration. That should be a separate adapter: the documented SDK setup uses a Gemini API key or Vertex credentials, so it should not silently replace a user's subscription-backed CLI session. [SDK setup](https://www.antigravity.google/docs/sdk/overview/) · [Policy callbacks](https://www.antigravity.google/docs/sdk/policies/)

## Checks

- `pnpm exec vitest run test/unit/agy.test.ts test/unit/friends.test.ts`
- `ASI_LIVE=1 pnpm exec vitest run --config vitest.live.config.ts test/live/agy.live.test.ts`
- `pnpm dist:dir` builds `release/mac-arm64/ASI Messenger.app` for manual UI verification.
