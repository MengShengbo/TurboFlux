interface AutomationApprovalLike {
  targetSummary?: string
  toolName?: string
  path?: string
  reason?: string
  priorSideEffects?: string[]
}

export interface AutomationApprovalScopeRow {
  label: string
  value: string
  risk: boolean
}

export function automationApprovalScopeRows(request: AutomationApprovalLike): AutomationApprovalScopeRow[] {
  const rows: AutomationApprovalScopeRow[] = []
  if (request.toolName) rows.push({ label: '工具', value: request.toolName, risk: true })
  if (request.path) rows.push({ label: '具体路径', value: request.path, risk: true })
  if (request.targetSummary && request.targetSummary !== request.toolName && request.targetSummary !== request.path) {
    rows.push({ label: '目标摘要', value: request.targetSummary, risk: true })
  }
  if (request.reason) rows.push({ label: '申请原因', value: request.reason, risk: false })
  for (const sideEffect of request.priorSideEffects ?? []) rows.push({ label: '此前副作用', value: sideEffect, risk: true })
  if (rows.length === 0) rows.push({ label: '具体目标', value: '未提供，建议拒绝并检查运行详情', risk: true })
  return rows
}
