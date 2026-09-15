import { describe, expect, it } from 'vitest'
import type { WorkbenchSnapshot } from '@turboflux/agent-core/workbench'
import {
  visualEvidenceItems,
  visualEvidenceLabel,
  visualEvidenceSignature,
  visualEvidenceSource,
} from './visualEvidence'

type ArtifactRecord = WorkbenchSnapshot['artifacts']['artifacts'][number]

function artifact(input: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'id' | 'updatedAt'>): ArtifactRecord {
  return {
    id: input.id,
    name: input.name || `${input.id}.png`,
    path: input.path || `/workspace/${input.id}.png`,
    workspacePath: '/workspace',
    kind: input.kind || 'image',
    mime: input.mime || 'image/png',
    size: input.size || 100,
    source: input.source || 'agent',
    createdAt: input.createdAt || input.updatedAt,
    updatedAt: input.updatedAt,
    available: input.available ?? true,
    conversationId: input.conversationId,
    metadata: input.metadata,
  }
}

describe('visual evidence presentation', () => {
  it('recognizes browser and computer screenshots without treating ordinary images as evidence', () => {
    expect(visualEvidenceSource(artifact({ id: 'browser', updatedAt: 100, source: 'browser' }))).toBe('browser')
    expect(visualEvidenceSource(artifact({ id: 'browser-agent', updatedAt: 100, source: 'agent', metadata: { browserTabId: 'tab-1' } }))).toBe('browser')
    expect(visualEvidenceSource(artifact({ id: 'computer', updatedAt: 100, metadata: { visualSource: 'computer' } }))).toBe('computer')
    expect(visualEvidenceSource(artifact({ id: 'upload', updatedAt: 100, source: 'import' }))).toBeNull()
  })

  it('keeps evidence in its conversation and execution time range', () => {
    const items = visualEvidenceItems([
      artifact({ id: 'browser', updatedAt: 120, source: 'browser', conversationId: 'conversation-1', metadata: { browserTitle: 'TurboFlux', browserUrl: 'https://turboflux.dev' } }),
      artifact({ id: 'computer', updatedAt: 140, conversationId: 'conversation-1', metadata: { visualSource: 'computer', capturedAt: 135, computerAppName: 'Keynote', computerWindowTitle: 'Research Deck' } }),
      artifact({ id: 'other-task', updatedAt: 10_000, source: 'browser', conversationId: 'conversation-1' }),
      artifact({ id: 'other-conversation', updatedAt: 130, source: 'browser', conversationId: 'conversation-2' }),
    ], { conversationId: 'conversation-1', startedAt: 100, completedAt: 200 })

    expect(items).toEqual([
      expect.objectContaining({ artifactId: 'browser', source: 'browser', title: 'TurboFlux' }),
      expect.objectContaining({ artifactId: 'computer', source: 'computer', title: 'Keynote', detail: 'Research Deck' }),
    ])
    expect(visualEvidenceLabel(items)).toBe('视觉证据')
    expect(visualEvidenceSignature(items)).toContain('browser:120')
  })

  it('excludes unavailable image records', () => {
    expect(visualEvidenceItems([
      artifact({ id: 'missing', updatedAt: 120, source: 'browser', available: false }),
    ], { conversationId: 'conversation-1', startedAt: 100 })).toEqual([])
  })

})
