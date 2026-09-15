export interface BrowserFrameElementBatch<T> {
  frameIndex: number
  elements: T[]
}

export interface BrowserFrameElement<T> {
  frameIndex: number
  element: T
}

export interface BrowserRetainedTab {
  id: string
  retention: 'transient' | 'deliverable' | 'handoff'
}

export function browserFrameRefPrefix(observationEpoch: number, frameIndex: number): string {
  return `o${observationEpoch.toString(36)}-r${frameIndex.toString(36)}`
}

export function isBrowserRefForEpoch(ref: string, observationEpoch: number): boolean {
  return ref.startsWith(`o${observationEpoch.toString(36)}-`)
}

export function interleaveBrowserFrameElements<T>(
  batches: BrowserFrameElementBatch<T>[],
  maximum: number,
): BrowserFrameElement<T>[] {
  const limit = Math.max(0, Math.floor(maximum))
  const merged: BrowserFrameElement<T>[] = []
  const longest = batches.reduce((length, batch) => Math.max(length, batch.elements.length), 0)
  for (let elementIndex = 0; elementIndex < longest && merged.length < limit; elementIndex += 1) {
    for (const batch of batches) {
      const element = batch.elements[elementIndex]
      if (element === undefined) continue
      merged.push({ frameIndex: batch.frameIndex, element })
      if (merged.length >= limit) break
    }
  }
  return merged
}

export function transientBrowserTabIds(tabs: BrowserRetainedTab[]): string[] {
  return tabs.filter(tab => tab.retention === 'transient').map(tab => tab.id)
}
