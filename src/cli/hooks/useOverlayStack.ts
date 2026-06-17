import { useState, useCallback, useRef } from 'react'

export type OverlayName = 'history' | 'rewind' | 'modelPicker' | null

export function useOverlayStack() {
  const [active, setActive] = useState<OverlayName>(null)
  const stackRef = useRef<OverlayName[]>([])

  const push = useCallback((name: NonNullable<OverlayName>) => {
    setActive((prev: OverlayName) => {
      if (prev) stackRef.current.push(prev)
      return name
    })
  }, [])

  const pop = useCallback(() => {
    setActive(() => {
      const next = stackRef.current.pop() ?? null
      return next
    })
  }, [])

  const closeAll = useCallback(() => {
    stackRef.current = []
    setActive(null)
  }, [])

  const isActive = useCallback(
    (name: OverlayName) => active === name,
    [active]
  )

  const hasAny = active !== null

  return { active, push, pop, closeAll, isActive, hasAny }
}
