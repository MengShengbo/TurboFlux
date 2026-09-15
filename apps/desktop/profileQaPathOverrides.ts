import { isAbsolute, resolve } from 'node:path'

export type ProfileQaPathOverrideKind = 'export' | 'import' | 'rebind'

const PROFILE_QA_PATH_KEYS: Record<ProfileQaPathOverrideKind, string> = {
  export: 'TURBOFLUX_DESKTOP_QA_PROFILE_EXPORT_PATH',
  import: 'TURBOFLUX_DESKTOP_QA_PROFILE_IMPORT_PATH',
  rebind: 'TURBOFLUX_DESKTOP_QA_PROFILE_REBIND_PATH',
}

export function profileQaPathOverride(
  environment: NodeJS.ProcessEnv,
  kind: ProfileQaPathOverrideKind,
): string | undefined {
  if (environment.TURBOFLUX_DESKTOP_QA_HIDDEN !== '1') return undefined
  const value = environment[PROFILE_QA_PATH_KEYS[kind]]?.trim()
  if (!value || !isAbsolute(value)) return undefined
  return resolve(value)
}
