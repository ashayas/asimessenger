import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb } from '../../src/main/db/db'
import { createRepo } from '../../src/main/db/repo'
import { HarnessManager } from '../../src/harness/manager'
import { createIngestor } from '../../src/main/ingest'
import { createChatService } from '../../src/main/chat-service'
import { createMcpBridge } from '../../src/main/mcp-bridge'
import type { AgentEvent, AgentSession, UserTurn } from '../../src/shared/events'

function makeFakeSession(
  agentReply: (turn: UserTurn, emit: (e: AgentEvent) => void) => void
): { session: AgentSession; received: UserTurn[] } {
  const subs = new Set<(e: AgentEvent) => void>()
  const received: UserTurn[] = []
  const emit = (e: AgentEvent) => {
    for (const fn of subs) fn(e)
  }
  let isClosed = false
  const session: AgentSession = {
    resumeId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    get closed() {
      return isClosed
    },
    busy: false,
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    send(turn) {
      received.push(turn)
      agentReply(turn, emit)
    },
    async interrupt() {
      emit({ t: 'turn_end', reason: 'interrupted' })
    },
    respond() {},
    setMode() {},
    async dispose() {
      isClosed = true
    }
  }
  return { session, received }
}

describe('multi-agent invite & shared append-only session board', () => {
  it('supports inviting multiple Claude agents and mixed harnesses, writes a grep-searchable board file, and coordinates turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asi-board-'))
    try {
      const db = await openDb(':memory:')
      const repo = createRepo(db)
      const ws = await repo.workspaces.create({ name: 'collab-ws', path: dir })

      const claudeFriend = await repo.friends.create({
        harness: 'claude',
        displayName: 'Claude Code',
        defaultMode: 'ask'
      })
      const codexFriend = await repo.friends.create({
        harness: 'codex',
        displayName: 'Codex',
        defaultMode: 'ask'
      })

      const chat = await repo.chats.create({
        workspaceId: ws.id,
        friendId: claudeFriend.id,
        title: 'Auth Refactor'
      })

      const receivedByResume: UserTurn[] = []
      const chatRef: { current: ReturnType<typeof createChatService> | null } = { current: null }

      const ingestor = createIngestor(
        repo,
        () => {},
        () => {},
        undefined,
        (cId, reason, participant, turnText) => {
          void chatRef.current?.onTurnEnd(cId, reason, participant, turnText)
        }
      )

      const bridge = createMcpBridge({
        chatExists: async (id) => !!(await repo.chats.get(id)),
        askUser: async () => 'yes',
        sendAttachment: async () => {},
        openUrl: async () => {},
        openDrawing: async () => {},
        setStatus: async () => {},
        appendBoard: (id, participantId, entry) => chatRef.current!.appendBoard(id, participantId, entry),
        readBoard: (id, filter) => chatRef.current!.readBoard(id, filter)
      })
      await bridge.start()

      const manager = new HarnessManager({
        mcpFor: (cId, pId) => bridge.endpointFor(cId, pId),
        onEvent: (cId, e, participant) => void ingestor.ingest(cId, e, participant),
        onResumeId: (cId, id, participant) =>
          void (participant ? repo.participants.setSession(participant.id, id) : repo.chats.setSession(cId, id))
      })

      manager.register('claude', async ({ mcp }) => {
        const { session } = makeFakeSession((turn, emit) => {
          receivedByResume.push(turn)
          const match = /YOUR AGENT ID:\s*([a-z0-9-]+)/i.exec(turn.text)
          const agentId = match?.[1] ?? 'claude'
          emit({ t: 'text', id: 'm1', delta: `Response from ${agentId} (mcp=${mcp?.url.split('/').pop()})` })
          emit({ t: 'turn_end', reason: 'done' })
        })
        return session
      })

      manager.register('codex', async () => {
        const { session } = makeFakeSession((turn, emit) => {
          receivedByResume.push(turn)
          emit({ t: 'text', id: 'm1', delta: 'Codex verified test suite passes' })
          emit({ t: 'turn_end', reason: 'done' })
        })
        return session
      })

      const service = createChatService({ repo, manager, ingestor, notify: () => {} })
      chatRef.current = service

      // 1. Set the overall goal at the top of the session board
      const boardPath = await service.setGoal(
        chat.id,
        'Refactor session token validation and add unit tests without breaking API compatibility'
      )
      expect(boardPath).toBe(join(dir, '.boards', `${chat.id}.log`))

      // 2. Invite a SECOND Claude agent (same Friend/model type) and a Codex agent (different model type)
      const claude2 = await service.inviteParticipant(chat.id, claudeFriend.id, 'Security auditor')
      const codex1 = await service.inviteParticipant(chat.id, codexFriend.id, 'Test writer')

      const participants = await repo.participants.list(chat.id)
      expect(participants.map((p) => p.agentId)).toEqual(['claude-1', 'claude-2', 'codex-1'])
      expect(participants.map((p) => p.displayName)).toEqual([
        'Claude Code',
        'Claude Code #2',
        'Codex'
      ])
      expect(claude2.agentId).toBe('claude-2')
      expect(codex1.agentId).toBe('codex-1')

      // 3. Agent 2 appends a FINDING via MCP board_append (scoped to claude2.id)
      const ep2 = bridge.endpointFor(chat.id, claude2.id)
      const resAppend = await fetch(ep2.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ep2.token}`
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'board_append',
            arguments: {
              type: 'FINDING',
              summary: 'Token expiry check in auth.ts is missing clock-skew tolerance',
              detail: 'File: src/auth.ts:42\nSuggested tolerance: 30s'
            }
          }
        })
      })
      expect(resAppend.status).toBe(200)

      // 4. Send a collaborative prompt to all agents in the thread
      await service.send(chat.id, 'Please review the findings on the board and propose your changes.')
      await ingestor.idle(chat.id)
      await new Promise((r) => setTimeout(r, 30))

      expect(receivedByResume.length).toBe(3)
      // Every agent received the shared board path, overall goal, peer roster, and recent finding
      for (const turn of receivedByResume) {
        expect(turn.text).toContain('Refactor session token validation')
        expect(turn.text).toContain(boardPath)
        expect(turn.text).toContain('claude-1')
        expect(turn.text).toContain('claude-2')
        expect(turn.text).toContain('codex-1')
        expect(turn.text).toContain('Token expiry check in auth.ts')
      }

      // 5. Verify speaker attribution on persisted chat messages
      const messages = await repo.messages.list(chat.id)
      const agentMsgs = messages.filter((m) => m.role === 'agent' && m.kind === 'text')
      expect(agentMsgs.length).toBe(3)
      const speakers = agentMsgs.map(
        (m) => (m.body as { speaker?: { speakerName?: string } }).speaker?.speakerName
      )
      expect(speakers).toEqual(
        expect.arrayContaining([
          'Claude Code [claude-1]',
          'Claude Code #2 [claude-2]',
          'Codex [codex-1]'
        ])
      )

      // 6. Verify the on-disk `.boards/<chatId>.log` file is intelligently searchable via system `grep`
      const logContent = readFileSync(boardPath, 'utf8')
      expect(logContent).toContain('# [GOAL]')
      expect(logContent).toContain('# GOAL: Refactor session token validation')
      expect(logContent).toContain('# [AGENTS]')

      const grepGoal = execFileSync('grep', ['^# GOAL:', boardPath], { encoding: 'utf8' })
      expect(grepGoal).toContain('Refactor session token validation')

      const grepRoster = execFileSync('grep', ['^# AGENT_ROSTER:', boardPath], { encoding: 'utf8' })
      expect(grepRoster).toContain('agent_id=claude-1')
      expect(grepRoster).toContain('agent_id=claude-2')
      expect(grepRoster).toContain('agent_id=codex-1')

      const grepClaude2 = execFileSync('grep', ['AGENT=claude-2', boardPath], { encoding: 'utf8' })
      expect(grepClaude2).toContain('TYPE=FINDING')
      expect(grepClaude2).toContain('DETAIL:AGENT=claude-2')
      expect(grepClaude2).toContain('File: src/auth.ts:42')
      expect(grepClaude2).toContain('TYPE=TURN')

      // 7. Test @agent-id mention targeting (only @codex-1 should run)
      receivedByResume.length = 0
      await service.send(chat.id, '@codex-1 please run the unit test suite only')
      await ingestor.idle(chat.id)
      expect(receivedByResume.length).toBe(1)
      expect(receivedByResume[0]!.text).toContain('YOUR AGENT ID: codex-1')

      // 8. Test append-only tamper recovery + raw CLI append harvesting
      writeFileSync(
        boardPath,
        logContent + '\nAGENT=claude-1 | TYPE=DONE | Completed clock-skew fix in src/auth.ts\n',
        'utf8'
      )
      const readResult = await service.readBoard(chat.id, { grep: 'clock-skew' })
      expect(readResult).toContain('AGENT=claude-1')
      expect(readResult).toContain('TYPE=DONE')
      expect(readResult).toContain('Completed clock-skew fix in src/auth.ts')

      await bridge.stop()
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
