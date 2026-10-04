import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelManager, Progress } from './model-manager'
import type { VoiceRuntime } from './voice-runtime'
import { neededBytes, type VoiceModel } from '@shared/voice-models'

export interface VoiceProgress extends Omit<Progress, 'phase'> { modelId: string; line?: string; phase: Progress['phase'] | 'runtime' }

/** Ties the Python runtime and the model download together behind the Voice settings. */
export function createVoiceSetup(deps: { models: ModelManager; runtime: VoiceRuntime; root: string; catalog: VoiceModel[]; skipRuntime?: boolean }) {
  const { models, runtime, catalog } = deps
  const runtimeReady = async () => deps.skipRuntime || (await runtime.status()).installed

  return {
    async overview() {
      let freeBytes = 0
      try { const s = await statfs(deps.root.startsWith('/') ? deps.root : '/'); freeBytes = s.bavail * s.bsize } catch { /* directory not created yet */ }
      const rt = await runtimeReady()
      return {
        runtimeInstalled: rt,
        freeBytes,
        models: await Promise.all(catalog.map(async (m) => ({ model: m, status: await models.status(m), installing: models.isInstalling(m), neededBytes: neededBytes(m, !rt) })))
      }
    },
    async install(modelId: string, onProgress: (p: VoiceProgress) => void): Promise<void> {
      const m = catalog.find((x) => x.id === modelId)
      if (!m) throw new Error(`unknown model ${modelId}`)
      if (!(await runtimeReady())) {
        onProgress({ modelId, phase: 'runtime', received: 0, total: 0, line: 'Setting up the speech runtime…' })
        await runtime.install((line) => onProgress({ modelId, phase: 'runtime', received: 0, total: 0, line }))
      }
      await models.install(m, (p) => onProgress({ modelId, ...p }))
    },
    cancel(modelId: string): void { const m = catalog.find((x) => x.id === modelId); if (m) models.cancel(m) },
    async remove(modelId: string): Promise<void> { const m = catalog.find((x) => x.id === modelId); if (m) await models.remove(m) },
    modelDir: async (modelId: string): Promise<string | null> => {
      const m = catalog.find((x) => x.id === modelId)
      const st = m ? await models.status(m) : null
      return st?.path ?? null
    },
    runtimeReady,
    root: deps.root,
    join
  }
}

export type VoiceSetup = ReturnType<typeof createVoiceSetup>
