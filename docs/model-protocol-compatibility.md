# Model protocol compatibility

TurboFlux supports three HTTP model protocols through one bounded compatibility layer:

| Protocol | Endpoint | Primary request field | Stream shape |
| --- | --- | --- | --- |
| Anthropic Messages | `/v1/messages` | `messages` plus top-level `system` | `message_*` and `content_block_*` events |
| OpenAI Chat Completions | `/v1/chat/completions` | `messages` | `choices[].delta` chunks |
| OpenAI Responses | `/v1/responses` | `input` plus `instructions` | typed `response.*` events |

## Candidate order

- Anthropic configurations and model IDs containing `claude` try Messages, Chat Completions, then Responses.
- Other configurations try Chat Completions, Responses, then Messages.
- A successful subagent protocol is retained for later turns so it does not probe again on every tool round-trip.

Provider configuration selects the first candidate; it does not permanently lock a custom proxy to one wire format.

## Retry safety

- `408`, `409`, `425`, `429`, transient network failures, and `5xx` responses retry only the same request protocol.
- `404`, `405`, and `415` can move to the next protocol when no response bytes were received.
- `400` and `422` move only when the response explicitly identifies an endpoint, schema, header, or request-field mismatch.
- `401` and `403` never move to another protocol because changing the request body cannot repair credentials or authorization.
- Once any stream bytes arrive, TurboFlux does not cross protocols. This prevents duplicate billing, duplicate output, and repeated tool side effects.
- Messages and OpenAI-compatible requests can first remove rejected optional fields such as cache controls, reasoning options, temperature, or prompt-cache hints and retry the same endpoint.

Every final request error lists the protocol, exact URL, HTTP status, and compact upstream detail for each attempt. A successful cross-protocol retry also emits a visible fallback notice.

## References

- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages)
- [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
