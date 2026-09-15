import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProfileContext } from './types'

const SECRET_FIELD = /(?:api.?key|secret|password|token|authorization|credential)/iu

export function redactProfileSettingsSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProfileSettingsSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => (
    SECRET_FIELD.test(key) ? [] : [[key, redactProfileSettingsSecrets(child)]]
  )))
}

export async function copyNonSecretProfileSettings(source: ProfileContext, target: ProfileContext): Promise<void> {
  for (const [sourcePath, targetPath] of [
    [source.storage.configPath, target.storage.configPath],
    [source.storage.personaPath, target.storage.personaPath],
  ]) {
    try {
      const document: unknown = JSON.parse(await readFile(sourcePath, 'utf8'))
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      await writeFile(targetPath, `${JSON.stringify(redactProfileSettingsSecrets(document), null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
