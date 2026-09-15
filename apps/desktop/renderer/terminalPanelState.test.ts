import { describe, expect, it } from 'vitest'
import {
  TERMINAL_PANEL_DEFAULT_HEIGHT,
  TERMINAL_PANEL_MINIMUM_HEIGHT,
  clampTerminalPanelHeight,
  maximumTerminalPanelHeight,
  terminalPanelHeightFromKey,
  terminalPanelHeightFromPointer,
} from './terminalPanelState'

describe('terminal panel resizing', () => {
  it('keeps enough conversation space while clamping the terminal height', () => {
    expect(clampTerminalPanelHeight(20, 800)).toBe(TERMINAL_PANEL_MINIMUM_HEIGHT)
    expect(clampTerminalPanelHeight(TERMINAL_PANEL_DEFAULT_HEIGHT, 800)).toBe(TERMINAL_PANEL_DEFAULT_HEIGHT)
    expect(clampTerminalPanelHeight(900, 800)).toBe(maximumTerminalPanelHeight(800))
  })

  it('grows upward and supports accessible keyboard resizing', () => {
    expect(terminalPanelHeightFromPointer(280, 600, 540, 800)).toBe(340)
    expect(terminalPanelHeightFromPointer(280, 600, 660, 800)).toBe(220)
    expect(terminalPanelHeightFromKey(280, 'ArrowUp', 800)).toBe(300)
    expect(terminalPanelHeightFromKey(280, 'ArrowDown', 800)).toBe(260)
    expect(terminalPanelHeightFromKey(280, 'Home', 800)).toBe(TERMINAL_PANEL_MINIMUM_HEIGHT)
    expect(terminalPanelHeightFromKey(280, 'End', 800)).toBe(maximumTerminalPanelHeight(800))
  })
})
