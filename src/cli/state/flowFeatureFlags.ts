export interface FlowFeatureFlags {
  flowUi: boolean
  transcriptWindowing: boolean
  notifications: boolean
  streamScheduler: boolean
  journalBatching: boolean
}

export const FLOW_FEATURE_ENV = {
  all: 'TURBOFLUX_FLOW',
  flowUi: 'TURBOFLUX_FLOW_UI',
  transcriptWindowing: 'TURBOFLUX_FLOW_WINDOWING',
  notifications: 'TURBOFLUX_FLOW_NOTIFICATIONS',
  streamScheduler: 'TURBOFLUX_FLOW_STREAM_SCHEDULER',
  journalBatching: 'TURBOFLUX_FLOW_JOURNAL_BATCHING',
} as const

const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled'])
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])

export function resolveFlowFeatureFlags(environment: NodeJS.ProcessEnv = process.env): FlowFeatureFlags {
  const globallyEnabled = resolveFlag(environment[FLOW_FEATURE_ENV.all], true)
  return {
    flowUi: resolveFlag(environment[FLOW_FEATURE_ENV.flowUi], globallyEnabled),
    transcriptWindowing: resolveFlag(environment[FLOW_FEATURE_ENV.transcriptWindowing], globallyEnabled),
    notifications: resolveFlag(environment[FLOW_FEATURE_ENV.notifications], globallyEnabled),
    streamScheduler: resolveFlag(environment[FLOW_FEATURE_ENV.streamScheduler], globallyEnabled),
    journalBatching: resolveFlag(environment[FLOW_FEATURE_ENV.journalBatching], globallyEnabled),
  }
}

export function describeFlowFeatureFlags(flags: FlowFeatureFlags): string {
  return Object.entries(flags)
    .map(([name, enabled]) => `${name}=${enabled ? 'on' : 'off'}`)
    .join(', ')
}

export function isPersistenceRecoveryCommand(input: string): boolean {
  const command = input.trim().split(/\s+/, 1)[0]?.toLowerCase()
  return command === '/flow'
    || command === '/help'
    || command === '/?'
    || command === '/exit'
    || command === '/quit'
    || command === '/q'
}

function resolveFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return fallback
  if (DISABLED_VALUES.has(normalized)) return false
  if (ENABLED_VALUES.has(normalized)) return true
  return fallback
}
