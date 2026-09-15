import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { profileQaPathOverride } from './profileQaPathOverrides'

describe('profile QA path overrides', () => {
  it('returns absolute paths only in hidden Desktop QA mode', () => {
    const archivePath = resolve('profile-qa', 'profile.turboflux-profile')
    expect(profileQaPathOverride({
      TURBOFLUX_DESKTOP_QA_HIDDEN: '1',
      TURBOFLUX_DESKTOP_QA_PROFILE_EXPORT_PATH: archivePath,
    }, 'export')).toBe(archivePath)
  })

  it('never exposes overrides to normal Desktop runs', () => {
    expect(profileQaPathOverride({
      TURBOFLUX_DESKTOP_QA_PROFILE_IMPORT_PATH: '/tmp/profile.turboflux-profile',
    }, 'import')).toBeUndefined()
    expect(profileQaPathOverride({
      TURBOFLUX_DESKTOP_QA_HIDDEN: '0',
      TURBOFLUX_DESKTOP_QA_PROFILE_REBIND_PATH: '/tmp/workspace',
    }, 'rebind')).toBeUndefined()
  })

  it('rejects empty and relative paths', () => {
    expect(profileQaPathOverride({
      TURBOFLUX_DESKTOP_QA_HIDDEN: '1',
      TURBOFLUX_DESKTOP_QA_PROFILE_EXPORT_PATH: 'profile.turboflux-profile',
    }, 'export')).toBeUndefined()
    expect(profileQaPathOverride({
      TURBOFLUX_DESKTOP_QA_HIDDEN: '1',
      TURBOFLUX_DESKTOP_QA_PROFILE_IMPORT_PATH: '   ',
    }, 'import')).toBeUndefined()
  })
})
