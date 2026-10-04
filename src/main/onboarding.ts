import { basename } from 'node:path'
import type { Repo } from './db/repo'
import { addPreset } from './friends-service'

export interface OnboardingInput {
  name: string
  workspacePath: string
  presetIds: string[]
}

export async function isOnboarded(repo: Repo): Promise<boolean> {
  return repo.settings.get('onboarded', false)
}

/** First-run setup: profile name, the first workspace folder, and the agents you picked. Idempotent. */
export async function completeOnboarding(repo: Repo, input: OnboardingInput): Promise<void> {
  const name = input.name.trim()
  if (!name) throw new Error('tell your agents what to call you')
  const profile = await repo.settings.get('profile', { name: 'You', personalMessage: '', presence: 'online' })
  await repo.settings.set('profile', { ...profile, name })

  const path = input.workspacePath.trim()
  if (path) {
    const first = (await repo.workspaces.list())[0]
    if (first) {
      await repo.workspaces.setPath(first.id, path)
      await repo.workspaces.rename(first.id, basename(path) || first.name)
    } else {
      await repo.workspaces.create({ name: basename(path) || 'Workspace', path, slot: 1 })
    }
  }
  for (const id of input.presetIds) await addPreset(repo, id)
  await repo.settings.set('onboarded', true)
}
