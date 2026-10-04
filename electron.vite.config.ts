import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') }

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') }, external: ['electron'] }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        external: ['electron'],
        // sandboxed preload scripts must be CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias },
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
})
