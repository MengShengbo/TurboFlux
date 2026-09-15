import { describe, expect, it } from 'vitest'
import {
  computerPermissionGrantGroup,
  computerToolApprovalLevel,
  describeComputerPermission,
  describeComputerToolActivity,
  inferComputerActionSafetyClass,
  isBuiltInComputerTool,
} from './computerToolPresentation'

describe('computer tool product presentation', () => {
  it('presents computer work semantically without exposing text, keys, or coordinates', () => {
    const typing = describeComputerToolActivity('computer__type_text', {
      app_name: 'Keynote',
      text: 'private launch plan',
      x: 1480,
      y: 932,
    }, 'running')

    expect(typing).toEqual({
      title: '填写应用内容',
      detail: '正在填写应用内容 · Keynote',
      approvalLevel: 'policy',
      needsApproval: true,
    })
    expect(JSON.stringify(typing)).not.toContain('private launch plan')
    expect(JSON.stringify(typing)).not.toContain('1480')
    expect(JSON.stringify(typing)).not.toContain('932')

    const keyboard = describeComputerPermission('computer__press', {
      app_name: 'Keynote',
      keys: ['META', 'ENTER'],
    })
    expect(JSON.stringify(keyboard)).not.toContain('META')
    expect(JSON.stringify(keyboard)).not.toContain('ENTER')
  })

  it('separates observation, policy actions, takeover, and blocked operations', () => {
    expect(computerToolApprovalLevel('computer__status')).toBe('none')
    expect(computerToolApprovalLevel('computer__observe')).toBe('none')
    expect(computerToolApprovalLevel('computer__observe', { scope: 'display' })).toBe('always')
    expect(computerToolApprovalLevel('computer__list_apps')).toBe('none')
    expect(computerToolApprovalLevel('computer__move')).toBe('none')
    expect(computerToolApprovalLevel('computer__scroll')).toBe('none')
    expect(computerToolApprovalLevel('computer__click')).toBe('policy')
    expect(computerToolApprovalLevel('computer__type_text')).toBe('policy')
    expect(computerToolApprovalLevel('computer__handoff')).toBe('always')
    expect(computerToolApprovalLevel('computer__unregistered')).toBe('deny')
    expect(computerToolApprovalLevel('files__read')).toBeNull()
    expect(isBuiltInComputerTool('computer__observe')).toBe(true)
    expect(isBuiltInComputerTool('browser__observe')).toBe(false)
  })

  it('escalates high-impact actions and requires handoff for credential entry', () => {
    expect(computerToolApprovalLevel('computer__click', { safety_class: 'payment' })).toBe('deny')
    expect(computerToolApprovalLevel('computer__press', { risk: 'destructive' })).toBe('always')
    expect(computerToolApprovalLevel('computer__type_text', { field_type: 'password' })).toBe('deny')
    expect(computerToolApprovalLevel('computer__type_text', { safety_class: 'credential' })).toBe('deny')
    expect(computerToolApprovalLevel('computer__click', { x: 40, y: 80, safety_class: 'routine' })).toBe('always')
    expect(computerToolApprovalLevel('computer__press', { keys: ['ENTER'], safety_class: 'routine' })).toBe('always')
    expect(computerToolApprovalLevel('computer__press', { keys: ['META', 'V'], safety_class: 'routine' })).toBe('always')
    expect(computerToolApprovalLevel('computer__type_text', { text: 'first\nsecond', safety_class: 'routine' })).toBe('always')
    expect(inferComputerActionSafetyClass('computer__click', {
      description: '确认付款',
      safety_class: 'routine',
    })).toBe('payment')

    expect(describeComputerPermission('computer__type_text', {
      app_name: 'Safari',
      text: 'never expose me',
      field_type: 'password',
    })).toEqual({
      title: '需要你接管',
      question: '请在 Safari 中接管并完成这一步。',
      reason: 'TurboFlux 不会代为输入密码、验证码或其他认证信息。',
      runningDetail: '正在等待你接管 · Safari',
      approvalLevel: 'deny',
    })
  })

  it('does not create reusable grants for native computer writes', () => {
    const keynote = { app_name: 'Keynote', bundle_id: 'com.apple.Keynote' }

    expect(computerPermissionGrantGroup('computer__click', keynote)).toBeUndefined()
    expect(computerPermissionGrantGroup('computer__double_click', keynote)).toBeUndefined()
    expect(computerPermissionGrantGroup('computer__type_text', keynote)).toBeUndefined()
    expect(computerPermissionGrantGroup('computer__click', {})).toBeUndefined()
    expect(computerPermissionGrantGroup('computer__click', { app_name: 'Keynote', safety_class: 'payment' }))
      .toBeUndefined()
    expect(computerPermissionGrantGroup('computer__handoff', keynote)).toBeUndefined()
  })

  it('creates natural app-aware approval copy without implementation details', () => {
    expect(describeComputerPermission('computer__focus_app', { app_name: 'Keynote' })).toEqual({
      title: '切换应用',
      question: '允许 TurboFlux 切换到 Keynote 吗？',
      reason: '这会把目标应用带到前台，并改变当前键盘焦点。',
      runningDetail: '正在切换应用 · Keynote',
      approvalLevel: 'policy',
    })
    expect(describeComputerPermission('computer__click', {
      app_name: 'Safari',
      x: 400,
      y: 300,
      safety_class: 'external',
    })).toEqual({
      title: '操作应用',
      question: '允许 TurboFlux 在 Safari 中点击内容吗？',
      reason: '这可能对外发送、发布或提交信息，需要你逐次确认。',
      runningDetail: '正在点击应用内容 · Safari',
      approvalLevel: 'always',
    })
    expect(describeComputerPermission('computer__observe', {})).toBeNull()
    expect(describeComputerPermission('computer__observe', { scope: 'display' })).toMatchObject({
      approvalLevel: 'always',
    })
  })

  it('fails closed for unknown built-in computer operations', () => {
    expect(describeComputerToolActivity('computer__raw_script', { script: 'dangerous()' }, 'running')).toEqual({
      title: '电脑操作已阻止',
      detail: '该电脑操作不可用',
      approvalLevel: 'deny',
      needsApproval: false,
    })
    expect(describeComputerPermission('computer__raw_script', { script: 'dangerous()' })).toEqual({
      title: '电脑操作已阻止',
      question: '此电脑操作不能执行。',
      reason: 'TurboFlux 只允许已注册并经过安全分级的电脑操作。',
      runningDetail: '该电脑操作不可用',
      approvalLevel: 'deny',
    })
  })
})
