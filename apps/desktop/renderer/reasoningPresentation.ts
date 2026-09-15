import type { NativeReasoningConfig, ReasoningEffort } from '@turboflux/agent-core/contracts'
import type { WorkbenchModelOption } from '@turboflux/agent-core/workbench'

export type ReasoningTone = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return ({
    none: '关闭',
    minimal: '极简',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '增强',
    max: '最高',
  } as const)[effort]
}

export function reasoningEffortDetail(effort: ReasoningEffort): string {
  return ({
    none: '不附加额外推理',
    minimal: '仅做必要判断',
    low: '优先响应速度',
    medium: '速度与质量平衡',
    high: '深入处理复杂问题',
    xhigh: '扩展多阶段推理',
    max: '使用模型最高推理强度',
  } as const)[effort]
}

export function reasoningTone(config?: NativeReasoningConfig): ReasoningTone {
  if (!config || config.enabled === false || config.effort === 'none') return 'none'
  if (config.effort) return config.effort
  if (config.budgetTokens) {
    if (config.budgetTokens >= 32_768) return 'max'
    if (config.budgetTokens >= 16_384) return 'xhigh'
    if (config.budgetTokens >= 8_192) return 'high'
    return 'medium'
  }
  return 'medium'
}

export interface ReasoningOption {
  id: string
  label: string
  detail: string
  config: NativeReasoningConfig
  tone: ReasoningTone
}

type ReasoningCapability = NonNullable<WorkbenchModelOption['reasoningCapabilities']>

export function reasoningBudgetLabel(budgetTokens: number): string {
  return `${Math.round((budgetTokens / 1024) * 10) / 10}K`
}

export function buildReasoningOptions(capability: ReasoningCapability, current?: NativeReasoningConfig): ReasoningOption[] {
  if (capability.control === 'fixed') return []
  const options: ReasoningOption[] = []
  if (capability.control === 'budget') {
    if (capability.supportsToggle) options.push({ id: 'off', label: '关闭', detail: '不附加额外推理', config: { enabled: false }, tone: 'none' })
    const budgets = [4_096, 8_192, 16_384, 32_768, 65_536]
    if (current?.budgetTokens && !budgets.includes(current.budgetTokens)) budgets.push(current.budgetTokens)
    budgets.sort((left, right) => left - right)
    budgets.forEach(budgetTokens => {
      const config = { enabled: true, budgetTokens }
      options.push({ id: `budget-${budgetTokens}`, label: reasoningBudgetLabel(budgetTokens), detail: '推理 token 预算', config, tone: reasoningTone(config) })
    })
    return options
  }
  if (capability.efforts.length > 0) {
    for (const effort of capability.efforts) {
      if (effort === 'none' && !capability.supportsToggle) continue
      const config: NativeReasoningConfig = { enabled: effort !== 'none', effort }
      options.push({ id: `effort-${effort}`, label: reasoningEffortLabel(effort), detail: reasoningEffortDetail(effort), config, tone: reasoningTone(config) })
    }
    if (capability.supportsToggle && !capability.efforts.includes('none')) {
      options.unshift({ id: 'off', label: '关闭', detail: '不附加额外推理', config: { enabled: false }, tone: 'none' })
    }
    return options
  }
  if (capability.supportsToggle) {
    options.push(
      { id: 'off', label: '关闭', detail: '不附加额外推理', config: { enabled: false }, tone: 'none' },
      { id: 'on', label: '开启', detail: '使用模型原生推理', config: { enabled: true }, tone: 'medium' },
    )
  }
  return options
}

export function effectiveReasoningConfig(
  profileConfig: NativeReasoningConfig | undefined,
  modelConfig: NativeReasoningConfig | undefined,
  capability: ReasoningCapability,
): NativeReasoningConfig {
  const efforts = capability.efforts.filter(effort => effort !== 'none' || capability.supportsToggle)
  const defaultEffort = efforts.includes(capability.defaultEffort!) ? capability.defaultEffort : efforts[0]
  let requestedEffort = profileConfig?.effort ?? modelConfig?.effort
  if (profileConfig?.enabled === true && profileConfig.effort === undefined && requestedEffort === 'none') requestedEffort = defaultEffort
  const effort = efforts.includes(requestedEffort!) ? requestedEffort : defaultEffort
  const enabled = capability.supportsToggle
    ? (profileConfig?.enabled ?? modelConfig?.enabled ?? capability.defaultEnabled) !== false && effort !== 'none'
    : true
  const budgetTokens = capability.control === 'budget'
    ? Math.max(1_024, Math.min(128_000, Math.round(profileConfig?.budgetTokens ?? modelConfig?.budgetTokens ?? capability.defaultBudgetTokens ?? 8_192)))
    : undefined
  return {
    enabled,
    effort,
    budgetTokens,
  }
}

export function reasoningOptionIndex(options: ReasoningOption[], current: NativeReasoningConfig): number {
  const disabled = current.enabled === false || current.effort === 'none'
  const index = options.findIndex(option => {
    if (option.config.enabled === false || option.config.effort === 'none') return disabled
    if (disabled) return false
    if (option.config.budgetTokens !== undefined) return current.budgetTokens === option.config.budgetTokens
    if (option.config.effort !== undefined) return current.effort === option.config.effort
    return current.enabled !== false
  })
  return index >= 0 ? index : 0
}

export function reasoningSliderIndex(value: number, optionCount: number): number {
  if (optionCount <= 1 || !Number.isFinite(value)) return 0
  return Math.round(Math.min(optionCount - 1, Math.max(0, value)))
}

const reasoningDetentReleaseDistance = 0.68

export function reasoningSliderDetentIndex(value: number, optionCount: number, currentIndex: number): number {
  if (optionCount <= 1 || !Number.isFinite(value)) return 0
  const clampedValue = Math.min(optionCount - 1, Math.max(0, value))
  const index = reasoningSliderIndex(currentIndex, optionCount)
  // Separate entry and release thresholds keep a latched stop stable on reversal.
  if (Math.abs(clampedValue - index) < reasoningDetentReleaseDistance) return index
  return reasoningSliderIndex(clampedValue, optionCount)
}

export function reasoningSliderDetentValue(value: number, optionCount: number, currentIndex: number): number {
  if (optionCount <= 1 || !Number.isFinite(value)) return 0
  const clampedValue = Math.min(optionCount - 1, Math.max(0, value))
  const index = reasoningSliderIndex(currentIndex, optionCount)
  const offset = clampedValue - index
  const holdDistance = 0.34
  const pull = Math.min(1, Math.max(0, (Math.abs(offset) - holdDistance) / (reasoningDetentReleaseDistance - holdDistance)))
  return Math.min(optionCount - 1, Math.max(0, index + Math.sign(offset) * 0.08 * pull * pull))
}

export function reasoningSliderProgress(value: number, optionCount: number): number {
  if (optionCount <= 1 || !Number.isFinite(value)) return 0
  const clampedValue = Math.min(optionCount - 1, Math.max(0, value))
  return (clampedValue / (optionCount - 1)) * 100
}
