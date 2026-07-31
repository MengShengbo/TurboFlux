import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { quarantineCorruptFileSync, writeFileAtomicSync } from './fileIO'

export interface CredentialSnapshot {
  apiKey?: string
  apiConfigs?: Record<string, string>
}

const CREDENTIALS_FILE = join(process.env.TURBOFLUX_CONFIG_DIR || join(homedir(), '.turboflux'), 'credentials.json')

export function loadCredentialSnapshot(): CredentialSnapshot {
  if (!existsSync(CREDENTIALS_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Credentials must be a JSON object')
    const raw = parsed as Record<string, unknown>
    const apiConfigs = raw.apiConfigs && typeof raw.apiConfigs === 'object' && !Array.isArray(raw.apiConfigs)
      ? Object.fromEntries(Object.entries(raw.apiConfigs).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1])))
      : undefined
    return {
      apiKey: typeof raw.apiKey === 'string' && raw.apiKey ? raw.apiKey : undefined,
      apiConfigs,
    }
  } catch (error) {
    const backupPath = quarantineCorruptFileSync(CREDENTIALS_FILE)
    console.warn(`TurboFlux preserved an invalid credentials file at ${backupPath}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

export function serializeCredentialSnapshot(snapshot: CredentialSnapshot): string {
  return JSON.stringify(snapshot, null, 2)
}

export function saveCredentialSnapshot(snapshot: CredentialSnapshot): void {
  writeFileAtomicSync(CREDENTIALS_FILE, serializeCredentialSnapshot(snapshot), 0o600)
}

export function getCredentialsFile(): string {
  return CREDENTIALS_FILE
}
