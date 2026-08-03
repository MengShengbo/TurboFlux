import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TurboFluxInterfaceLanguage } from '../../core/profile'
import { EN_MESSAGES, ZH_CN_MESSAGES, type MessageKey } from './messages'

export type TranslationValues = Record<string, string | number | boolean | null | undefined>
export type Translator = (key: MessageKey, values?: TranslationValues) => string

const CATALOGS: Record<TurboFluxInterfaceLanguage, Record<MessageKey, string>> = {
  en: EN_MESSAGES,
  'zh-CN': ZH_CN_MESSAGES,
}

function interpolate(message: string, values?: TranslationValues): string {
  if (!values) return message
  return message.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) => {
    const value = values[name]
    return value === undefined || value === null ? token : String(value)
  })
}

export function createTranslator(locale: TurboFluxInterfaceLanguage): Translator {
  const catalog = CATALOGS[locale] ?? EN_MESSAGES
  return (key, values) => interpolate(catalog[key] ?? EN_MESSAGES[key] ?? key, values)
}

export function readStoredInterfaceLanguage(): TurboFluxInterfaceLanguage {
  const configDirectory = process.env.TURBOFLUX_CONFIG_DIR || join(homedir(), '.turboflux')
  const profileFile = join(configDirectory, 'profile.json')
  if (!existsSync(profileFile)) return 'zh-CN'
  try {
    const raw = JSON.parse(readFileSync(profileFile, 'utf8')) as { interfaceLanguage?: unknown }
    return raw.interfaceLanguage === 'en' ? 'en' : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

export { EN_MESSAGES, ZH_CN_MESSAGES, type MessageKey }
