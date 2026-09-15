import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('remote service worker cache policy', () => {
  it('purges older caches and never caches query-string pairing URLs', () => {
    const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')

    expect(worker).toContain("const CACHE = 'turboflux-remote-v3'")
    expect(worker).toContain('keys.filter(key => key !== CACHE)')
    expect(worker).toContain("requestUrl.searchParams.has('pair')")
    expect(worker.indexOf("requestUrl.searchParams.has('pair')")).toBeLessThan(worker.indexOf('cache.put(event.request, copy)'))
  })
})
