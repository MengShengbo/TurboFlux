import { describe, expect, it } from 'vitest'
import { resolveProfileFeatureFlags, STABLE_PROFILE_FEATURE_FLAGS } from './profileFeatureFlags'

describe('profile release feature flags', () => {
  it('enables every Stable profile capability by default', () => {
    expect(resolveProfileFeatureFlags({})).toEqual(STABLE_PROFILE_FEATURE_FLAGS)
  })

  it('accepts the three V2 release-channel overrides', () => {
    expect(resolveProfileFeatureFlags({
      TURBOFLUX_CONVERSATION_DATA_V2: 'true',
      TURBOFLUX_PROFILE_CENTER_V2: 'no',
      TURBOFLUX_PROFILE_ARCHIVE_V2: 'off',
    })).toEqual({
      conversationDataV2: true,
      profileCenterV2: false,
      profileArchiveV2: false,
    })
  })

  it('maps legacy V1 gates fail closed while V2 overrides take precedence', () => {
    expect(resolveProfileFeatureFlags({
      TURBOFLUX_PROFILE_STORAGE_V1: '0',
      TURBOFLUX_LOCAL_PROFILES_UI_V1: 'off',
      TURBOFLUX_PROFILE_ARCHIVE_EXPORT_V1: 'true',
      TURBOFLUX_PROFILE_ARCHIVE_IMPORT_V1: 'false',
    })).toEqual({ conversationDataV2: false, profileCenterV2: false, profileArchiveV2: false })
    expect(resolveProfileFeatureFlags({
      TURBOFLUX_CONVERSATION_DATA_V2: 'true',
      TURBOFLUX_PROFILE_STORAGE_V1: 'false',
    }).conversationDataV2).toBe(true)
  })

  it('fails closed for an invalid flag value', () => {
    expect(() => resolveProfileFeatureFlags({ TURBOFLUX_PROFILE_ARCHIVE_V2: 'maybe' })).toThrow('must be true or false')
    expect(() => resolveProfileFeatureFlags({ TURBOFLUX_PROFILE_ARCHIVE_IMPORT_V1: 'maybe' })).toThrow('must be true or false')
  })
})
