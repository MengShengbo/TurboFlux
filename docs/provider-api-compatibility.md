# Provider model and API compatibility

This page records the provider surface shipped by TurboFlux and the request
adaptations applied by the runtime. The model list is reviewed against the
provider documentation linked below (review date: 2026-08-01). Runtime model
discovery can still add newer gateway-specific IDs at startup.

## Supported provider presets

| Provider | Current preset model | Other registered models | Primary endpoint | Wire protocols |
| --- | --- | --- | --- | --- |
| OpenAI | `gpt-5.6` | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4` | `https://api.openai.com/v1` | Responses, Chat Completions |
| Anthropic | `claude-opus-4-8` | `claude-opus-5`, `claude-fable-5`, `claude-mythos-5`, `claude-mythos-preview`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`, Opus/Sonnet 4.x entries | `https://api.anthropic.com/v1` | Messages, Chat/Responses fallback |
| DeepSeek | `deepseek-v4-flash` | `deepseek-v4-pro` | `https://api.deepseek.com` | Chat; Flash may use Responses; Anthropic compatibility |
| Kimi | `kimi-k3` | `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, `kimi-k2.5` | `https://api.moonshot.cn/v1` | Chat Completions, Responses fallback |
| GLM | `glm-5.2` | `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.6`, `glm-4.5` | `https://open.bigmodel.cn/api/paas/v4` | Chat Completions |
| OpenRouter | `gpt-5.5` | Any model returned by `/models` or `models.dev` | `https://openrouter.ai/api/v1` | Chat/Responses, gateway-dependent |
| Custom | user supplied | Runtime discovery | user supplied | Bounded protocol probing |

The Anthropic preset remains on `claude-opus-4-8` for configuration stability;
`claude-opus-5` is available explicitly and through model discovery.

## Request adaptations

### OpenAI

- GPT-5 and reasoning-class models prefer `/responses`; the runtime converts
  chat history and function tools to `input` and Responses items.
- Responses requests use `max_output_tokens`, `reasoning.effort`, and a
  detailed reasoning summary when the model advertises those fields.
- Chat fallback retains `stream_options.include_usage` for token telemetry.

### Anthropic

- Messages requests send `system`, `messages`, `tools`, and cache breakpoints
  using the Anthropic schema.
- Adaptive-thinking models use `output_config.effort`. For Claude Opus 5 at
  `xhigh` or `max`, TurboFlux sends `thinking: { type: "disabled" }` with the
  effort field because that combination is rejected by the provider schema.

### DeepSeek

- V4 Flash uses Chat first and can fall back to Responses. V4 Pro does not
  probe Responses because the current DeepSeek documentation only declares
  Responses support for Flash.
- Anthropic fallback is sent to
  `https://api.deepseek.com/anthropic/v1/messages` (or the equivalent custom
  host path), with both `x-api-key` and Bearer authentication headers.
- Thinking content is preserved between turns and provider cache usage fields
  are normalized into TurboFlux token telemetry.

### Kimi

- K3 and newer Moonshot routes prefer `max_completion_tokens` on Chat
  Completions. If a compatible gateway only accepts the legacy field,
  TurboFlux retries with `max_tokens`.
- Fixed-thinking K2.7 routes keep reasoning with `thinking: { type: "enabled",
  keep: "all" }`; K3 exposes the registered low/high/max effort choices.
- `prompt_cache_key` is sent for Kimi Chat and Responses requests and is
  removed automatically when a gateway rejects it.

### GLM and OpenRouter

- GLM uses the OpenAI Chat schema and provider-native thinking toggles.
- OpenRouter receives `HTTP-Referer` and `X-Title` headers, while model IDs and
  capabilities are refreshed from `/models` and `models.dev` when available.

## Official documentation

- [OpenAI models](https://developers.openai.com/api/docs/models), [Chat Completions](https://platform.openai.com/docs/api-reference/chat), and [Responses](https://platform.openai.com/docs/api-reference/responses)
- [Anthropic models](https://docs.anthropic.com/en/docs/about-claude/models), [Messages API](https://docs.anthropic.com/en/api/messages), and [extended/adaptive thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- [DeepSeek API overview](https://api-docs.deepseek.com/), [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion), [Anthropic compatibility](https://api-docs.deepseek.com/guides/anthropic_api), and [model/pricing](https://api-docs.deepseek.com/quick_start/pricing)
- [Kimi API overview](https://platform.moonshot.cn/docs/guide/start-using-kimi-api), [Chat API](https://platform.moonshot.cn/docs/api/chat), and [thinking models](https://platform.moonshot.cn/docs/guide/using-reasoning-models)
- [GLM API](https://open.bigmodel.cn/dev/api), [Chat Completions](https://open.bigmodel.cn/dev/api#chatglm), and [model catalog](https://open.bigmodel.cn/dev/model)
- [OpenRouter API](https://openrouter.ai/docs/api-reference/overview) and [model catalog](https://openrouter.ai/models)

When a provider changes a field or endpoint, update `modelRegistry.ts`,
`modelProtocol.ts`, and `requestCompatibility.ts` together, then add a focused
fixture to the corresponding Vitest file.
