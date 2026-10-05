import type { Page } from '@playwright/test'

/**
 * A believable day of work: five repos, a dozen-plus chats, several agents, every kind of status.
 * Used by the README screenshots so they show what the app looks like at scale, not with three friends.
 */
export async function buildScene(win: Page, homePath: string): Promise<{ c1: string; c2: string; att: string; ws: string; homeChats: string[] }> {
  return win.evaluate(async (path) => {
    const api = window.asi.api
    await api.settings.set('profile', { name: 'Ashaya', personalMessage: '<shipping asi messenger>', presence: 'online' })
    const home = (await api.workspaces.list())[0]!
    await api.workspaces.setPath(home.id, path)
    await api.workspaces.rename(home.id, 'honeycomb')
    const fantasy = await api.workspaces.create({ name: 'fantasy', path: '/tmp/fantasy' })
    const ghostty = await api.workspaces.create({ name: 'ghostty+', path: '/tmp/ghostty' })
    const rent = await api.workspaces.create({ name: 'rentahuman', path: '/tmp/rentahuman' })
    const siift = await api.workspaces.create({ name: 'siift', path: '/tmp/siift' })

    const mk = (harness: 'claude' | 'codex' | 'acp', displayName: string, avatar: string, extra: Record<string, unknown> = {}) => api.friends.create({ harness, displayName, avatar, command: avatar, ...extra })
    const claude = await mk('claude', 'Claude Code', 'claude')
    const codex = await mk('codex', 'Codex', 'codex')
    const oc = await mk('acp', 'OpenCode', 'opencode', { transport: 'opencode' })
    const gemini = await api.friends.create({ harness: 'acp', displayName: 'Gemini CLI', avatar: 'gemini', command: 'gemini', transport: 'gemini' })
    await api.friends.create({ harness: 'pi', displayName: 'Pi', avatar: 'pi', command: 'pi' })

    const chat = async (ws: string, friend: string, title: string, status: 'busy' | 'away' | 'online', text: string | null, unread = 0, mode?: 'dangerous') => {
      const c = await api.chats.create({ workspaceId: ws, friendId: friend, title })
      await api.chats.setStatus(c.id, status, text)
      if (mode) await api.chats.setMode(c.id, mode)
      for (let i = 0; i < unread; i++) await api.messages.append({ chatId: c.id, role: 'agent', kind: 'text', body: { text: 'ping' }, text: 'ping' })
      return c
    }

    // honeycomb: the busy repo, five Claude Codes at once
    const c1 = await chat(home.id, claude.id, 'auth refactor', 'away', '(⊙_⊙) waiting on u: rm -rf dist')
    const homeChats = [c1.id]
    homeChats.push((await chat(home.id, claude.id, 'flaky session test', 'busy', '✧ ʀᴜɴɴɪɴɢ ᴛᴇsᴛs ✧ session.test.ts')).id)
    homeChats.push((await chat(home.id, claude.id, 'migrate to vite 7', 'busy', '~*~ editing vite.config.ts ~*~')).id)
    homeChats.push((await chat(home.id, claude.id, 'docs pass', 'online', 'all done ★', 2)).id)
    homeChats.push((await chat(home.id, claude.id, 'rate limiting', 'online', null, 0, 'dangerous')).id)
    const c2 = await chat(home.id, codex.id, 'build fix', 'busy', '~*~ fixing the build ~*~')
    homeChats.push(c2.id)
    homeChats.push((await chat(home.id, oc.id, 'api routes', 'busy', '~*~ editing api/routes.ts ~*~')).id)

    // the other repos
    await chat(fantasy.id, claude.id, 'chapter 3 outline', 'online', 'all done ★')
    await chat(fantasy.id, claude.id, 'character bible', 'busy', '~*~ writing characters.md ~*~')
    await chat(fantasy.id, codex.id, 'fix epub export', 'online', 'all done ★', 1)
    await chat(ghostty.id, claude.id, 'fix tab drag', 'away', '(⊙_⊙) waiting on u: Edit Tab.swift')
    await chat(ghostty.id, gemini.id, 'review PR 214', 'online', null)
    await chat(rent.id, claude.id, 'stripe webhook retries', 'busy', '✧ ʀᴜɴɴɪɴɢ ᴛᴇsᴛs ✧ webhooks.test.ts')
    await chat(rent.id, codex.id, 'migration dry run', 'away', '(⊙_⊙) waiting on u: psql -f 0042.sql', 1)
    await chat(rent.id, oc.id, 'seed data', 'online', 'all done ★')
    await chat(siift.id, claude.id, 'onboarding copy', 'online', null)
    await chat(siift.id, codex.id, 'lint cleanup', 'busy', '~*~ fixing 38 lint errors ~*~')

    const lab = await api.labels.create('infra', '#6b3fa0'); await api.labels.setForChat(c1.id, [lab.id])
    const ap = (chatId: string, role: 'user' | 'agent', kind: string, body: unknown, text: string) => api.messages.append({ chatId, role, kind, body, text })
    await ap(c1.id, 'user', 'text', { text: 'the session refresh test is flaky. find out why and fix it' }, 'the session refresh test is flaky. find out why and fix it')
    await ap(c1.id, 'agent', 'text', { text: 'Reproducing first, then I will look at the refresh path.' }, 'Reproducing first, then I will look at the refresh path.')
    await ap(c1.id, 'agent', 'tool', { t: 'tool', id: 't1', kind: 'exec', title: 'Run tests', command: 'pnpm vitest run src/auth/session.test.ts', output: '✗ refreshes once under concurrent calls\n  expected 1, got 2\n  1 failed | 23 passed', exit: 1, durationMs: 2400, done: true }, 'pnpm vitest run')
    await ap(c1.id, 'agent', 'attachment', { t: 'attachment', id: 'a1', kind: 'markdown', name: 'refresh-race.md', body: '# Root cause\n\nTwo tabs call `refresh()` at once; the lock is per tab, so both win.\n\n```ts\nawait navigator.locks.request("refresh", () => doRefresh())\n```\n\n- Use a **global** lock (BroadcastChannel)\n- Add a regression test\n' }, 'refresh-race.md')
    await ap(c1.id, 'agent', 'permission', { t: 'permission', reqId: 'p1', tool: 'Edit', summary: 'src/auth/session.ts', risk: 'low', options: [{ id: 'allow-once', label: 'Allow once' }, { id: 'allow-chat', label: 'Allow for this chat' }, { id: 'deny', label: 'Deny' }], decision: null }, 'Edit src/auth/session.ts')
    await ap(c1.id, 'agent', 'question', { t: 'question', reqId: 'q1', prompt: 'Should the refresh lock be per tab or global (BroadcastChannel)?', choices: ['Per tab', 'Global'], answer: null }, 'lock question')
    await api.chats.markRead(c1.id)
    const att = (await api.messages.list(c1.id)).find((m) => m.kind === 'attachment')!.id
    return { c1: c1.id, c2: c2.id, att, ws: home.id, homeChats }
  }, homePath)
}
