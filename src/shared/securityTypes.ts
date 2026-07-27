export type SecurityMode = 'off' | 'red' | 'blue'

export interface SecurityResearchProfile {
  mode: SecurityMode
  active: boolean
  engagementId?: string
  targets: string[]
  objective?: string
  startedAt?: number
  expiresAt?: number
}

export function createOffSecurityProfile(): SecurityResearchProfile {
  return { mode: 'off', active: false, targets: [] }
}
