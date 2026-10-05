import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Antigravity's headless mode cannot ask for permission: a tool that needs one is denied, and the way to allow a specific action
 * is an exact rule in its settings.json (`permissions.allow`). To give you real per-action approval we add the one rule you approved,
 * restart the agent so it reads it, and take the rule away again afterwards. Rules are counted, so two chats that approve the same
 * action never remove each other's, and a journal lets a later run clean up after a crash.
 */
export const defaultSettingsPath = (): string => join(homedir(), '.gemini', 'antigravity-cli', 'settings.json')

type Settings = { permissions?: { allow?: string[] } } & Record<string, unknown>

const refs = new Map<string, number>()
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
export async function addRule(settingsPath: string, rule: string): Promise<void> {
  const n = (refs.get(rule) ?? 0) + 1
  refs.set(rule, n)
  if (n > 1) return
  const { data, existed } = await readSettings(settingsPath)
  const allow = (data.permissions ??= {}).allow ??= []
  const journal = await readJournal(settingsPath)
  if (!allow.includes(rule)) {
    allow.push(rule)
    await writeAtomic(settingsPath, data)
    await writeAtomic(journalOf(settingsPath), { rules: [...new Set([...journal.rules, rule])], createdFile: journal.createdFile || !existed })
  }
}

/** Take back a rule this process added, once nobody needs it. A settings file we created ourselves is removed again. */
export async function removeRule(settingsPath: string, rule: string): Promise<void> {
  const n = (refs.get(rule) ?? 0) - 1
  if (n > 0) return void refs.set(rule, n)
  refs.delete(rule)
  await dropRules(settingsPath, [rule])
}

async function dropRules(settingsPath: string, rules: string[]): Promise<void> {
  const journal = await readJournal(settingsPath)
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
export async function cleanupStaleRules(settingsPath: string): Promise<void> {
  if (refs.size > 0) return
  const journal = await readJournal(settingsPath)
  if (journal.rules.length) await dropRules(settingsPath, journal.rules)
}

/** The rule Antigravity says it needs, from its own denial message ("... user denied permission for write_file(/p)"). */
export function ruleFromDenial(message: string): string | null {
  return /user denied permission for ([^\n]+)/.exec(message)?.[1]?.trim() ?? null
}
