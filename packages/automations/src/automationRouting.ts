import type {
  AutomationAgentPolicy,
  AutomationAgentPolicySnapshot,
  AutomationDefinition,
  AutomationRouteDecision,
  AutomationTriggerFilter,
} from './automationTypes'

export function freezeAutomationAgentPolicy(
  policy: AutomationAgentPolicy | undefined,
  selectedStrategyId?: string,
): AutomationAgentPolicySnapshot {
  const strategyId = selectedStrategyId ?? policy?.defaultStrategyId
  const strategy = policy?.enabled ? policy.strategies.find(candidate => candidate.id === strategyId) : undefined
  return strategy ? {
    strategyId: strategy.id,
    allowedAgentTypes: [...strategy.allowedAgentTypes],
    maxSubtasks: strategy.maxSubtasks,
    maxParallel: strategy.maxParallel,
  } : {
    strategyId,
    allowedAgentTypes: [],
    maxSubtasks: 0,
    maxParallel: 1,
  }
}

function fieldValue(payload: unknown, field: string): unknown {
  const segments = field.split('.').filter(Boolean)
  if (segments.length === 0 || segments.length > 12) return undefined
  let current = payload
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function safeRegex(pattern: string): RegExp {
  if (pattern.length > 200) throw new Error('Trigger filter uses an unsafe regular expression')
  let escaped = false
  let inCharacterClass = false
  let quantifiers = 0
  let unboundedQuantifiers = 0
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!
    if (escaped) {
      if (/[1-9]/u.test(character)) throw new Error('Trigger filter uses an unsafe regular expression')
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      inCharacterClass = true
      continue
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false
      continue
    }
    if (inCharacterClass) continue
    if (character === '(' || character === ')' || character === '|') throw new Error('Trigger filter uses an unsafe regular expression')
    if (character === '*' || character === '+') {
      quantifiers += 1
      unboundedQuantifiers += 1
    } else if (character === '?') {
      quantifiers += 1
      if (index > 0 && /[*+?}]/u.test(pattern[index - 1]!)) throw new Error('Trigger filter uses an unsafe regular expression')
    } else if (character === '{') {
      const closing = pattern.indexOf('}', index + 1)
      const match = closing > index ? /^(\d+)(?:,(\d*))?$/u.exec(pattern.slice(index + 1, closing)) : null
      if (!match) throw new Error('Trigger filter uses an unsafe regular expression')
      const upper = match[2] === undefined ? Number(match[1]) : match[2] === '' ? undefined : Number(match[2])
      if (upper !== undefined && upper > 1_000) throw new Error('Trigger filter uses an unsafe regular expression')
      quantifiers += 1
      if (upper === undefined) unboundedQuantifiers += 1
      index = closing
    }
    if (quantifiers > 8 || unboundedQuantifiers > 1) throw new Error('Trigger filter uses an unsafe regular expression')
  }
  return new RegExp(pattern, 'u')
}

export function matchesAutomationTriggerFilters(payload: unknown, filters: AutomationTriggerFilter[] = []): boolean {
  return filters.every(filter => {
    const actual = fieldValue(payload, filter.field)
    const expected = filter.value
    if (filter.operator === 'equals') return actual === expected
    if (filter.operator === 'not_equals') return actual !== expected
    if (filter.operator === 'in') return Array.isArray(expected) && expected.includes(String(actual))
    if (filter.operator === 'contains') return Array.isArray(actual)
      ? actual.some(item => item === expected)
      : typeof actual === 'string' && actual.includes(String(expected))
    if (filter.operator === 'prefix') return typeof actual === 'string' && actual.startsWith(String(expected))
    if (filter.operator === 'suffix') return typeof actual === 'string' && actual.endsWith(String(expected))
    return typeof actual === 'string' && safeRegex(String(expected)).test(actual)
  })
}

export function evaluateAutomationRoute(
  definition: AutomationDefinition,
  payload: unknown,
  evaluatedAt = Date.now(),
): AutomationRouteDecision {
  const policy = definition.routing ?? { rules: [], defaultAction: 'run' as const }
  const matched = policy.rules.find(rule => matchesAutomationTriggerFilters(payload, rule.filters))
  if (matched) {
    return {
      ruleId: matched.id,
      label: matched.label,
      action: matched.action,
      objectiveSuffix: matched.objectiveSuffix,
      agentStrategyId: matched.agentStrategyId,
      evaluatedAt,
    }
  }
  return {
    label: 'Default route',
    action: policy.defaultAction,
    agentStrategyId: policy.defaultAgentStrategyId,
    evaluatedAt,
  }
}
