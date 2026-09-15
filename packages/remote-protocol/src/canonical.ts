export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

function canonicalValue(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Value is not JSON serializable')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item)).join(',')}]`
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalValue(child)}`)
  return `{${entries.join(',')}}`
}

export function canonicalStringify(value: JsonValue): string {
  return canonicalValue(value)
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
