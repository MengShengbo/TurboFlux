import { createHash } from 'node:crypto'

export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue }

function normalize(value: unknown, seen: Set<object>): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.normalize('NFC')
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot encode non-finite numbers')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') throw new TypeError(`Canonical JSON cannot encode ${typeof value}`)
  if (seen.has(value)) throw new TypeError('Canonical JSON cannot encode cyclic values')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => normalize(item, seen))
    const record = value as Record<string, unknown>
    const result: Record<string, CanonicalJsonValue> = {}
    for (const key of Object.keys(record).sort()) {
      const child = record[key]
      if (child === undefined) continue
      result[key.normalize('NFC')] = normalize(child, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()))
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8')
}

export function canonicalJsonDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonBytes(value)).digest('hex')
}
