import { describe, expect, test } from 'vitest'
import { assessRisk, clefDecider, extractJson, llmDecider, maxRisk, parseAnswers, pickBest, systemOneDecider, type Decider, type Questions } from '../../src/asi/decider'

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

describe('any decision model', () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  const q: Questions = { risk: { type: 'choice', instructions: 'risk?', criteria: { low: 'safe', high: 'bad' } }, ok: { type: 'noul', instructions: 'ok?' } }

  test('Jev speaks the systemone shape: POST /v1/systemone with a bearer key', async () => {
    let seen: { url: string; auth: string | null; body: unknown } | null = null
    const f = (async (url: string, init: RequestInit) => { seen = { url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) }; return new Response(JSON.stringify({ answers: { risk: { type: 'choice', choice: 'high', probabilities: { low: 0.1, high: 0.9 } }, ok: { type: 'noul', noul: 0.7 } } })) }) as unknown as typeof fetch
    const d = systemOneDecider({ baseUrl: 'https://openrouter.ai/api/', model: 'typesafe/jev-1.13', token: 'k', fetchImpl: f })
    const a = await d.decide('state', q)
    expect(seen).toMatchObject({ url: 'https://openrouter.ai/api/v1/systemone', auth: 'Bearer k', body: { state: 'state', model: 'typesafe/jev-1.13', questions: q } })
    expect(a).toEqual({ risk: { choice: 'high', probabilities: { low: 0.1, high: 0.9 } }, ok: { value: 0.7 } })
    expect(d.id).toBe('typesafe/jev-1.13')
  })

  test('a score answer given as a distribution over levels becomes its mean level', () => {
    expect(parseAnswers({ s: { probabilities: { '1': 0.5, '3': 0.5 } } }, { s: { type: 'score', instructions: '', criteria: ['a'] } })).toMatchObject({ s: { value: 2 } })
  })

  test('errors from the endpoint surface their message', async () => {
    await expect(systemOneDecider({ baseUrl: 'https://x.test', model: 'm', fetchImpl: reply({ error: { message: 'bad key' } }, 401) }).decide('s', q)).rejects.toThrow('bad key')
    await expect(systemOneDecider({ baseUrl: 'https://x.test', model: 'm', fetchImpl: reply({}, 200) }).decide('s', q)).rejects.toThrow(/no answers/)
  })

  test('a plain chat model works as a decision model: JSON is extracted, clamped and normalized', async () => {
    let seen: { url: string; auth: string | null; body: { messages: { content: string }[] } } | null = null
    const chat = (content: string) => (async (url: string, init: RequestInit) => { seen = { url, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) }; return new Response(JSON.stringify({ choices: [{ message: { content } }] })) }) as unknown as typeof fetch
    const d = llmDecider({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', fetchImpl: chat('Sure!\n```json\n{"answers":{"risk":{"probabilities":{"low":2,"high":6,"bogus":9}},"ok":{"noul":1.4}}}\n```') })
    const a = await d.decide('rm -rf dist', q)
    expect(seen!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(seen!.auth).toBeNull() // a local server needs no key
    expect(JSON.parse(seen!.body.messages[1]!.content)).toEqual({ state: 'rm -rf dist', questions: q })
    expect(a['risk']!.choice).toBe('high')
    expect(a['risk']!.probabilities!['high']).toBeCloseTo(0.75)
    expect(a['risk']!.probabilities).not.toHaveProperty('bogus')
    expect(a['ok']).toEqual({ value: 1 })
  })

  test('a chat model that rambles or answers nothing is an error, never a guess', async () => {
    const chat = (content: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as unknown as typeof fetch
    await expect(llmDecider({ baseUrl: 'http://localhost:1', model: 'm', fetchImpl: chat('I cannot do that') }).decide('s', q)).rejects.toThrow(/JSON/)
    await expect(llmDecider({ baseUrl: 'http://localhost:1', model: 'm', fetchImpl: chat('{"answers":{}}') }).decide('s', q)).rejects.toThrow(/did not answer/)
    expect(extractJson('{"a":1} trailing')).toEqual({ a: 1 })
  })
})
