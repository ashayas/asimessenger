import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { acpFactory } from '../../src/harness/acp/factory'
import { OPENCODE } from '../../src/harness/acp/presets'
import { claudeFactory } from '../../src/harness/claude/factory'
import { codexFactory } from '../../src/harness/codex/factory'
import { loginEnv, which } from '../../src/harness/env'
import { configurePi, piFactory } from '../../src/harness/pi/factory'
import type { HarnessFactory } from '../../src/harness/types'
import type { AgentEvent, AgentSession } from '../../src/shared/events'
import { collect, friendFor } from '../unit/helpers'
import { makeTestWorkspace } from './workspace'

// Sends a solid red picture and asks for its colour: proves the pixels (or at least the file) reach the model.
const live = !!process.env['ASI_LIVE']
let ws: ReturnType<typeof makeTestWorkspace>
let png = ''
let session: AgentSession | null = null
beforeAll(() => {
  ws = makeTestWorkspace()
  png = join(ws.dir, 'red.png')
  // 8x8 solid red PNG, written with python so no image tooling is assumed
  execFileSync('python3', ['-c', `
import zlib,struct,sys
w=h=8
raw=b''.join(b'\\x00'+b'\\xff\\x00\\x00'*w for _ in range(h))
def ch(t,d): c=struct.pack('>I',len(d))+t+d; return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
open(sys.argv[1],'wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+ch(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw))+ch(b'IEND',b''))`, png])
  configurePi({ extensionPath: resolve('native/pi/asi-extension.js') })
})
afterAll(() => ws?.cleanup())
afterEach(async () => { await session?.dispose(); session = null })

const text = (events: AgentEvent[]) => events.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')

async function ask(factory: HarnessFactory, friendOver: Record<string, unknown>) {
  session = await factory({ friend: friendFor(friendOver) as never, chatId: 'c', cwd: ws.dir, mode: 'ask' })
  const c = collect(session)
  session.send({ text: 'What colour is the attached picture? Answer with one word.', images: [{ path: png, mimeType: 'image/png', name: 'red.png' }] })
  // reading the file by path is fine; allow anything that is not a write
  for (let i = 0; i < 120 && !c.events.some((e) => e.t === 'turn_end'); i++) {
    for (const e of c.events) if (e.t === 'permission' && !(e as { seen?: boolean }).seen) { (e as { seen?: boolean }).seen = true; session.respond(e.reqId, 'allow-once') }
    await new Promise((r) => setTimeout(r, 1000))
  }
  await c.until((e) => e.t === 'turn_end', 60_000)
  return text(c.events).toLowerCase()
}

describe.skipIf(!live)('pictures reach real agents', async () => {
  const env = await loginEnv()
  test.skipIf(!which('claude', env))('claude', async () => { expect(await ask(claudeFactory, { harness: 'claude', args: ['--model', 'haiku'] })).toContain('red') }, 180_000)
  test.skipIf(!which('pi', env))('pi', async () => { expect(await ask(piFactory, { harness: 'pi', args: ['--provider', 'openrouter', '--model', 'anthropic/claude-haiku-4.5'] })).toContain('red') }, 180_000)
  test.skipIf(!which('codex', env))('codex', async () => { expect(await ask(codexFactory, { harness: 'codex' })).toContain('red') }, 180_000)
  // OpenCode's default model may be text-only; then the honest answer is that it cannot see images
  test.skipIf(!which('opencode', env))('opencode', async () => { expect(await ask(acpFactory(OPENCODE), {})).toMatch(/red|image input|can't read images/) }, 180_000)
})
