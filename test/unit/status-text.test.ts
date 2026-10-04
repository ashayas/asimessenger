import { expect, test } from 'vitest'
import { describeCommand, smallCaps, statusLine, statusPlain } from '../../src/shared/status-text'

test.each([
  ['pnpm vitest run src/a.test.ts', 'running tests'], ['cargo test', 'running tests'], ['npm install left-pad', 'installing'],
  ['pnpm build', 'building'], ['eslint .', 'linting'], ['git push origin main', 'git push'], ['ls -la', 'running ls']
])('describeCommand(%s) = %s', (cmd, expected) => expect(describeCommand(cmd)).toBe(expected))

test('small caps keeps non-letters', () => expect(smallCaps('running tests')).toBe('ʀᴜɴɴɪɴɢ ᴛᴇsᴛs'))

test('funky lines follow the plan table', () => {
  expect(statusLine({ phase: 'thinking' })).toBe('.｡o○ thinking…')
  expect(statusLine({ phase: 'tool', kind: 'exec', detail: 'pnpm vitest run session.test.ts' })).toBe('✧ ʀᴜɴɴɪɴɢ ᴛᴇsᴛs ✧ pnpm vitest run session.test.ts')
  expect(statusLine({ phase: 'tool', kind: 'edit', detail: 'api/routes.ts' })).toBe('~*~ editing api/routes.ts ~*~')
  expect(statusLine({ phase: 'tool', kind: 'read', detail: '14 files' })).toBe('🔍 ʀᴇᴀᴅɪɴɢ 14 ꜰɪʟᴇs')
  expect(statusLine({ phase: 'waiting', detail: 'rm -rf dist' })).toBe('(⊙_⊙) waiting on u: rm -rf dist')
  expect(statusLine({ phase: 'waiting', detail: 'question' })).toBe('❓ has a question 4 u')
  expect(statusLine({ phase: 'done' })).toBe('★彡 done 彡★')
  expect(statusLine({ phase: 'error', detail: 'process exited' })).toBe('x_x crashed: process exited')
  expect(statusLine({ phase: 'stopped' })).toBe('✋ stopped')
})

test('plain lettering carries the same information without decoration', () => {
  for (const i of [
    { phase: 'thinking' as const }, { phase: 'tool' as const, kind: 'exec' as const, detail: 'pnpm test' },
    { phase: 'waiting' as const, detail: 'rm -rf dist' }, { phase: 'done' as const }, { phase: 'stopped' as const }
  ]) {
    expect(statusLine(i, 'plain')).toBe(statusPlain(i))
    expect(statusLine(i, 'plain')).not.toMatch(/[✧★彡⊙✋~*]/)
  }
  expect(statusPlain({ phase: 'waiting', detail: 'rm -rf dist' })).toBe('waiting on you: rm -rf dist')
})

test('long details are shortened', () => {
  expect(statusPlain({ phase: 'tool', kind: 'edit', detail: 'a'.repeat(200) }).length).toBeLessThan(60)
})
