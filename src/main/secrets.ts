import type { Repo } from './db/repo'

/** Encrypts with the OS keychain (Electron safeStorage); injected so it can be tested without Electron. */
export interface SecretCrypto {
  available(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

/** Secrets (API tokens) never sit in the database in plain text. */
export function createSecrets(repo: Repo, crypto: SecretCrypto) {
  const key = (name: string) => `secret:${name}`
  return {
    async set(name: string, value: string): Promise<void> {
      if (!crypto.available()) throw new Error('the system keychain is not available, so the token cannot be stored safely')
      await repo.settings.set(key(name), crypto.encrypt(value))
    },
    async get(name: string): Promise<string | null> {
      const c = await repo.settings.get<string | null>(key(name), null)
      if (!c) return null
      try { return crypto.decrypt(c) } catch { return null }
    },
    async has(name: string): Promise<boolean> { return (await this.get(name)) !== null },
    async delete(name: string): Promise<void> { await repo.settings.set(key(name), null) }
  }
}

export type Secrets = ReturnType<typeof createSecrets>
