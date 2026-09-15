export type ComposerRuntimeStatus = 'ready' | 'running' | 'paused' | 'awaiting-action' | 'error'

export type ComposerRunButtonPresentation = {
  action: 'send' | 'pause' | 'resume'
  disabled: boolean
  icon: 'sendUp' | 'pauseBlock' | 'play'
  title: string
}

export function presentComposerRunButton(input: {
  runtimeStatus: ComposerRuntimeStatus
  submissionPending: boolean
  hasDraftInput: boolean
  interactionLocked: boolean
}): ComposerRunButtonPresentation {
  if (input.submissionPending || input.runtimeStatus === 'running') {
    return {
      action: 'pause',
      disabled: input.interactionLocked,
      icon: 'pauseBlock',
      title: '暂停当前任务',
    }
  }

  if (input.runtimeStatus === 'paused') {
    return {
      action: 'resume',
      disabled: input.interactionLocked,
      icon: 'play',
      title: '继续当前任务',
    }
  }

  return {
    action: 'send',
    disabled: input.interactionLocked || !input.hasDraftInput,
    icon: 'sendUp',
    title: input.hasDraftInput ? '发送' : '输入内容后发送',
  }
}
