import { describe, expect, it } from 'vitest'
import type { WorkbenchModelOption } from '@turboflux/workbench'
import {
  buildReasoningOptions,
  effectiveReasoningConfig,
  reasoningEffortLabel,
  reasoningOptionIndex,
  reasoningSliderDetentIndex,
  reasoningSliderDetentValue,
  reasoningSliderIndex,
  reasoningSliderProgress,
  reasoningTone,
} from './reasoningPresentation'

const deepSeekCapability = {
  family: 'deepseek',
  control: 'toggle-effort',
  efforts: ['low', 'high', 'max'],
  supportsToggle: true,
  defaultEnabled: true,
  defaultEffort: 'high',
  omitTemperature: true,
  description: 'DeepSeek reasoning',
} as NonNullable<WorkbenchModelOption['reasoningCapabilities']>

describe('desktop reasoning picker presentation', () => {
  it('uses localized effort labels', () => {
    expect(reasoningEffortLabel('none')).toBe('关闭')
    expect(reasoningEffortLabel('high')).toBe('高')
    expect(reasoningEffortLabel('max')).toBe('最高')
  })

  it('preserves the effort color semantics', () => {
    expect(reasoningTone({ enabled: false })).toBe('none')
    expect(reasoningTone({ enabled: true, effort: 'medium' })).toBe('medium')
    expect(reasoningTone({ enabled: true, effort: 'high' })).toBe('high')
    expect(reasoningTone({ enabled: true, effort: 'xhigh' })).toBe('xhigh')
    expect(reasoningTone({ enabled: true, effort: 'max' })).toBe('max')
  })

  it('falls back to the model reasoning before capability defaults', () => {
    expect(effectiveReasoningConfig(undefined, { enabled: true, effort: 'max' }, deepSeekCapability)).toEqual({ enabled: true, effort: 'max' })
    expect(effectiveReasoningConfig(undefined, undefined, deepSeekCapability)).toEqual({ enabled: true, effort: 'high', budgetTokens: undefined })
  })

  it('selects the effective setting and treats every disabled shape as off', () => {
    const options = buildReasoningOptions(deepSeekCapability)
    expect(options.map(option => option.label)).toEqual(['关闭', '低', '高', '最高'])
    expect(reasoningOptionIndex(options, { enabled: true, effort: 'high' })).toBe(2)
    expect(reasoningOptionIndex(options, { enabled: false, effort: 'high' })).toBe(0)
  })

  it('does not expose fake controls for fixed reasoning', () => {
    expect(buildReasoningOptions({ ...deepSeekCapability, control: 'fixed', supportsToggle: false })).toEqual([])
  })

  it('keeps a custom reasoning budget selectable', () => {
    const capability = {
      ...deepSeekCapability,
      family: 'anthropic',
      control: 'budget',
      efforts: [],
      defaultBudgetTokens: 8_192,
    } as NonNullable<WorkbenchModelOption['reasoningCapabilities']>
    const options = buildReasoningOptions(capability, { enabled: true, budgetTokens: 12_288 })
    expect(options.some(option => option.config.budgetTokens === 12_288)).toBe(true)
    expect(reasoningOptionIndex(options, { enabled: true, budgetTokens: 12_288 })).toBeGreaterThan(0)
  })

  it('keeps continuous drag progress bounded and snaps to the nearest effort', () => {
    expect(reasoningSliderProgress(1.5, 4)).toBe(50)
    expect(reasoningSliderProgress(-2, 4)).toBe(0)
    expect(reasoningSliderProgress(8, 4)).toBe(100)
    expect(reasoningSliderIndex(1.49, 4)).toBe(1)
    expect(reasoningSliderIndex(1.51, 4)).toBe(2)
    expect(reasoningSliderIndex(9, 4)).toBe(3)
  })

  it('holds each stop until the pointer deliberately pulls into the next one', () => {
    for (let index = 0; index < 5; index += 1) {
      expect(reasoningSliderDetentIndex(index + 0.65, 6, index)).toBe(index)
      expect(reasoningSliderDetentIndex(index + 0.7, 6, index)).toBe(index + 1)
      expect(reasoningSliderDetentIndex(index + 0.35, 6, index + 1)).toBe(index + 1)
      expect(reasoningSliderDetentIndex(index + 0.3, 6, index + 1)).toBe(index)
    }
  })

  it('does not chatter between stops when the pointer jitters around a midpoint', () => {
    let index = reasoningSliderDetentIndex(1.7, 6, 1)
    for (const value of [1.52, 1.48, 1.51, 1.49, 1.35]) {
      index = reasoningSliderDetentIndex(value, 6, index)
      expect(index).toBe(2)
    }
    expect(reasoningSliderDetentIndex(1.3, 6, index)).toBe(1)
  })

  it('pins the thumb to a stop and limits the resistance movement before release', () => {
    expect(reasoningSliderDetentValue(1.3, 6, 1)).toBe(1)
    expect(reasoningSliderDetentValue(0.7, 6, 1)).toBe(1)
    const forwardPull = reasoningSliderDetentValue(1.65, 6, 1)
    const backwardPull = reasoningSliderDetentValue(0.35, 6, 1)
    expect(forwardPull).toBeGreaterThan(1)
    expect(forwardPull).toBeLessThan(1.08)
    expect(backwardPull).toBeCloseTo(2 - forwardPull)
    expect(reasoningSliderDetentValue(1.7, 6, 2)).toBe(2)
  })

  it('allows fast drags across multiple stops and bounds endpoints and degenerate ranges', () => {
    expect(reasoningSliderDetentIndex(4.8, 6, 0)).toBe(5)
    expect(reasoningSliderDetentIndex(0.2, 6, 5)).toBe(0)
    expect(reasoningSliderDetentIndex(-2, 6, 2)).toBe(0)
    expect(reasoningSliderDetentIndex(9, 6, 2)).toBe(5)
    expect(reasoningSliderDetentValue(-2, 6, 0)).toBe(0)
    expect(reasoningSliderDetentValue(9, 6, 5)).toBe(5)
    for (const count of [0, 1]) {
      expect(reasoningSliderDetentIndex(0.8, count, 0)).toBe(0)
      expect(reasoningSliderDetentValue(0.8, count, 0)).toBe(0)
    }
    expect(reasoningSliderDetentIndex(Number.NaN, 6, 2)).toBe(0)
    expect(reasoningSliderDetentValue(Number.NaN, 6, 2)).toBe(0)
  })

})
