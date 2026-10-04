import { homedir } from 'node:os'
import type { Repo } from './db/repo'

/** First-run data: a home workspace plus the always-online ASI friend and a local Echo friend. */
export async function ensureDefaults(repo: Repo): Promise<void> {
  if (await repo.settings.get('seeded', false)) return
  await repo.workspaces.create({ name: 'Home', path: homedir(), slot: 1 })
  await repo.friends.create({ harness: 'asi', displayName: 'ASI', avatar: 'asi' })
  await repo.friends.create({ harness: 'echo', displayName: 'Echo', avatar: 'echo' })
  await repo.settings.set('profile', { name: 'You', personalMessage: '', presence: 'online' })
  await repo.settings.set('seeded', true)
}
