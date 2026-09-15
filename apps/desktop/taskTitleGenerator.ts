import type { TurboFluxConfig } from '@turboflux/agent-core/workbench'
import { fallbackTaskTitle, isPlaceholderTaskTitle } from './conversationPolicy'

export interface TaskTitleGenerationInput {
  currentTitle: string
  prompts: string[]
}

function modelEndpoint(config: TurboFluxConfig): string {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|messages)$/i, '')
  return `${baseUrl}${config.provider === 'anthropic' ? '/messages' : '/chat/completions'}`
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(item => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return ''
    const record = item as Record<string, unknown>
    return typeof record.text === 'string' ? record.text : ''
  }).join('')
}

function responseText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const choices = Array.isArray(record.choices) ? record.choices : []
  const firstChoice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : null
  const message = firstChoice?.message && typeof firstChoice.message === 'object' ? firstChoice.message as Record<string, unknown> : null
  const anthropicContent = Array.isArray(record.content) ? record.content : []
  return contentText(message?.content) || contentText(anthropicContent)
}

export function normalizeGeneratedTaskTitle(value: string): string {
  const jsonMatch = value.match(/\{[\s\S]*\}/)
  let title = value
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { title?: unknown }
      if (typeof parsed.title === 'string') title = parsed.title
    } catch {}
  }
  return title
    .replace(/^```(?:json)?\s*|\s*```$/gi, '')
    .replace(/^(?:任务标题|标题|title)\s*[:：]\s*/i, '')
    .replace(/^[“”"'`]+|[“”"'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32)
    .replace(/[，,；;：:。.!！?？\s]+$/u, '')
}

export async function generateTaskTitle(
  config: TurboFluxConfig,
  input: TaskTitleGenerationInput,
  request: typeof fetch = fetch,
): Promise<string> {
  const prompts = input.prompts.map(prompt => prompt.trim()).filter(Boolean).slice(-6)
  if (prompts.length === 0) return input.currentTitle
  const system = [
    '你是 TurboFlux 的任务命名组件。',
    '根据用户最近的表达概括长期任务目标，而不是复述本轮的实现细节。',
    '如果任务目标与当前标题一致，原样返回当前标题；只有目标实质变化时才更新。',
    '首次命名必须把用户第一句话概括成清楚的任务名称。',
    '标题使用用户主要语言，中文 6-22 字，英文 3-8 个词；不要标点、引号、表情或解释。',
    '只输出 JSON：{"title":"任务名称"}。',
  ].join('\n')
  const user = `当前标题：${input.currentTitle}\n最近用户表达：\n${prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')}`
  const anthropic = config.provider === 'anthropic'
  const response = await request(modelEndpoint(config), {
    method: 'POST',
    headers: anthropic
      ? {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        }
      : {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          ...(config.provider === 'openrouter' ? { 'HTTP-Referer': 'https://turboflux.dev', 'X-Title': 'TurboFlux' } : {}),
        },
    body: JSON.stringify(anthropic
      ? { model: config.model, system, messages: [{ role: 'user', content: user }], max_tokens: 96 }
      : { model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Task title request failed (${response.status})`)
  const title = normalizeGeneratedTaskTitle(responseText(await response.json()))
  if (title) return title
  return isPlaceholderTaskTitle(input.currentTitle) ? fallbackTaskTitle(prompts[0]) : input.currentTitle
}
