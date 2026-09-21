export const DEFAULT_REQUEST_MAX_TOKENS = 16_384

export function resolveRequestMaxTokens(
  configuredMaxTokens: number | undefined,
  modelMaxOutputTokens?: number,
): number {
  const requested = positiveInteger(configuredMaxTokens)
  const outputLimit = positiveInteger(modelMaxOutputTokens)
  if (requested !== undefined && outputLimit !== undefined) return Math.min(requested, outputLimit)
  return requested ?? outputLimit ?? DEFAULT_REQUEST_MAX_TOKENS
}

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}
