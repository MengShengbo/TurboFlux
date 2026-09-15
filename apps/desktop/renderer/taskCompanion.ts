export type TaskCompanionItemKind = 'work' | 'preview' | 'browser' | 'subagents' | 'computer'

export interface TaskCompanionState {
  active: boolean
  work?: { title: string; detail: string; attention?: boolean }
  preview?: { title: string; detail: string }
  browser?: { title: string; detail: string; attention?: boolean }
  subagents?: { total: number; running: number; completed: number }
  computer?: { title: string; detail: string; attention?: boolean }
}

export interface TaskCompanionItem {
  kind: TaskCompanionItemKind
  title: string
  detail: string
  attention?: boolean
}

export interface TaskCompanionPresentation {
  visible: boolean
  items: TaskCompanionItem[]
}

export function presentTaskCompanion(state: TaskCompanionState): TaskCompanionPresentation {
  if (!state.active) return { visible: false, items: [] }
  const items: TaskCompanionItem[] = []
  if (state.work) items.push({ kind: 'work', ...state.work })
  const contextual: Array<TaskCompanionItem & { priority: number }> = []
  if (state.computer) contextual.push({ kind: 'computer', ...state.computer, priority: state.computer.attention ? 100 : 80 })
  const surface = state.browser?.attention
    ? { kind: 'browser' as const, ...state.browser, priority: 90 }
    : state.preview
      ? { kind: 'preview' as const, ...state.preview, priority: 70 }
      : state.browser
        ? { kind: 'browser' as const, ...state.browser, priority: 70 }
        : undefined
  if (surface) contextual.push(surface)
  if (state.subagents?.running) {
    const parts = [
      state.subagents.running ? `${state.subagents.running} 运行中` : '',
      state.subagents.completed ? `${state.subagents.completed} 已完成` : '',
    ].filter(Boolean)
    contextual.push({
      kind: 'subagents',
      title: '协作代理',
      detail: parts.join(' · ') || `${state.subagents.total} 项`,
      priority: 75,
    })
  }
  items.push(...contextual
    .sort((left, right) => right.priority - left.priority)
    .slice(0, 2)
    .map(({ priority: _priority, ...item }) => item))
  return { visible: items.length > 0, items }
}
