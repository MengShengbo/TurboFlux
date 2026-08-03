import React, { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { TurboFluxInterfaceLanguage } from '../../core/profile'
import { createTranslator, type Translator } from './translator'

export { createTranslator, EN_MESSAGES, ZH_CN_MESSAGES, type MessageKey, type TranslationValues, type Translator } from './translator'

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
