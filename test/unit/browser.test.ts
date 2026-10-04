import { expect, test } from 'vitest'
import { findLocalUrls, isAllowedNavigation, normalizeUrl } from '../../src/shared/browser'

test.each([
  ['https://example.com/a?b=1', 'https://example.com/a?b=1'],
  ['localhost:5173', 'http://localhost:5173'],
  ['127.0.0.1:3000/x', 'http://127.0.0.1:3000/x'],
  ['example.com', 'https://example.com'],
  ['docs.rs/serde:80/x', 'https://docs.rs/serde:80/x'],
  ['how do i center a div', 'https://duckduckgo.com/?q=how%20do%20i%20center%20a%20div'],
  ['', 'about:blank']
])('normalizeUrl(%j)', (input, expected) => expect(normalizeUrl(input)).toBe(expected))

test('only http(s) and about:blank may be navigated to', () => {
  for (const ok of ['http://localhost:3000', 'https://a.dev', 'about:blank']) expect(isAllowedNavigation(ok)).toBe(true)
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://gpu', 'data:text/html,hi', 'ftp://x', 'nonsense']) expect(isAllowedNavigation(bad)).toBe(false)
})

test('local dev-server links are found in agent text', () => {
  expect(findLocalUrls('Dev server is up at http://localhost:5173/. Also see http://127.0.0.1:3000/api/health, and https://example.com.')).toEqual(['http://localhost:5173/', 'http://127.0.0.1:3000/api/health'])
  expect(findLocalUrls('no links here')).toEqual([])
  expect(findLocalUrls('http://localhost:5173 and http://localhost:5173')).toHaveLength(1)
})
