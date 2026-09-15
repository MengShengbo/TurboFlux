import {
  ModelProtocolRequestError,
  formatProtocolAttempt,
  formatProtocolFailure,
  protocolLabel,
  shouldFallbackProtocol,
  toProtocolAttempt,
  type ModelProtocol,
  type ModelProtocolAttempt,
} from './modelProtocol'

export interface ModelProtocolFallback {
  attempt: ModelProtocolAttempt
  nextProtocol: ModelProtocol
  nextUrl: string
  message: string
}

export interface ModelRequestOrchestratorOptions<Result> {
  protocols: readonly ModelProtocol[]
  urlFor(protocol: ModelProtocol): string
  invoke(protocol: ModelProtocol): Promise<Result>
  isAborted(error: unknown): boolean
  shouldRetry(error: ModelProtocolRequestError): boolean
  waitForRetry(error: ModelProtocolRequestError): Promise<void>
  onAttempt?(protocol: ModelProtocol, url: string): void
  onSuccess?(protocol: ModelProtocol, url: string): void
  onFallback?(fallback: ModelProtocolFallback): void
}

export async function runModelRequest<Result>(
  options: ModelRequestOrchestratorOptions<Result>,
): Promise<Result> {
  const attempts: ModelProtocolAttempt[] = []

  for (let index = 0; index < options.protocols.length; index += 1) {
    const protocol = options.protocols[index]
    const url = options.urlFor(protocol)
    options.onAttempt?.(protocol, url)

    try {
      const result = await options.invoke(protocol)
      options.onSuccess?.(protocol, url)
      return result
    } catch (error) {
      if (options.isAborted(error)) throw error

      const protocolError = error instanceof ModelProtocolRequestError
        ? error
        : new ModelProtocolRequestError(error instanceof Error ? error.message : String(error), {
          protocol,
          url,
          kind: 'internal',
        })

      if (options.shouldRetry(protocolError)) {
        await options.waitForRetry(protocolError)
        index -= 1
        continue
      }

      const attempt = toProtocolAttempt(protocolError)
      attempts.push(attempt)
      const nextProtocol = options.protocols[index + 1]
      if (!nextProtocol || !shouldFallbackProtocol(protocolError)) {
        throw new Error(formatProtocolFailure(attempts), { cause: error })
      }

      options.onFallback?.({
        attempt,
        nextProtocol,
        nextUrl: options.urlFor(nextProtocol),
        message: `${formatProtocolAttempt(attempt)}; retrying with ${protocolLabel(nextProtocol)}`,
      })
    }
  }

  throw new Error(formatProtocolFailure(attempts))
}
