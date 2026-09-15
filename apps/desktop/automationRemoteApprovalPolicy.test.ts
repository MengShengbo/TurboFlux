import { describe, expect, it } from 'vitest'
import { automationRemoteApprovalPolicy } from './automationRemoteApprovalPolicy'

describe('automationRemoteApprovalPolicy', () => {
  it('keeps local filesystem targets private and fail closed', () => {
    expect(automationRemoteApprovalPolicy({
      kind: 'permission',
      riskCategory: 'filesystem',
      toolName: 'write_file',
      options: ['allow-once', 'deny'],
    })).toEqual({
      targetSummary: '文件系统操作 · 具体路径仅在 Desktop 可见',
      options: ['deny'],
      allowFromRemote: false,
    })
  })

  it('allows declared choices for a safely named Computer operation', () => {
    expect(automationRemoteApprovalPolicy({
      kind: 'permission',
      riskCategory: 'computer',
      toolName: 'computer__click',
      options: ['approve-everything', 'allow-once'],
    })).toEqual({
      targetSummary: 'Computer 操作 · computer__click',
      options: ['allow-once', 'deny'],
      allowFromRemote: true,
    })
  })

  it('does not project model questions or choices for input requests', () => {
    expect(automationRemoteApprovalPolicy({
      kind: 'input',
      riskCategory: 'input',
      options: ['sensitive answer'],
    })).toEqual({
      targetSummary: '需要补充信息 · 请在 Desktop 查看具体问题',
      options: ['deny'],
      allowFromRemote: false,
    })
  })
})
