export interface ConversationNavigatorTaskItem {
  kind: 'input' | 'answer'
  runId: string
  finalDelivery?: boolean
}

export interface ConversationNavigatorTaskPair {
  inputIndex: number
  answerIndex?: number
}

export interface ConversationNavigatorMarkerVisual {
  opacity: number
  scaleX: number
  tone: 'focus' | 'near' | 'mid' | 'far' | 'idle'
}

export const conversationNavigatorMinimumItems = 4

export function compactConversationNavigatorText(value: string, limit = 110): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

export function conversationNavigatorMarkerVisual(
  itemIndex: number,
  interactionIndex?: number,
): ConversationNavigatorMarkerVisual {
  if (interactionIndex === undefined) return { opacity: 0.4, scaleX: 0.2308, tone: 'idle' }
  const distance = Math.abs(itemIndex - interactionIndex)
  if (distance === 0) return { opacity: 1, scaleX: 1, tone: 'focus' }
  if (distance === 1) return { opacity: 0.4, scaleX: 0.7692, tone: 'near' }
  if (distance === 2) return { opacity: 0.4, scaleX: 0.5385, tone: 'mid' }
  if (distance === 3) return { opacity: 0.4, scaleX: 0.3846, tone: 'far' }
  return { opacity: 0.4, scaleX: 0.2308, tone: 'idle' }
}

export function activeConversationNavigatorIndices(
  offsets: number[],
  scrollTop: number,
  clientHeight: number,
  topInset = 16,
): number[] {
  const viewportTop = scrollTop + topInset
  const viewportBottom = scrollTop + clientHeight
  return offsets.flatMap((offset, index) => {
    const nextOffset = offsets[index + 1] ?? Number.POSITIVE_INFINITY
    return offset < viewportBottom && nextOffset > viewportTop ? [index] : []
  })
}

export function pairConversationNavigatorTasks(
  items: ConversationNavigatorTaskItem[],
): ConversationNavigatorTaskPair[] {
  const inputs = items.flatMap((item, index) => item.kind === 'input' ? [{ index }] : [])
  return inputs.map(({ index: inputIndex }, inputPosition) => {
    const nextInputIndex = inputs[inputPosition + 1]?.index ?? items.length
    const answers = items
      .map((item, index) => ({ item, index }))
      .filter(candidate => (
        candidate.item.kind === 'answer'
        && candidate.index > inputIndex
        && candidate.index < nextInputIndex
      ))
    const finalAnswer = [...answers].reverse().find(candidate => candidate.item.finalDelivery)
      || answers.at(-1)
    return {
      inputIndex,
      answerIndex: finalAnswer?.index,
    }
  })
}
