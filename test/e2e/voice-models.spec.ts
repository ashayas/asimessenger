import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'

test('Options › Voice: download a model with progress, select it, remove it; Apple speech stays available', async () => {
  const work = mkdtempSync(join(tmpdir(), 'asi-vm-'))
  const src = join(work, 'src', 'cohere-transcribe-mlx-4bit')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'model.safetensors'), Buffer.alloc(400_000, 3))
  writeFileSync(join(src, 'LICENSE'), 'Apache-2.0')
  execFileSync('tar', ['-C', join(work, 'src'), '-cf', join(work, 'm.tar'), 'cohere-transcribe-mlx-4bit'])
  const tar = readFileSync(join(work, 'm.tar'))
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': tar.length })
    const step = Math.ceil(tar.length / 4)
    let i = 0
    const tick = () => { if (i >= tar.length) return void res.end(); res.write(tar.subarray(i, i + step)); i += step; setTimeout(tick, 350) }
    tick()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const catalog = join(work, 'catalog.json')
  writeFileSync(catalog, JSON.stringify([{ id: 'cohere-transcribe-mlx-4bit', name: 'Cohere Transcribe (MLX 4-bit)', blurb: 'test model', archive: 'm.tar', bytes: tar.length, sha256: createHash('sha256').update(tar).digest('hex'), urls: [`http://127.0.0.1:${(server.address() as AddressInfo).port}/m.tar`], recommended: true }]))

  const h = await launchApp({ env: { ASI_VOICE_MODELS_JSON: catalog, ASI_VOICE_SKIP_RUNTIME: '1' } })
  try {
    const optsP = h.app.waitForEvent('window')
    await h.win.keyboard.press('Meta+,')
    const opts = await optsP
    const voice = opts.getByTestId('voice-settings')
    const cohere = voice.locator('[data-engine="cohere-transcribe-mlx-4bit"]')
    await expect(voice).toContainText('Nothing is uploaded')
    await expect(cohere).toContainText('Needs')
    await expect(cohere).toContainText('free')
    await expect(cohere).toHaveAttribute('data-installed', 'no')
    await expect(cohere.getByLabel('Use Cohere Transcribe (MLX 4-bit)')).toBeDisabled()
    await opts.screenshot({ path: 'test-results/voice-settings.png' })

    await cohere.getByRole('button', { name: 'Download' }).click()
    await expect(cohere.getByTestId('voice-progress')).toContainText('Downloading')
    await expect(cohere).toHaveAttribute('data-installed', 'yes', { timeout: 20_000 })
    await expect(cohere).toContainText('Installed')
    // the recommended engine becomes the default once installed
    await expect(cohere.getByLabel('Use Cohere Transcribe (MLX 4-bit)')).toBeChecked()

    await voice.getByLabel('Use Apple on-device speech').click()
    await expect(voice.getByLabel('Use Apple on-device speech')).toBeChecked()

    await cohere.getByRole('button', { name: 'Remove' }).click()
    await expect(cohere).toHaveAttribute('data-installed', 'no')
  } finally {
    server.close()
    await h.cleanup()
  }
})
