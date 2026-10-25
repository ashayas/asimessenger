import { spawn } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import { RpcPeer } from '../../src/harness/acp/rpc'

const peers: RpcPeer[] = []
afterEach(() => { for (const peer of peers.splice(0)) peer.kill() })
function start(code: string) {
  const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] })
  const peer = new RpcPeer(child)
  peers.push(peer)
  return { peer, child }
}

test('kill rejects outstanding requests immediately and reports close once', async () => {
  const { peer } = start('setInterval(() => {}, 1000)')
  let closed = 0
  peer.onClose(() => closed++)
  const request = peer.request('pending')
  peer.kill()
  await expect(request).rejects.toThrow(/closed/)
  peer.kill()
  expect(closed).toBe(1)
})

test('setup timeout does not impose a timeout on ordinary turns', async () => {
  const { peer } = start('setInterval(() => {}, 1000)')
  await expect(peer.request('initialize', {}, 30)).rejects.toThrow(/timed out/)
  expect(peer.closed).toBe(false)
})

test('drains a response before reporting process close and tolerates stdout noise', async () => {
  const { peer } = start(`process.stdin.once('data', () => { process.stdout.write('null\\n42\\nnot json\\n'); process.stdout.end(JSON.stringify({id:1,result:'final'})+'\\n'); })`)
  await expect(peer.request('hello')).resolves.toBe('final')
})

test('broken stdin rejects requests instead of producing an unhandled EPIPE', async () => {
  const { peer, child } = start('setInterval(() => {}, 1000)')
  const request = peer.request('pending')
  child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
  await expect(request).rejects.toThrow(/stdin failed/)
  expect(peer.closed).toBe(true)
})
