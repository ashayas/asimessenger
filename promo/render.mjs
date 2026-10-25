import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FPS = 60
const DURATION = 14.0
const TOTAL_FRAMES = Math.round(FPS * DURATION)
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'

const args = process.argv.slice(2)
const keyframesOnly = args.includes('--keyframes')

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(CHROME_PATH) ? { executablePath: CHROME_PATH } : {})
  })
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  })
  const page = await context.newPage()
  const htmlUrl = 'file://' + path.join(__dirname, 'index.html')
  await page.goto(htmlUrl, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts?.ready)

  if (keyframesOnly) {
    const outDir = path.join(__dirname, 'keyframes')
    fs.mkdirSync(outDir, { recursive: true })
    const times = [0.8, 1.75, 3.6, 5.0, 6.6, 8.8, 10.68, 12.6]
    for (const t of times) {
      await page.evaluate((ts) => window.seek(ts), t)
      const file = path.join(outDir, `frame_${t.toFixed(2).replace('.', '_')}s.png`)
      await page.screenshot({ path: file, type: 'png' })
      console.log(`Saved keyframe: ${file}`)
    }
    await browser.close()
    return
  }

  const audioPath = path.join(__dirname, 'audio.wav')
  const outMp4 = path.join(__dirname, 'asi-messenger-promo.mp4')

  const ffArgs = [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-r', String(FPS),
    '-i', '-',
    ...(fs.existsSync(audioPath) ? ['-i', audioPath] : []),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '15',
    '-pix_fmt', 'yuv420p',
    ...(fs.existsSync(audioPath) ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []),
    '-movflags', '+faststart',
    outMp4
  ]

  console.log(`Rendering ${TOTAL_FRAMES} frames (${DURATION}s @ ${FPS}fps) -> ${outMp4}`)
  const ff = spawn(FFMPEG, ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] })

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const t = i / FPS
    await page.evaluate((ts) => window.seek(ts), t)
    const pngBuf = await page.screenshot({ type: 'png' })
    const ok = ff.stdin.write(pngBuf)
    if (!ok) {
      await new Promise((resolve) => ff.stdin.once('drain', resolve))
    }
    if ((i + 1) % 60 === 0 || i === TOTAL_FRAMES - 1) {
      console.log(`  rendered ${i + 1}/${TOTAL_FRAMES} (${((i + 1) / FPS).toFixed(1)}s)`)
    }
  }

  ff.stdin.end()
  await new Promise((resolve, reject) => {
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
  })

  await browser.close()
  console.log(`Done! Output saved to ${outMp4}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
