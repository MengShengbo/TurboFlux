import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomicSync } from './fileIO'

export interface CredentialSnapshot {
  apiKey?: string
  apiConfigs?: Record<string, string>
}

const CREDENTIALS_FILE = join(process.env.TURBOFLUX_CONFIG_DIR || join(homedir(), '.turboflux'), 'credentials.json')

export function loadCredentialSnapshot(): CredentialSnapshot {
  if (!existsSync(CREDENTIALS_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as CredentialSnapshot : {}
  } catch {
    return {}
  }
}

export function saveCredentialSnapshot(snapshot: CredentialSnapshot): void {
  writeFileAtomicSync(CREDENTIALS_FILE, JSON.stringify(snapshot, null, 2), 0o600)
}

export function getCredentialsFile(): string {
  return CREDENTIALS_FILE
}
