import { describe, expect, it } from 'vitest'
import { evaluateAutomationRoute } from './automationRouting'
import { AUTOMATION_SCHEMA_VERSION, type AutomationDefinition } from './automationTypes'

function definition(): AutomationDefinition {
  return {
    id: 'automation-route-test', schemaVersion: AUTOMATION_SCHEMA_VERSION, revision: 1, status: 'active', name: 'Route test',
    workspaceRef: { path: '/workspace' },
    objective: { originalPrompt: 'Review events', goal: 'Review events', successCriteria: [], deliverables: [], constraints: [] },
    triggers: [],
    context: { mode: 'isolated', includeAutomationMemory: false, includePreviousRunSummary: false, fileRefs: [], skillIds: [] },
    capabilities: { approvalPolicy: 'ask', allowedTools: [], deniedTools: [], paths: [], networkDomains: [], secretRefs: [], mcpServerIds: [], pluginIds: [], allowComputerUse: false, allowBackgroundComputerUse: false },
    reliability: { misfirePolicy: 'run-once', overlapPolicy: 'skip', maxParallel: 1, maxQueuedRuns: 1, maxRuntimeMinutes: 60, maxToolCalls: 100, retry: { maxRetries: 0, backoffMinutes: 1, maxBackoffMinutes: 1, jitter: 0 }, resourceLocks: [] },
    routing: {
      rules: [
        { id: 'security', label: 'Security review', filters: [{ field: 'labels', operator: 'contains', value: 'security' }], action: 'run', objectiveSuffix: 'Prioritize the security impact.', agentStrategyId: 'security-review' },
        { id: 'draft', label: 'Ignore drafts', filters: [{ field: 'draft', operator: 'equals', value: true }], action: 'skip' },
      ],
      defaultAction: 'run',
    },
    delivery: { desktop: [], remoteMobile: [], digest: 'immediate', providerRefs: [] },
    createdAt: 1, updatedAt: 1,
  }
}

describe('automation deterministic routing', () => {
  it('selects the first matching branch without changing permissions', () => {
    expect(evaluateAutomationRoute(definition(), { labels: ['security'], draft: true }, 10)).toEqual({
      ruleId: 'security', label: 'Security review', action: 'run', objectiveSuffix: 'Prioritize the security impact.', agentStrategyId: 'security-review', evaluatedAt: 10,
    })
  })

  it('supports deterministic skip and a bounded safe-regex policy', () => {
    expect(evaluateAutomationRoute(definition(), { draft: true }, 10)).toMatchObject({ ruleId: 'draft', action: 'skip' })
    const unsafe = definition()
    unsafe.routing!.rules[0].filters = [{ field: 'title', operator: 'matches', value: '(a)\\1' }]
    expect(() => evaluateAutomationRoute(unsafe, { title: 'aaa' }, 10)).toThrow('unsafe regular expression')
    for (const pattern of ['(a+)+$', '(a|aa)+$', 'a+a+']) {
      unsafe.routing!.rules[0].filters = [{ field: 'title', operator: 'matches', value: pattern }]
      expect(() => evaluateAutomationRoute(unsafe, { title: 'a'.repeat(10_000) }, 10)).toThrow('unsafe regular expression')
    }
    unsafe.routing!.rules[0].filters = [{ field: 'title', operator: 'matches', value: '^TF-[0-9]+$' }]
    expect(evaluateAutomationRoute(unsafe, { title: 'TF-42' }, 10)).toMatchObject({ ruleId: 'security', action: 'run' })
  })
})
