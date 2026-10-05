import { describe, expect, test } from 'vitest'
import { clefDecider, llmDecider, llmTitle, systemOneDecider, type Questions } from '../../src/asi/decider'
import { redactDeep, redactSecrets } from '../../src/shared/redact'

const OR = 'sk-or-v1-' + 'a1b2c3d4e5f6'.repeat(5)
const ANT = 'sk-ant-api03-' + 'Zy9x8w7v6u5t'.repeat(4)
const GH = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2)
const AWS = 'AKIAIOSFODNN7EXAMPLE'

describe('secret redaction', () => {
  test.each([
    ['an OpenRouter key', `curl -H "x-key: ${OR}" https://x`, OR, 'openrouter-key'],
    ['an Anthropic key', `export K=${ANT}`, ANT, 'anthropic-key'],
    ['a GitHub token', `git clone https://${GH}@github.com/a/b`, GH, 'github-token'],
    ['an AWS access key id', `aws configure set id ${AWS}`, AWS, 'aws-access-key'],
    ['a bearer token', 'curl -H "Authorization: Bearer abcdefghijklmnop1234567890" https://x', 'abcdefghijklmnop1234567890', 'bearer-token'],
    ['a JWT', 'token is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'eyJhbGciOiJIUzI1NiJ9', 'jwt'],
    ['credentials in a URL', 'postgres://admin:hunter2pass@db.internal:5432/app', 'hunter2pass', 'url-credentials'],
    ['a named secret assignment', 'DATABASE_PASSWORD=correct-horse-battery', 'correct-horse-battery', 'secret-assignment'],
    ['a quoted secret in JSON', '{"apiKey": "9f8e7d6c5b4a"}', '9f8e7d6c5b4a', 'secret-assignment'],
    ['a secret flag', 'mysql -u root --password hunter2pass -h x', 'hunter2pass', 'secret-flag']
  ])('masks %s and keeps the surrounding text', (_n, input, secret, kind) => {
    const r = redactSecrets(input)
    expect(r.text).not.toContain(secret)
    expect(r.text).toContain(`[REDACTED:${kind}]`)
    expect(r.kinds).toContain(kind)
    expect(r.count).toBeGreaterThan(0)
  })

  test('masks a whole private key block', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----'
    const r = redactSecrets(`cat id_rsa\n${key}\ndone`)
    expect(r.text).toBe('cat id_rsa\n[REDACTED:private-key]\ndone')
  })

  test('keeps the name of an assignment so the sentence still makes sense', () => {
    expect(redactSecrets('STRIPE_SECRET_KEY=sk_live_abcdefghijklmnop1234').text).toBe('STRIPE_SECRET_KEY=[REDACTED:stripe-key]')
    expect(redactSecrets('API_TOKEN=abcdef123456').text).toBe('API_TOKEN=[REDACTED:secret-assignment]')
  })

  test('ordinary text, hashes, uuids and short values pass through untouched', () => {
    for (const t of [
      'rm -rf dist && pnpm build',
      'fix the token refresh test in src/auth/session.ts',
      'commit 3f786850e387550fdab836ed7e6dc881de23001b',
      'chat 123e4567-e89b-12d3-a456-426614174000',
      'the key insight is that keys are unique; set key=1',
      'password reset email copy',
      'git push origin asi/amber-otter',
      'sk-learn is a library'
    ]) expect(redactSecrets(t)).toEqual({ text: t, count: 0, kinds: [] })
  })

  test('an already masked value is not masked twice', () => {
    const r = redactSecrets(`OPENAI_API_KEY=${OR}`)
    expect(r.text).toBe('OPENAI_API_KEY=[REDACTED:openrouter-key]')
    expect(r.count).toBe(1)
  })

  test('redactDeep masks every string and keeps keys, numbers and shape', () => {
    const out = redactDeep({ a: `token ${GH}`, n: 3, nested: [{ s: `K=${ANT}` }], [`key-${AWS}`]: 'x' })
    expect(JSON.stringify(out)).not.toContain(GH)
    expect(JSON.stringify(out)).not.toContain(ANT)
    expect(out.n).toBe(3)
    expect(Object.keys(out)).toContain(`key-${AWS}`) // keys are structure, not content
  })
})

describe('nothing secret reaches a model', () => {
  const q: Questions = { risk: { type: 'choice', instructions: 'risk?', criteria: { low: 'safe', high: `touches ${OR}` } } }
  const capture = () => {
    const bodies: string[] = []
    const f = (async (_u: string, init: RequestInit) => { bodies.push(String(init.body)); return new Response(JSON.stringify({ result: { answers: { risk: { choice: 'low', probabilities: { low: 1 } } } }, answers: { risk: { type: 'choice', choice: 'low', probabilities: { low: 1 } } }, choices: [{ message: { content: '{"answers":{"risk":{"probabilities":{"low":1}}}}' } }] })) }) as unknown as typeof fetch
    return { bodies, f }
  }
  const state = `A coding agent asks permission to use "Bash": curl -H "Authorization: Bearer ${'t'.repeat(30)}" -d password=${'p'.repeat(12)} ${OR}`

  test('Clef, Jev and a chat model all get the masked text', async () => {
    for (const make of [
      (f: typeof fetch) => clefDecider({ accountId: 'a', token: 't', fetchImpl: f }),
      (f: typeof fetch) => systemOneDecider({ baseUrl: 'https://x.test', model: 'm', fetchImpl: f }),
      (f: typeof fetch) => llmDecider({ baseUrl: 'https://x.test/v1', model: 'm', fetchImpl: f })
    ]) {
      const { bodies, f } = capture()
      await make(f).decide(state, q)
      const sent = bodies.join('\n')
      expect(sent).not.toContain(OR)
      expect(sent).not.toContain('t'.repeat(30))
      expect(sent).not.toContain('p'.repeat(12))
      expect(sent).toContain('REDACTED')
      expect(sent).toContain('Bash') // the useful part still arrives
    }
  })

  test('chat titles are written from masked text', async () => {
    const { bodies, f } = capture()
    await llmTitle({ baseUrl: 'https://x.test/v1', model: 'm', fetchImpl: f }, `deploy with key ${OR} please`, `using ${GH}`)
    expect(bodies[0]).not.toContain(OR)
    expect(bodies[0]).not.toContain(GH)
  })
})
