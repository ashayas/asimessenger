import { expect, test } from 'vitest'
import { resumeCommand } from '../../src/shared/resume'

const f = (over: Record<string, unknown>) => ({ harness: 'claude', transport: null, command: null, avatar: null, ...over }) as never

test('claude and codex resume by session id inside the workspace', () => {
  expect(resumeCommand(f({}), { harnessSessionId: 'abc-1' }, '/code/hc')).toBe("cd '/code/hc' && claude --resume 'abc-1'")
  expect(resumeCommand(f({ harness: 'codex', command: '/usr/local/bin/codex' }), { harnessSessionId: 't1' }, '/code/hc')).toBe("cd '/code/hc' && '/usr/local/bin/codex' resume 't1'")
  expect(resumeCommand(f({}), { harnessSessionId: null }, '/code/hc')).toBe("cd '/code/hc' && claude")
})

test('opencode via ACP uses --session; unknown harnesses return null', () => {
  expect(resumeCommand(f({ harness: 'acp', transport: 'opencode' }), { harnessSessionId: 'ses_1' }, '/x')).toBe("cd '/x' && opencode --session 'ses_1'")
  expect(resumeCommand(f({ harness: 'acp', transport: 'gemini' }), { harnessSessionId: 's' }, '/x')).toBeNull()
  expect(resumeCommand(f({ harness: 'echo' }), { harnessSessionId: null }, '/x')).toBeNull()
})

test('paths and ids with quotes cannot break out of the command', () => {
  const cmd = resumeCommand(f({}), { harnessSessionId: "x'; rm -rf ~; '" }, "/tmp/it's here")!
  expect(cmd).toBe(`cd '/tmp/it'\\''s here' && claude --resume 'x'\\''; rm -rf ~; '\\'''`)
})
