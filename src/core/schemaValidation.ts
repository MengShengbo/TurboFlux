export interface SchemaValidationResult {
  valid: boolean
  error?: string
}

export function validateSchemaValue(
  schema: Record<string, unknown>,
  value: unknown,
  path = '',
): SchemaValidationResult {
  const location = path || 'arguments'
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null
  if (alternatives) {
    const accepted = alternatives.some(candidate =>
      candidate && typeof candidate === 'object'
      && validateSchemaValue(candidate as Record<string, unknown>, value, path).valid
    )
    return accepted
      ? { valid: true }
      : { valid: false, error: `Invalid value for ${location}: no schema alternative matched` }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => Object.is(candidate, value))) {
    return { valid: false, error: `Invalid value for ${location}: expected one of ${schema.enum.map(String).join(', ')}` }
  }

  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (declaredTypes.length > 0 && !declaredTypes.some(type => schemaTypeMatches(String(type), value))) {
    return { valid: false, error: `Invalid type for ${location}: expected ${declaredTypes.join(' or ')}` }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return { valid: false, error: `Invalid value for ${location}: expected at least ${schema.minLength} characters` }
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return { valid: false, error: `Invalid value for ${location}: expected at most ${schema.maxLength} characters` }
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          return { valid: false, error: `Invalid value for ${location}: does not match the required pattern` }
        }
      } catch {
        return { valid: false, error: `Invalid schema pattern for ${location}` }
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { valid: false, error: `Invalid value for ${location}: expected at least ${schema.minimum}` }
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { valid: false, error: `Invalid value for ${location}: expected at most ${schema.maximum}` }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return { valid: false, error: `Invalid value for ${location}: expected at least ${schema.minItems} item(s)` }
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return { valid: false, error: `Invalid value for ${location}: expected at most ${schema.maxItems} item(s)` }
    }
    if (schema.items && typeof schema.items === 'object') {
      for (let index = 0; index < value.length; index += 1) {
        const result = validateSchemaValue(schema.items as Record<string, unknown>, value[index], `${location}[${index}]`)
        if (!result.valid) return result
      }
    }
  }

  const isObjectSchema = declaredTypes.includes('object') || (!schema.type && schema.properties && typeof schema.properties === 'object')
  if (isObjectSchema && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, unknown>
      : {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : []
    for (const name of required) {
      if (record[name] === undefined || record[name] === null) {
        return { valid: false, error: `Missing required parameter: ${path ? `${path}.` : ''}${name}` }
      }
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(record).find(name => !(name in properties))
      if (unexpected) return { valid: false, error: `Unexpected parameter: ${path ? `${path}.` : ''}${unexpected}` }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (record[name] === undefined || !propertySchema || typeof propertySchema !== 'object') continue
      const result = validateSchemaValue(propertySchema as Record<string, unknown>, record[name], path ? `${path}.${name}` : name)
      if (!result.valid) return result
    }
  }

  return { valid: true }
}

function schemaTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'null': return value === null
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'array': return Array.isArray(value)
    case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    default: return true
  }
}
