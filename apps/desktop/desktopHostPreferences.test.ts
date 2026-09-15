import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  effectiveCloseWindowBehavior,
  loadDesktopHostPreferences,
  saveDesktopHostPreferences,
} from './desktopHostPreferences'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('desktop host preferences', () => {
  it('uses explicit platform defaults without hiding their meaning', () => {
    const preferences = loadDesktopHostPreferences('/missing/desktop-host-preferences.json')
    expect(effectiveCloseWindowBehavior(preferences, 'darwin')).toBe('keep-running')
    expect(effectiveCloseWindowBehavior(preferences, 'win32')).toBe('quit')
  })

  it('persists normalized close and active-run quit behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-host-preferences-'))
    directories.push(root)
    const path = join(root, 'desktop-host.json')
    expect(saveDesktopHostPreferences(path, { closeWindowBehavior: 'keep-running', activeRunQuitBehavior: 'wait' })).toEqual({
      schemaVersion: 1,
      closeWindowBehavior: 'keep-running',
      activeRunQuitBehavior: 'wait',
    })
    expect(loadDesktopHostPreferences(path)).toMatchObject({ closeWindowBehavior: 'keep-running', activeRunQuitBehavior: 'wait' })
  })
})
