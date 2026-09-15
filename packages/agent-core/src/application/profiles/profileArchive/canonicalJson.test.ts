import { describe, expect, it } from 'vitest'
import { canonicalJson, canonicalJsonDigest } from './canonicalJson'

describe('profile archive canonical JSON', () => {
  it('sorts keys, normalizes text, and omits undefined object values', () => {
    expect(canonicalJson({ z: undefined, b: 'e\u0301', a: { d: 2, c: -0 } })).toBe('{"a":{"c":0,"d":2},"b":"é"}')
    expect(canonicalJsonDigest({ b: 2, a: 1 })).toBe(canonicalJsonDigest({ a: 1, b: 2 }))
  })

  it('rejects cycles and non-finite numbers', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow('cyclic')
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow('non-finite')
  })
})
