import { describe, expect, it } from 'vitest'
import { extractProviderErrorDetail, presentRequestError } from './requestErrorPresentation'

describe('request error presentation', () => {
  it('attributes a rejected request to the configured API and preserves its reason', () => {
    expect(presentRequestError('HTTP 402: {"error":{"message":"insufficient balance","code":"insufficient_quota"}}'))
      .toBe('你配置的模型 API 拒绝了请求，请检查该连接的服务状态。\n上游返回：insufficient balance')
  })

  it('does not infer a balance problem from unrelated billing or load-balancer errors', () => {
    expect(presentRequestError('HTTP 502: load balancer connection failed')).toContain('模型服务暂时不可用')
    expect(presentRequestError('HTTP 503: billing endpoint unavailable')).toContain('模型服务暂时不可用')
    expect(presentRequestError('HTTP 429: quota exceeded')).toContain('请求过多')
  })

  it('distinguishes authentication, throttling, and service availability', () => {
    expect(presentRequestError('HTTP 401: invalid_api_key')).toBe('模型服务认证失败，请检查服务配置后重试。\n上游返回：invalid_api_key')
    expect(presentRequestError('HTTP 429: rate_limit_exceeded')).toBe('模型服务当前请求过多，请稍后重试。\n上游返回：rate_limit_exceeded')
    expect(presentRequestError('HTTP 503: upstream unavailable')).toBe('模型服务暂时不可用，请稍后重试。\n上游返回：upstream unavailable')
  })

  it('keeps the actionable provider message while redacting credentials', () => {
    expect(presentRequestError('HTTP 400: bad request for sk-secretvalue123456'))
      .toBe('模型服务未能完成这次请求，请重试。\n上游返回：bad request for [已隐藏]')
  })

  it('explains stream disconnections without exposing transport codes', () => {
    expect(presentRequestError('stream_read_error')).toBe('与模型服务的连接中断了，请重试。\n上游返回：stream_read_error')
  })

  it('turns a text-only image rejection into a useful model capability action', () => {
    expect(presentRequestError('Failed to deserialize the JSON body into the target type: messages[16]: unknown variant `image_url`, expected `text`'))
      .toBe('当前模型不支持图像输入。截图已保留在对话中，请切换支持视觉的模型后重试，或让智能代理继续使用页面文字信息。\n上游返回：Failed to deserialize the JSON body into the target type: messages[16]: unknown variant `image_url`, expected `text`')
  })

  it('extracts one real upstream reason from protocol fallbacks', () => {
    const raw = `Request Error\nAll compatible model protocols failed:\n1. OpenAI Responses https://api.example.com/v1/responses — HTTP 404: {"error":{"code":"model_not_found","message":"Model \\"gpt-6-astra\\" is not supported by this account"}}\n2. Chat Completions https://api.example.com/v1/chat/completions — HTTP 404: {"error":{"message":"Model \\"gpt-6-astra\\" is not supported by this account"}}`
    expect(extractProviderErrorDetail(raw)).toBe('Model "gpt-6-astra" is not supported by this account')
    expect(presentRequestError(raw)).toBe('当前模型暂不可用，请切换模型后重试。\n上游返回：Model "gpt-6-astra" is not supported by this account')
  })
})
