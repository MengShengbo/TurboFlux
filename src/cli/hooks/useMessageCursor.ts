import { useState, useCallback, useRef } from 'react'
import type { Message } from '../components/messages/Messages'

export interface MessageCursor {
  index: number
  expanded: boolean
}

export function useMessageCursor(messages: Message[]) {
  const [cursor, setCursor] = useState<MessageCursor | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const enter = useCallback(() => {
    setCursor(prev => {
      if (!prev) {
        // Enter cursor at last user message
        for (let i = messagesRef.current.length - 1; i >= 0; i--) {
          if (messagesRef.current[i]?.role === 'user') {
            return { index: i, expanded: false }
          }
        }
        return messagesRef.current.length > 0
          ? { index: messagesRef.current.length - 1, expanded: false }
          : null
      }
      return { ...prev, expanded: !prev.expanded }
    })
  }, [])

  const navigatePrev = useCallback(() => {
    setCursor(prev => {
      if (!prev) return null
      return { ...prev, index: Math.max(0, prev.index - 1) }
    })
  }, [])

  const navigateNext = useCallback(() => {
    setCursor(prev => {
      if (!prev) return null
      return { ...prev, index: Math.min(messagesRef.current.length - 1, prev.index + 1) }
    })
  }, [])

  const navigatePrevUser = useCallback(() => {
    setCursor(prev => {
      if (!prev) return null
      for (let i = prev.index - 1; i >= 0; i--) {
        if (messagesRef.current[i]?.role === 'user') {
          return { ...prev, index: i }
        }
      }
      return prev
    })
  }, [])

  const navigateNextUser = useCallback(() => {
    setCursor(prev => {
      if (!prev) return null
      for (let i = prev.index + 1; i < messagesRef.current.length; i++) {
        if (messagesRef.current[i]?.role === 'user') {
          return { ...prev, index: i }
        }
      }
      return prev
    })
  }, [])

  const clear = useCallback(() => setCursor(null), [])

  const toggleExpand = useCallback(() => {
    setCursor(prev => (prev ? { ...prev, expanded: !prev.expanded } : null))
  }, [])

  return {
    cursor,
    setCursor,
    enter,
    navigatePrev,
    navigateNext,
    navigatePrevUser,
    navigateNextUser,
    clear,
    toggleExpand,
  }
}
