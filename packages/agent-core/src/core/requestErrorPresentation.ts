function sanitizeProviderMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/(["']?(?:api[_-]?key|authorization|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s—–]+/gi, '[上游地址]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320)
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value
  }
}

export function extractProviderErrorDetail(error: string): string | undefined {
  const explicit = error.match(/(?:^|\n)上游返回：\s*(.+)$/i)?.[1]
  if (explicit) return sanitizeProviderMessage(explicit) || undefined

  const messages = [...error.matchAll(/["']message["']\s*:\s*"((?:\\.|[^"\\])*)"/gi)]
    .map(match => sanitizeProviderMessage(decodeJsonString(match[1] || '')))
    .filter(Boolean)
  if (messages.length) return [...new Set(messages)][0]
  const scalarError = error.match(/["']error["']\s*:\s*"((?:\\.|[^"\\])*)"/i)?.[1]
  if (scalarError) return sanitizeProviderMessage(decodeJsonString(scalarError)) || undefined

  const lines = error.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (const line of lines) {
    const response = line
      .replace(/^\d+\.\s*/, '')
      .replace(/^.*?\bHTTP\s+\d{3}\s*:\s*/i, '')
      .trim()
    if (!response || response === line || /^[{[]/.test(response)) continue
    const detail = sanitizeProviderMessage(response)
    if (detail && !/^all compatible model protocols failed/i.test(detail)) return detail
  }
  const fallback = lines.find(line => (
    !/^(?:request error|all compatible model protocols failed:?)/i.test(line)
    && !/^[\u3400-\u9fff]/.test(line)
  ))
  if (fallback) {
    const detail = sanitizeProviderMessage(fallback.replace(/^模型服务返回：\s*/, ''))
    if (detail) return detail
  }
  return undefined
}

export function presentRequestError(error: string): string {
  const detail = extractProviderErrorDetail(error)
  const message = requestErrorSummary(error)
  return detail ? `${message}\n上游返回：${detail}` : message
}

export function requestErrorSummary(error: string): string {
  const normalized = error.toLowerCase()
  if (/unknown variant [`'"]?image_url|image_url.*expected [`'"]?text|image (?:input|content).*(?:not supported|unsupported)|vision.*(?:not supported|unsupported)/.test(normalized)) {
    return '当前模型不支持图像输入。截图已保留在对话中，请切换支持视觉的模型后重试，或让智能代理继续使用页面文字信息。'
  }
  if (/\bhttp\s+402\b|"(?:code|type|error)"\s*:\s*"insufficient_(?:quota|credits?|balance)"/.test(normalized)) {
    return '你配置的模型 API 拒绝了请求，请检查该连接的服务状态。'
  }
  if (/\b(401|403)\b|invalid[_ -]?api[_ -]?key|authentication|unauthorized|forbidden|认证失败|密钥无效/.test(normalized)) {
    return '模型服务认证失败，请检查服务配置后重试。'
  }
  if (/\b429\b|rate[_ -]?limit|too many requests|请求过于频繁/.test(normalized)) {
    return '模型服务当前请求过多，请稍后重试。'
  }
  if (/timed? out|timeout|超时/.test(normalized)) {
    return '模型服务响应超时，请稍后重试。'
  }
  if (/\b(500|502|503|504)\b|service unavailable|temporarily unavailable|服务不可用/.test(normalized)) {
    return '模型服务暂时不可用，请稍后重试。'
  }
  if (/stream[_ -]?(read[_ -]?)?error|econnreset|fetch failed|socket|network|connection|连接中断/.test(normalized)) {
    return '与模型服务的连接中断了，请重试。'
  }
  if (/context.*(?:length|limit)|prompt.*too long|上下文.*超/.test(normalized)) {
    return '对话内容超过模型的处理范围，请精简内容或新建对话。'
  }
  if (/model.*(?:not found|not available|does not exist|not supported)|model_not_found/.test(normalized)) {
    return '当前模型暂不可用，请切换模型后重试。'
  }
  return '模型服务未能完成这次请求，请重试。'
}
