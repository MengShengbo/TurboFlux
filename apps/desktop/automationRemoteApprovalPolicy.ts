interface RemoteApprovalPolicyInput {
  kind: 'permission' | 'input'
  riskCategory: 'permission' | 'filesystem' | 'network' | 'computer' | 'secret' | 'input'
  toolName?: string
  options?: string[]
}

export interface RemoteApprovalPolicy {
  targetSummary: string
  options: string[]
  allowFromRemote: boolean
}

function declaredOptions(input: RemoteApprovalPolicyInput): string[] {
  const allowed = new Set(['allow-once', 'allow-run', 'allow-session', 'deny'])
  const options = input.options?.map(option => option.trim()).filter(option => allowed.has(option)) ?? []
  return [...new Set([...options, 'deny'])]
}

export function automationRemoteApprovalPolicy(input: RemoteApprovalPolicyInput): RemoteApprovalPolicy {
  const tool = input.toolName?.trim()
  if (input.kind === 'input') return { targetSummary: '需要补充信息 · 请在 Desktop 查看具体问题', options: ['deny'], allowFromRemote: false }
  if (input.riskCategory === 'filesystem') return { targetSummary: '文件系统操作 · 具体路径仅在 Desktop 可见', options: ['deny'], allowFromRemote: false }
  if (input.riskCategory === 'network') return { targetSummary: '网络操作 · 具体地址仅在 Desktop 可见', options: ['deny'], allowFromRemote: false }
  if (input.riskCategory === 'secret') return { targetSummary: '秘密访问 · 具体引用仅在 Desktop 可见', options: ['deny'], allowFromRemote: false }
  if (!tool) return { targetSummary: '受限操作 · 具体目标仅在 Desktop 可见', options: ['deny'], allowFromRemote: false }
  return {
    targetSummary: input.riskCategory === 'computer' ? `Computer 操作 · ${tool}` : `受限工具 · ${tool}`,
    options: declaredOptions(input),
    allowFromRemote: true,
  }
}
