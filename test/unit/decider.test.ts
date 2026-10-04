import { expect, test } from 'vitest'
import { assessRisk, clefDecider, maxRisk, parseAnswers, pickBest, type Decider } from '../../src/asi/decider'

const reply = (answers: unknown, status = 200) => (async () => new Response(JSON.stringify({ success: status === 200, result: { answers }, errors: status === 200 ? [] : [{ message: 'bad token' }] }), { status })) as unknown as typeof fetch

test('sends the documented request and parses choice + noul answers', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  const fetchImpl = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ result: { answers: { risk: { choice: 'med', probabilities: { low: 0.1, med: 0.7, high: 0.2 } }, urgent: { noul: 0.9 } } } })) }) as unknown as typeof fetch
  const d = clefDecider({ accountId: 'acc 1', token: 'tok', fetchImpl })
  const a = await d.decide('state', { risk: { type: 'choice', instructions: 'r', criteria: { low: 'l', med: 'm', high: 'h' } }, urgent: { type: 'noul', instructions: 'u' } })
  expect(seen!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc%201/ai/run/@cf/cloudflare/clef-flash')
  expect((seen!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')
  expect(JSON.parse(String(seen!.init.body))).toMatchObject({ model: 'clef-flash', state: 'state', questions: { urgent: { type: 'noul' } } })
  expect(a).toEqual({ risk: { choice: 'med', probabilities: { low: 0.1, med: 0.7, high: 0.2 } }, urgent: { value: 0.9 } })
})

test('accepts bare numbers, derives the choice from probabilities, and reports API errors', () => {
  const q = { u: { type: 'noul', instructions: '' }, c: { type: 'choice', instructions: '', criteria: { a: '', b: '' } }, s: { type: 'score', instructions: '', criteria: ['x'] } } as never
  expect(parseAnswers({ u: 0.3, c: { probabilities: { a: 0.2, b: 0.8 } }, s: { score: 4.5 } }, q)).toEqual({ u: { value: 0.3 }, c: { choice: 'b', probabilities: { a: 0.2, b: 0.8 } }, s: { value: 4.5 } })
  return expect(clefDecider({ accountId: 'a', token: 't', fetchImpl: reply({}, 401) }).decide('s', {})).rejects.toThrow('bad token')
})

test('risk: the heuristic is a floor the decider can raise but never lower', async () => {
  const says = (choice: string): Decider => ({ id: 'clef-flash', decide: async () => ({ risk: { choice } }) })
  expect(await assessRisk(says('high'), 'exec', 'ls -la')).toEqual({ risk: 'high', source: 'clef-flash' })
  expect((await assessRisk(says('low'), 'exec', 'rm -rf dist')).risk).toBe('high') // heuristic floor wins
  expect((await assessRisk(says('med'), 'exec', 'pnpm test')).risk).toBe('med')
  expect(await assessRisk(null, 'exec', 'sudo make')).toEqual({ risk: 'high', source: 'heuristic' })
  const broken: Decider = { id: 'x', decide: async () => { throw new Error('offline') } }
  expect(await assessRisk(broken, 'exec', 'git push origin main')).toEqual({ risk: 'med', source: 'heuristic' })
  expect(maxRisk('low', 'med')).toBe('med')
})

test('pickBest returns a confident match only', async () => {
  const cands = [{ id: 'c1', label: 'auth refactor' }, { id: 'c2', label: 'billing fix' }]
  const d = (choice: string, p: number): Decider => ({ id: 'd', decide: async () => ({ match: { choice, probabilities: { [choice]: p } } }) })
  expect(await pickBest(d('c2', 0.9), 'the invoice thing', cands)).toBe('c2')
  expect(await pickBest(d('c2', 0.2), 'unclear', cands)).toBeNull()
  expect(await pickBest(null, 'x', cands)).toBeNull()
  expect(await pickBest(null, 'x', [cands[0]!])).toBe('c1')
  expect(await pickBest(d('c1', 1), 'x', [])).toBeNull()
})
