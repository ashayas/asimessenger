import { expect, test } from 'vitest'
import { openDb } from '../../src/main/db/db'
import { createRepo } from '../../src/main/db/repo'
import { REPO_METHODS } from '../../src/shared/api'

test('REPO_METHODS matches the repo exactly', async () => {
  const repo = createRepo(await openDb(':memory:'))
  const actual = Object.fromEntries(Object.entries(repo).map(([g, m]) => [g, Object.keys(m).sort()]))
  const declared = Object.fromEntries(Object.entries(REPO_METHODS).map(([g, m]) => [g, [...m].sort()]))
  expect(declared).toEqual(actual)
})
