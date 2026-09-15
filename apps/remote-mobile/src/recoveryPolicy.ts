function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function terminalAuthorizationFailure(error: unknown): boolean {
  return /not paired|grant (?:was |is |has )?(?:been )?(?:revoked|expired|unavailable)|capability grant.*(?:expired|unavailable)|saved remote pairing is invalid/iu.test(errorMessage(error))
}

export function shouldInvalidateSavedPairing(error: unknown): boolean {
  return terminalAuthorizationFailure(error)
    || /saved remote connection (?:has an unsupported format|is invalid)/iu.test(errorMessage(error))
}
