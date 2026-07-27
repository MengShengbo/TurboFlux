import React, { createContext, useContext, useMemo, type ReactNode } from 'react'
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

const I18nContext = createContext<{ locale: TurboFluxInterfaceLanguage; t: Translator }>({
  locale: 'en',
  t: createTranslator('en'),
})

export function I18nProvider({ locale, children }: { locale: TurboFluxInterfaceLanguage; children: ReactNode }) {
  const value = useMemo(() => ({ locale, t: createTranslator(locale) }), [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}

export { EN_MESSAGES, ZH_CN_MESSAGES, type MessageKey }
