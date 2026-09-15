import { describe, expect, it } from 'vitest'
import { shouldInvalidateSavedPairing, terminalAuthorizationFailure } from './recoveryPolicy'

describe('remote pairing recovery policy', () => {
  it('preserves saved device credentials for transient connectivity failures', () => {
    expect(shouldInvalidateSavedPairing(new TypeError('Failed to fetch'))).toBe(false)
    expect(shouldInvalidateSavedPairing(new Error('The network connection was lost'))).toBe(false)
  })

  it('clears credentials only for terminal authorization or saved-state failures', () => {
    expect(terminalAuthorizationFailure(new Error('Remote device is not paired'))).toBe(true)
    expect(shouldInvalidateSavedPairing(new Error('Saved remote pairing is invalid or expired'))).toBe(true)
    expect(shouldInvalidateSavedPairing(new Error('Saved remote connection has an unsupported format'))).toBe(true)
  })
})
