import { describe, expect, it } from 'vitest'
import { automationApprovalScopeRows } from './automationApprovalPresentation'

describe('automationApprovalScopeRows', () => {
  it('does not let a summary hide the concrete tool, path, reason, or prior effects', () => {
    expect(automationApprovalScopeRows({
      targetSummary: '生成报告',
      toolName: 'write_file',
      path: '/workspace/report.md',
      reason: '保存最终结果',
      priorSideEffects: ['已创建临时目录'],
    })).toEqual([
      { label: '工具', value: 'write_file', risk: true },
      { label: '具体路径', value: '/workspace/report.md', risk: true },
      { label: '目标摘要', value: '生成报告', risk: true },
      { label: '申请原因', value: '保存最终结果', risk: false },
      { label: '此前副作用', value: '已创建临时目录', risk: true },
    ])
  })

  it('makes missing targets explicit instead of silently showing a generic question', () => {
    expect(automationApprovalScopeRows({})).toEqual([
      { label: '具体目标', value: '未提供，建议拒绝并检查运行详情', risk: true },
    ])
  })
})
