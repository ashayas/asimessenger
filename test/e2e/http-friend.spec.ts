import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('add an HTTP friend from a manifest and chat with it over SSE', async () => {
  const server = createServer(async (req, res) => {
    let b = ''
    for await (const c of req) b += c
    const msg = (JSON.parse(b) as { message: string }).message
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const w of `You asked: ${msg}`.split(' ')) { res.write(`data: ${JSON.stringify({ delta: w + ' ' })}\n\n`); await new Promise((r) => setTimeout(r, 20)) }
    res.end(`data: ${JSON.stringify({ finish: 'stop' })}\n\n`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const manifest = JSON.stringify({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, send: { path: '/chat', body: { message: '{{text}}' } }, stream: 'sse', map: { text: 'delta', done: { path: 'finish', equals: 'stop' } } })
  const h = await launchApp({ seed: true })
  try {
    const addP = h.app.waitForEvent('window')
    await h.win.getByRole('button', { name: /Add a friend/ }).click()
    const add = await addP
    await add.getByLabel('Friend name').fill('Remote')
    await add.getByRole('radio', { name: 'HTTP' }).check()
    await add.getByLabel('Manifest').fill('{ not json')
    await add.getByRole('button', { name: 'Add', exact: true }).last().click()
    await expect(add.getByRole('status')).toContainText('valid JSON')
    await add.getByLabel('Manifest').fill(manifest)
    await add.getByRole('button', { name: 'Add', exact: true }).last().click()
    await expect(h.win.locator('[data-friend="Remote"]')).toHaveAttribute('data-presence', 'online')

    const chatP = h.app.waitForEvent('window')
    await h.win.locator('[data-friend="Remote"]').dblclick()
    const chat = await chatP
    await chat.getByLabel('Message').fill('hello remote')
    await chat.getByLabel('Message').press('Enter')
    await expect(chat.locator('.msg').last()).toContainText('You asked: hello remote', { timeout: 10_000 })
  } finally {
    server.close()
    await h.cleanup()
  }
})
