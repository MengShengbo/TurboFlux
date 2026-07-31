import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

interface WindowsTerminalProfile {
  guid?: unknown
  opacity?: unknown
  useAcrylic?: unknown
  acrylicOpacity?: unknown
  backgroundImage?: unknown
  backgroundImageOpacity?: unknown
}

interface WindowsTerminalSettings {
  profiles?: {
    defaults?: WindowsTerminalProfile
    list?: WindowsTerminalProfile[]
  }
}

export interface TerminalTransparencyOptions {
  transparent?: boolean
  opaque?: boolean
  environment?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  windowsTerminalSettingsPaths?: string[]
  readTextFile?: (filePath: string) => string | undefined
}

export function resolveTransparentBackground(options: TerminalTransparencyOptions = {}): boolean {
  if (options.opaque) return false
  if (options.transparent) return true

  const environment = options.environment ?? process.env
  const configured = parseBooleanPreference(environment.TURBOFLUX_TRANSPARENT)
  if (configured !== undefined) return configured

  return detectTerminalTransparency({ ...options, environment })
}

export function detectTerminalTransparency(options: TerminalTransparencyOptions = {}): boolean {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  if (platform !== 'win32' || !environment.WT_SESSION || !environment.WT_PROFILE_ID) return false

  const settingsPaths = options.windowsTerminalSettingsPaths
    ?? windowsTerminalSettingsPaths(environment.LOCALAPPDATA)
  const readTextFile = options.readTextFile ?? readExistingTextFile

  for (const settingsPath of settingsPaths) {
    const source = readTextFile(settingsPath)
    if (source === undefined) continue
    const transparent = windowsTerminalProfileUsesTransparency(source, environment.WT_PROFILE_ID)
    if (transparent !== undefined) return transparent
  }

  return false
}

export function windowsTerminalProfileUsesTransparency(
  source: string,
  activeProfileId: string,
): boolean | undefined {
  let settings: WindowsTerminalSettings
  try {
    settings = JSON.parse(removeTrailingCommas(removeJsonComments(source))) as WindowsTerminalSettings
  } catch {
    return undefined
  }

  const profiles = settings.profiles
  const activeId = normalizeProfileId(activeProfileId)
  const activeProfile = profiles?.list?.find(profile => (
    typeof profile.guid === 'string' && normalizeProfileId(profile.guid) === activeId
  ))
  if (!activeProfile) return undefined

  const defaults = profiles?.defaults
  const opacity = inheritedSetting(activeProfile, defaults, 'opacity')
  const windowIsTransparent = typeof opacity === 'number'
    && Number.isFinite(opacity)
    && opacity >= 0
    && opacity < 100

  const backgroundImage = inheritedSetting(activeProfile, defaults, 'backgroundImage')
  const backgroundImageOpacity = inheritedSetting(activeProfile, defaults, 'backgroundImageOpacity')
  const hasVisibleBackgroundImage = typeof backgroundImage === 'string'
    && backgroundImage.trim().length > 0
    && (typeof backgroundImageOpacity !== 'number'
      || (Number.isFinite(backgroundImageOpacity) && backgroundImageOpacity > 0))

  if (windowIsTransparent || hasVisibleBackgroundImage) return true

  const useAcrylic = inheritedSetting(activeProfile, defaults, 'useAcrylic')
  if (useAcrylic !== true) return false

  const acrylicOpacity = inheritedSetting(activeProfile, defaults, 'acrylicOpacity')
  return typeof acrylicOpacity !== 'number'
    || (Number.isFinite(acrylicOpacity) && acrylicOpacity >= 0 && acrylicOpacity < 1)
}

function windowsTerminalSettingsPaths(localAppData: string | undefined): string[] {
  if (!localAppData) return []
  return [
    join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(localAppData, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(localAppData, 'Packages', 'Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(localAppData, 'Packages', 'Microsoft.WindowsTerminalDev_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    join(localAppData, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ]
}

function inheritedSetting(
  profile: WindowsTerminalProfile,
  defaults: WindowsTerminalProfile | undefined,
  key: keyof WindowsTerminalProfile,
): unknown {
  return Object.hasOwn(profile, key) ? profile[key] : defaults?.[key]
}

function normalizeProfileId(profileId: string): string {
  return profileId.trim().replace(/^\{?|\}?$/g, '').toLowerCase()
}

function parseBooleanPreference(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false
  return undefined
}

function readExistingTextFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return undefined
  }
}

function removeJsonComments(source: string): string {
  let result = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (character === '\n' || character === '\r') {
        lineComment = false
        result += character
      } else {
        result += ' '
      }
      continue
    }

    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        result += '  '
        index += 1
      } else {
        result += character === '\n' || character === '\r' ? character : ' '
      }
      continue
    }

    if (inString) {
      result += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') {
      inString = true
      result += character
    } else if (character === '/' && next === '/') {
      lineComment = true
      result += '  '
      index += 1
    } else if (character === '/' && next === '*') {
      blockComment = true
      result += '  '
      index += 1
    } else {
      result += character
    }
  }

  return result
}

function removeTrailingCommas(source: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      result += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }

    if (character === '"') {
      inString = true
      result += character
      continue
    }

    if (character === ',') {
      let nextIndex = index + 1
      while (/\s/.test(source[nextIndex] ?? '')) nextIndex += 1
      if (source[nextIndex] === '}' || source[nextIndex] === ']') continue
    }

    result += character
  }

  return result
}
