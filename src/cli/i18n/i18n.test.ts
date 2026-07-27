import { describe, expect, it } from 'vitest'
import { createTranslator, EN_MESSAGES, ZH_CN_MESSAGES } from './index'

describe('CLI i18n', () => {
  it('keeps locale catalogs structurally complete', () => {
    expect(Object.keys(ZH_CN_MESSAGES).sort()).toEqual(Object.keys(EN_MESSAGES).sort())
  })

  it('interpolates named values without changing unknown placeholders', () => {
    const t = createTranslator('zh-CN')
    expect(t('ui.app.modelSwitched', { model: 'gpt-5.6' })).toBe('模型已切换为 gpt-5.6')
    expect(t('ui.app.modelSwitched')).toContain('{model}')
  })

  it('keeps technical identifiers intact across locales', () => {
    expect(createTranslator('zh-CN')('setup.fastContext.followMain')).toContain('FastContext')
    expect(createTranslator('en')('setup.fastContext.followMain')).toContain('FastContext')
  })
})
