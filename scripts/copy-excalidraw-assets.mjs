// Excalidraw loads its fonts from EXCALIDRAW_ASSET_PATH; self-host them so the app works offline.
import { cpSync, existsSync, mkdirSync } from 'node:fs'

const src = 'node_modules/@excalidraw/excalidraw/dist/prod/fonts'
const dest = 'src/renderer/public/excalidraw-assets/fonts'
if (!existsSync(src)) {
  console.warn('[excalidraw-assets] package not installed yet; skipping')
  process.exit(0)
}
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log('[excalidraw-assets] copied fonts')
