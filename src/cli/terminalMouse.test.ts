import { describe, expect, it } from 'vitest'
import { isTerminalMouseInput, parseTerminalMouseWheel, shouldEnableMouseTracking } from './terminalMouse'

describe('terminal mouse wheel parsing', () => {
  it('parses SGR wheel events with or without the leading escape byte', () => {
    expect(parseTerminalMouseWheel('\u001b[<64;40;12M')).toEqual([{ direction: 'up', x: 40, y: 12 }])
    expect(parseTerminalMouseWheel('[<65;41;13M')).toEqual([{ direction: 'down', x: 41, y: 13 }])
  })

  it('ignores mouse clicks while identifying mouse input', () => {
    expect(isTerminalMouseInput('[<0;10;5M')).toBe(true)
    expect(parseTerminalMouseWheel('[<0;10;5M')).toEqual([])
  })

  it('enables tracking only for compatible fixed interactive sessions', () => {
    expect(shouldEnableMouseTracking(true, true, {})).toBe(true)
    expect(shouldEnableMouseTracking(false, true, {})).toBe(false)
    expect(shouldEnableMouseTracking(true, false, {})).toBe(false)
    expect(shouldEnableMouseTracking(true, true, { TERM: 'dumb' })).toBe(false)
    expect(shouldEnableMouseTracking(true, true, { TURBOFLUX_MOUSE: '0' })).toBe(false)
  })
})
