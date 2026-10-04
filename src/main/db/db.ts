import { createClient, type Client } from '@libsql/client'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './migrations'

export type Db = Client

/** Opens (creating if needed) a local libSQL file and applies pending migrations. ':memory:' is allowed. */
export async function openDb(file: string): Promise<Db> {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = createClient({ url: file === ':memory:' ? ':memory:' : `file:${file}` })
  await db.execute('PRAGMA foreign_keys = ON')
  if (file !== ':memory:') await db.execute('PRAGMA journal_mode = WAL')
  await migrate(db)
  return db
}

export async function migrate(db: Db): Promise<number> {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = (await db.execute('SELECT MAX(version) AS v FROM schema_version')).rows[0]
  const current = Number(row?.['v'] ?? 0)
  for (let i = current; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!
    await db.executeMultiple(`BEGIN;\n${sql}\nINSERT INTO schema_version(version) VALUES (${i + 1});\nCOMMIT;`)
  }
  return MIGRATIONS.length
}
