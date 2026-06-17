import { useState, useEffect, useRef } from 'react'

export function useElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number>(Date.now())

  useEffect(() => {
    if (!running) {
      setElapsed(0)
      return
    }
    startRef.current = Date.now()
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [running])

  return elapsed
}
