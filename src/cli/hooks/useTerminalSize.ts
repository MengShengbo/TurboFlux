import { useSyncExternalStore } from 'react'

export interface TerminalSize {
  columns: number
  rows: number
}

export interface TerminalSizeSource {
  columns?: number
  rows?: number
  on(event: 'resize', listener: () => void): unknown
  off(event: 'resize', listener: () => void): unknown
}

export interface TerminalSizeStore {
  getSnapshot: () => TerminalSize
  subscribe: (listener: () => void) => () => void
}

export function createTerminalSizeStore(source: TerminalSizeSource): TerminalSizeStore {
  const read = (): TerminalSize => ({
    columns: source.columns || 80,
    rows: source.rows || 24,
  })
  let snapshot = read()
  const subscribers = new Set<() => void>()
  const onResize = () => {
    const next = read()
    if (next.columns === snapshot.columns && next.rows === snapshot.rows) return
    snapshot = next
    for (const subscriber of subscribers) subscriber()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      if (subscribers.size === 0) {
        snapshot = read()
        source.on('resize', onResize)
      }
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
        if (subscribers.size === 0) source.off('resize', onResize)
      }
    },
  }
}

const terminalSizeStore = createTerminalSizeStore(process.stdout)

export function useTerminalSize(): TerminalSize {
  return useSyncExternalStore(
    terminalSizeStore.subscribe,
    terminalSizeStore.getSnapshot,
    terminalSizeStore.getSnapshot,
  )
}
