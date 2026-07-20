import { describe, expect, it } from 'vitest'
import {
  clampTranscriptScroll,
  getTranscriptPageRows,
  getTranscriptViewportWindow,
  preserveTranscriptAnchor,
  revealTranscriptRange,
} from './TranscriptViewport'

describe('row-level transcript viewport', () => {
  it('moves continuously through one oversized message', () => {
    expect(getTranscriptViewportWindow(20, 5, 0)).toMatchObject({
      topRow: 15,
      bottomRow: 20,
      scrollRowsFromBottom: 0,
    })
    expect(getTranscriptViewportWindow(20, 5, 3)).toMatchObject({
      topRow: 12,
      bottomRow: 17,
      scrollRowsFromBottom: 3,
    })
  })

  it('uses one stable row interval across mixed message heights', () => {
    const messageRows = [2, 7, 3, 9]
    const contentRows = messageRows.reduce((total, rows) => total + rows, 0)

    expect(getTranscriptViewportWindow(contentRows, 8, 6)).toMatchObject({
      topRow: 7,
      bottomRow: 15,
    })
  })

  it('keeps the visual top row anchored when output appends', () => {
    const nextOffset = preserveTranscriptAnchor(8, 20, 26)

    expect(nextOffset).toBe(14)
    expect(getTranscriptViewportWindow(30, 10, 8).topRow).toBe(12)
    expect(getTranscriptViewportWindow(36, 10, nextOffset).topRow).toBe(12)
  })

  it('follows new output while already at the bottom', () => {
    expect(preserveTranscriptAnchor(0, 20, 26)).toBe(0)
  })

  it('clamps wheel movement and returns exactly to the bottom', () => {
    expect(clampTranscriptScroll(3, 10)).toBe(3)
    expect(clampTranscriptScroll(13, 10)).toBe(10)
    expect(clampTranscriptScroll(-3, 10)).toBe(0)
  })

  it('uses half-page keyboard movement', () => {
    expect(getTranscriptPageRows(24)).toBe(12)
    expect(getTranscriptPageRows(1)).toBe(1)
  })

  it('reveals a selected message above or below the current window', () => {
    expect(revealTranscriptRange(0, 30, 10, 5, 2)).toBe(25)
    expect(revealTranscriptRange(20, 30, 10, 28, 4)).toBe(8)
    expect(revealTranscriptRange(10, 30, 10, 22, 3)).toBe(10)
  })
})
