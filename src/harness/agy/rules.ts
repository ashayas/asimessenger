import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Antigravity's headless mode cannot ask for permission: a tool that needs one is denied, and the way to allow a specific action
 * is an exact rule in its settings.json (`permissions.allow`). To give you real per-action approval we add the one rule you approved,
 * restart the agent so it reads it, and take the rule away again afterwards. Rules are counted, so two chats that approve the same
 * action never remove each other's, and a journal lets a later run clean up after a crash.
 */
export const defaultSettingsPath = (): string => join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')

type Settings = { permissions?: { allow?: string[] } } & Record<string, unknown>

const refs = new Map<string, Map<string, number>>()
const locks = new Map<string, Promise<unknown>>()

/** Settings and their journal form one transaction; concurrent chats must not overwrite each other. */
function locked<T>(path: string, work: (path: string) => Promise<T>): Promise<T> {
  path = resolve(path)
  const next = (locks.get(path) ?? Promise.resolve()).catch(() => {}).then(() => work(path))
  locks.set(path, next)
  void next.finally(() => { if (locks.get(path) === next) locks.delete(path) }).catch(() => {})
  return next
}
const journalOf = (settingsPath: string) => join(dirname(settingsPath), 'asi-messenger-temp-rules.json')

async function readSettings(path: string): Promise<{ data: Settings; existed: boolean }> {
  try { return { data: JSON.parse(await readFile(path, 'utf8')) as Settings, existed: true } } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, existed: false }
    throw new Error(`could not read ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
}

async function writeAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.asi-${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, path)
}

async function readJournal(settingsPath: string): Promise<{ rules: string[]; createdFile: boolean }> {
  try { return JSON.parse(await readFile(journalOf(settingsPath), 'utf8')) as { rules: string[]; createdFile: boolean } } catch { return { rules: [], createdFile: false } }
}

/** Allow an exact action (`write_file(/real/path)`, `command(git status)`). Safe to call twice for the same rule. */
export function addRule(settingsPath: string, rule: string): Promise<void> {
  return locked(settingsPath, async (path) => {
    const held = refs.get(path) ?? new Map<string, number>()
    const n = held.get(rule) ?? 0
    if (!n) {
      const { data, existed } = await readSettings(path)
      const allow = (data.permissions ??= {}).allow ??= []
      if (!allow.includes(rule)) {
        const journal = await readJournal(path)
        // Journal first: a crash between writes must never leave an untracked grant.
        await writeAtomic(journalOf(path), { rules: [...new Set([...journal.rules, rule])], createdFile: journal.createdFile || !existed })
        allow.push(rule)
        await writeAtomic(path, data)
      }
    }
    held.set(rule, n + 1)
    refs.set(path, held)
  })
}

/** Release only grants we own. Rules the user already had are never removed. */
export function removeRule(settingsPath: string, rule: string): Promise<void> {
  return locked(settingsPath, async (path) => {
    const held = refs.get(path)
    const n = held?.get(rule) ?? 0
    if (!n) return
    if (n > 1) { held!.set(rule, n - 1); return }
    await dropRules(path, [rule])
    held!.delete(rule)
    if (!held!.size) refs.delete(path)
  })
}

async function dropRules(settingsPath: string, rules: string[]): Promise<void> {
  const journal = await readJournal(settingsPath)
  rules = rules.filter((rule) => journal.rules.includes(rule))
  if (!rules.length) return
  if (!existsSync(settingsPath)) return void (await rm(journalOf(settingsPath), { force: true }))
  const { data } = await readSettings(settingsPath)
  const allow = data.permissions?.allow
  if (allow) {
    data.permissions!.allow = allow.filter((r) => !rules.includes(r))
    if (data.permissions!.allow.length === 0) delete data.permissions!.allow
    if (Object.keys(data.permissions!).length === 0) delete data.permissions
  }
  const left = journal.rules.filter((r) => !rules.includes(r))
  if (journal.createdFile && Object.keys(data).length === 0) await rm(settingsPath, { force: true })
  else await writeAtomic(settingsPath, data)
  if (left.length === 0) await rm(journalOf(settingsPath), { force: true })
  else await writeAtomic(journalOf(settingsPath), { rules: left, createdFile: journal.createdFile })
}

/** Remove rules a crashed run left behind (called when no session in this process holds any). */
export function cleanupStaleRules(settingsPath: string): Promise<void> {
  return locked(settingsPath, async (path) => {
    const journal = await readJournal(path)
    const stale = journal.rules.filter((rule) => !refs.get(path)?.has(rule))
    if (stale.length) await dropRules(path, stale)
  })
}

/** The rule Antigravity says it needs, from its own denial message ("... user denied permission for write_file(/p)"). */
export function ruleFromDenial(message: string): string | null {
  return /user denied permission for ([^\n]+)/.exec(message)?.[1]?.trim() ?? null
}
