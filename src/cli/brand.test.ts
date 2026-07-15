import { describe, expect, it } from 'vitest'
import { centerText, centerTextBlock } from './brand'

describe('brand alignment', () => {
  it('centers the wordmark as one block', () => {
    expect(centerTextBlock(['wide', 'x'], 10)).toEqual(['   wide', '   x'])
  })

  it('uses terminal display width for centered metadata', () => {
    expect(centerText('工作区', 10)).toBe('  工作区')
  })

  it('does not add padding when content exceeds the frame', () => {
    expect(centerTextBlock(['long wordmark'], 4)).toEqual(['long wordmark'])
  })
})
