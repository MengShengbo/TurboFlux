const AUTOMATION_OBJECTIVE_GOAL = /<automation_objective(?:\s[^>]*)?>\s*Goal:\s*(.*?)(?=\r?\n|\s+(?:Success criteria:|Deliverables:|Constraints:|When nothing changed:|On failure:)|<\/automation_objective>|$)/iu
const INTERNAL_PROMPT_TAG = /<\/?(?:automation_objective|automation_recovery)(?:\s[^>]*)?>/iu

export function normalizeConversationTitleText(value: unknown, maxLength = 80): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength)
}

export function generatedConversationTitle(value: unknown, maxLength = 60): string {
  if (typeof value !== 'string') return ''
  const automationGoal = value.match(AUTOMATION_OBJECTIVE_GOAL)?.[1]
  if (automationGoal) return normalizeConversationTitleText(automationGoal, maxLength)
  if (INTERNAL_PROMPT_TAG.test(value)) return ''
  return normalizeConversationTitleText(value, maxLength)
}
