import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProfileStorageLayout } from './types'

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const WORKSPACE_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|workspace-[A-Za-z0-9_-]{8,96})$/iu

export function assertProfileId(profileId: string): string {
  if (!PROFILE_ID_PATTERN.test(profileId)) throw new Error('Invalid local profile identity')
  return profileId
}

function assertContained(root: string, candidate: string): string {
  const child = relative(root, candidate)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Local profile path escaped its storage root')
  }
  return candidate
}

export function createProfileStorageLayout(dataRoot: string, deviceRoot: string, profileId: string): ProfileStorageLayout {
  const safeProfileId = assertProfileId(profileId)
  const normalizedDataRoot = resolve(dataRoot)
  const normalizedDeviceRoot = resolve(deviceRoot)
  const profileRoot = assertContained(normalizedDataRoot, resolve(normalizedDataRoot, 'profiles', safeProfileId))
  const deviceBoundRoot = assertContained(normalizedDeviceRoot, resolve(normalizedDeviceRoot, 'profiles', safeProfileId))
  const configRoot = join(profileRoot, 'config')
  const platformRoot = join(profileRoot, 'platform')
  const extensionsRoot = join(profileRoot, 'extensions')
  const workspaceOverlaysRoot = join(profileRoot, 'workspaces')
  const pluginsRoot = join(extensionsRoot, 'plugins')
  return {
    profileId: safeProfileId,
    dataRoot: normalizedDataRoot,
    deviceRoot: normalizedDeviceRoot,
    profileRoot,
    profileMetadataPath: join(profileRoot, 'profile.json'),
    configRoot,
    configPath: join(configRoot, 'config.json'),
    credentialsPath: join(configRoot, 'credentials.json'),
    personaPath: join(configRoot, 'profile.json'),
    settingsPath: join(configRoot, 'settings.json'),
    conversationsRoot: join(profileRoot, 'conversations'),
    conversationsV2Root: join(profileRoot, 'conversations-v2'),
    interactionRoot: join(profileRoot, 'interaction'),
    platformRoot,
    projectsPath: join(platformRoot, 'projects.json'),
    automationsPath: join(platformRoot, 'automations.json'),
    artifactsPath: join(platformRoot, 'artifacts.json'),
    managedTaskTitlesPath: join(platformRoot, 'managed-task-titles.json'),
    extensionsRoot,
    userSkillsRoot: join(extensionsRoot, 'skills'),
    pluginsRoot,
    pluginsIndexPath: join(extensionsRoot, 'plugins.json'),
    pluginStorageRoot: join(extensionsRoot, 'plugin-storage'),
    workspaceOverlaysRoot,
    workspaceBindingsPath: join(workspaceOverlaysRoot, 'bindings.json'),
    deviceBoundRoot,
    remoteRoot: join(deviceBoundRoot, 'remote'),
    cacheRoot: join(deviceBoundRoot, 'cache'),
  }
}

export function ensureProfileStorageLayout(layout: ProfileStorageLayout): void {
  for (const directory of [
    layout.profileRoot,
    layout.configRoot,
    layout.conversationsRoot,
    layout.conversationsV2Root,
    layout.interactionRoot,
    layout.platformRoot,
    layout.extensionsRoot,
    layout.userSkillsRoot,
    layout.pluginsRoot,
    layout.pluginStorageRoot,
    layout.workspaceOverlaysRoot,
    layout.deviceBoundRoot,
    layout.remoteRoot,
    layout.cacheRoot,
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 })
}

export function workspaceOverlayRoot(layout: ProfileStorageLayout, workspaceId: string): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new Error('Invalid workspace identity')
  return assertContained(layout.workspaceOverlaysRoot, resolve(layout.workspaceOverlaysRoot, workspaceId))
}
