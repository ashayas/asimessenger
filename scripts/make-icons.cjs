// Renders assets/logo.svg onto a glossy tile with Chromium, then builds build/icon.icns via iconutil.
// Usage: pnpm icons
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const root = join(__dirname, '..')
const logo = readFileSync(join(root, 'assets/logo.svg'), 'utf8')
const html = (px) => `<!doctype html><body style="margin:0;background:transparent">
<div style="width:${px}px;height:${px}px;display:grid;place-items:center">
 <div style="width:${px * 0.9}px;height:${px * 0.9}px;border-radius:${px * 0.2}px;position:relative;overflow:hidden;
  background:linear-gradient(180deg,#ffffff 0%,#dcebfb 55%,#bcd6f4 100%);
  box-shadow:0 ${px * 0.012}px ${px * 0.03}px rgba(10,40,110,.35), inset 0 0 0 ${px * 0.006}px #9db6d8">
  <div style="position:absolute;left:0;right:0;top:0;height:46%;background:linear-gradient(180deg,rgba(255,255,255,.85),rgba(255,255,255,.1))"></div>
  <div style="position:absolute;inset:${px * 0.09}px">${logo.replace('width="512" height="512"', 'width="100%" height="100%"')}</div>
 </div></div></body>`

async function renderMaster() {
  const px = 1024
  const win = new BrowserWindow({ width: px, height: px, show: false, transparent: true, useContentSize: true })
  const file = join(root, 'build', '.render.html')
  writeFileSync(file, html(px))
  await win.loadFile(file)
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  win.destroy()
  rmSync(file, { force: true })
  return img.resize({ width: px, height: px, quality: 'best' })
}

app.whenReady().then(async () => {
  const set = join(root, 'build/icon.iconset')
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set, { recursive: true })
  const master = await renderMaster()
  const at = (px) => master.resize({ width: px, height: px, quality: 'best' }).toPNG()
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(set, `icon_${s}x${s}.png`), at(s))
    writeFileSync(join(set, `icon_${s}x${s}@2x.png`), at(s * 2))
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'build/icon.icns')])
  writeFileSync(join(root, 'build/icon.png'), master.toPNG())
  rmSync(set, { recursive: true, force: true })
  console.log('wrote build/icon.icns and build/icon.png')
  app.quit()
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
