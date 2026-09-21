import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ActiveProfilePaths {
  configRoot: string
  conversationsRoot: string
  userSkillsRoot: string
  globalMcpSettingsPath: string
}

let activeProfilePaths: ActiveProfilePaths | undefined

function defaultConfigRoot(): string {
  return resolve(process.env.TURBOFLUX_CONFIG_DIR || join(homedir(), '.turboflux'))
}

export function defaultActiveProfilePaths(): ActiveProfilePaths {
  const configRoot = defaultConfigRoot()
  return {
    configRoot,
    conversationsRoot: resolve(process.env.TURBOFLUX_CONVERSATIONS_DIR || join(configRoot, 'conversations')),
    userSkillsRoot: join(configRoot, 'skills'),
    globalMcpSettingsPath: join(configRoot, 'settings.json'),
  }
}

export function configureActiveProfilePaths(paths: ActiveProfilePaths | undefined): void {
  activeProfilePaths = paths ? {
    configRoot: resolve(paths.configRoot),
    conversationsRoot: resolve(paths.conversationsRoot),
    userSkillsRoot: resolve(paths.userSkillsRoot),
    globalMcpSettingsPath: resolve(paths.globalMcpSettingsPath),
  } : undefined
}

export function getActiveProfilePaths(): ActiveProfilePaths {
  return activeProfilePaths ? { ...activeProfilePaths } : defaultActiveProfilePaths()
}
