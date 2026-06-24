import { describe, expect, it } from 'vitest'
import { shouldAutoFastContext } from './agentEngine'

describe('shouldAutoFastContext', () => {
  it('enables fast context for Chinese code location requests', () => {
    expect(shouldAutoFastContext('帮我找一下名片页面上方黑色区域相关代码')).toBe(true)
    expect(shouldAutoFastContext('搜索持卡人这个文案在哪个组件里')).toBe(true)
  })

  it('enables fast context for English implementation lookup requests', () => {
    expect(shouldAutoFastContext('find where the settings page component is implemented')).toBe(true)
  })

  it('does not enable fast context for short chat messages', () => {
    expect(shouldAutoFastContext('hi')).toBe(false)
    expect(shouldAutoFastContext('thanks')).toBe(false)
  })
})
