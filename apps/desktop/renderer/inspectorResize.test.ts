import { describe, expect, it } from 'vitest'
import {
  INSPECTOR_DISMISS_WIDTH,
  INSPECTOR_MINIMUM_WIDTH,
  clampInspectorWidth,
  defaultInspectorWidth,
  inspectorDismissTriggerX,
  inspectorWidthFromRatio,
  inspectorWidthFromKey,
  inspectorWidthRatio,
  maximumInspectorWidth,
  shouldDismissInspectorAtPointer,
} from './inspectorResize'

describe('inspector resize interaction', () => {
  it('uses responsive defaults and hard width bounds', () => {
    expect(defaultInspectorWidth(1_160, 900)).toBe(660)
    expect(defaultInspectorWidth(720, 700)).toBe(368)
    expect(maximumInspectorWidth(720)).toBe(368)
    expect(clampInspectorWidth(100, 720)).toBe(INSPECTOR_MINIMUM_WIDTH)
    expect(clampInspectorWidth(900, 720)).toBe(368)
  })

  it('uses separate regular and full width modes', () => {
    expect(maximumInspectorWidth(1_200)).toBe(848)
    expect(maximumInspectorWidth(1_200, 'full')).toBe(1_200)
    expect(clampInspectorWidth(1_400, 1_200)).toBe(848)
    expect(clampInspectorWidth(1_400, 1_200, 'full')).toBe(1_200)
  })

  it('dismisses only inside the production half-minimum threshold', () => {
    const trigger = inspectorDismissTriggerX(700, 500)
    expect(trigger).toBe(700 + 500 - INSPECTOR_DISMISS_WIDTH)
    expect(shouldDismissInspectorAtPointer(trigger - 1, trigger)).toBe(false)
    expect(shouldDismissInspectorAtPointer(trigger, trigger)).toBe(true)
    expect(shouldDismissInspectorAtPointer(trigger + 120, trigger)).toBe(true)
  })

  it('widens left and narrows right in ten pixel steps', () => {
    expect(inspectorWidthFromKey(600, 'ArrowLeft', false, 1_160)).toBe(610)
    expect(inspectorWidthFromKey(600, 'ArrowRight', false, 1_160)).toBe(590)
    expect(inspectorWidthFromKey(600, 'ArrowLeft', true, 1_160)).toBe(610)
    expect(inspectorWidthFromKey(600, 'ArrowRight', true, 1_160)).toBe(590)
  })

  it('uses Home and End for the hard bounds', () => {
    expect(inspectorWidthFromKey(500, 'Home', false, 1_160)).toBe(320)
    expect(inspectorWidthFromKey(500, 'End', false, 1_160)).toBe(808)
    expect(inspectorWidthFromKey(320, 'ArrowRight', true, 1_160)).toBe(320)
    expect(inspectorWidthFromKey(800, 'ArrowLeft', true, 1_160)).toBe(808)
    expect(inspectorWidthFromKey(1_100, 'ArrowLeft', true, 1_160, 'full')).toBe(1_110)
    expect(inspectorWidthFromKey(600, 'Enter', false, 1_160)).toBeNull()
  })

  it('persists a normalized regular-width ratio', () => {
    const ratio = inspectorWidthRatio(640, 1_160)
    expect(ratio).toBeCloseTo(.656, 2)
    expect(inspectorWidthFromRatio(ratio, 1_160)).toBe(640)
    expect(inspectorWidthFromRatio(ratio, 1_520)).toBeGreaterThan(640)
  })
})
