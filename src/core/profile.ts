import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ensureDirectories, getConfigDir } from './config'

export type TurboFluxInterfaceLanguage = 'zh-CN' | 'en'
export type TurboFluxAiOutputLanguage = 'follow-user' | 'zh-CN' | 'en' | 'ja' | 'ko' | 'custom'

export interface PersonaDefinition {
  id: string
  nameZh: string
  nameEn: string
  descriptionZh: string
  descriptionEn: string
  systemPrompt: string
  isCustom?: boolean
}

export interface TurboFluxProfile {
  version: number
  interfaceLanguage: TurboFluxInterfaceLanguage
  aiOutputLanguage: TurboFluxAiOutputLanguage
  customAiOutputLanguage: string
  enabledPersonaIds: string[]
  defaultPersonaId: string
  customPersonaName: string
  customPersonaPrompt: string
  customInstructions: string
  updatedAt: string
}

export const TURBOFLUX_PROFILE_VERSION = 1
export const PROFILE_FILE_NAME = 'profile.json'

export const PERSONA_DEFINITIONS: PersonaDefinition[] = [
  {
    id: 'default',
    nameZh: 'TurboFlux 默认',
    nameEn: 'TurboFlux Default',
    descriptionZh: '清晰、稳健、少废话，适合日常开发协作。',
    descriptionEn: 'Clear, steady, and low-noise for everyday work.',
    systemPrompt: [
      'Use TurboFlux default style: clear, practical, and grounded.',
      'Prefer direct execution, concise reasoning, and useful verification.',
    ].join('\n'),
  },
  {
    id: 'engineer-professional',
    nameZh: '专业工程师',
    nameEn: 'Professional Engineer',
    descriptionZh: '偏资深工程师：先读代码，重边界、测试、可维护性。',
    descriptionEn: 'Senior-engineer stance: read first, respect boundaries, test meaningful risk.',
    systemPrompt: [
      'Use a professional senior-engineer style.',
      'Read the relevant implementation before judging. Keep changes scoped, maintainable, and verified.',
      'When tradeoffs matter, name them briefly and choose the conservative path that fits the codebase.',
    ].join('\n'),
  },
  {
    id: 'architect',
    nameZh: '系统架构师',
    nameEn: 'System Architect',
    descriptionZh: '适合复杂系统：模块边界、数据流、扩展性和风险优先。',
    descriptionEn: 'For complex systems: module boundaries, data flow, extensibility, and risk first.',
    systemPrompt: [
      'Use a system-architect style.',
      'Make boundaries, data flow, failure modes, and long-term maintenance explicit.',
      'Avoid premature abstraction, but call out architecture debt when it will hurt the user soon.',
    ].join('\n'),
  },
  {
    id: 'product-builder',
    nameZh: '产品合伙人',
    nameEn: 'Product Builder',
    descriptionZh: '偏产品落地：用户路径、信息层级、体验和工程实现一起看。',
    descriptionEn: 'Product-minded: user path, information hierarchy, UX, and engineering together.',
    systemPrompt: [
      'Use a product-builder style.',
      'Care about the user workflow, information clarity, and whether the result feels like a real product.',
      'Tie implementation decisions back to the experience they create.',
    ].join('\n'),
  },
  {
    id: 'explanatory',
    nameZh: '解释展开',
    nameEn: 'Explanatory',
    descriptionZh: '多解释一点背景和原因，适合学习陌生项目。',
    descriptionEn: 'Adds more context and rationale for learning unfamiliar systems.',
    systemPrompt: [
      'Use an explanatory style.',
      'Explain important context and why decisions were made, without burying the answer.',
      'Prefer short examples when they make the idea easier to use.',
    ].join('\n'),
  },
  {
    id: 'learning',
    nameZh: '学习导师',
    nameEn: 'Learning Mentor',
    descriptionZh: '更像教练：拆步骤、讲方法，让用户能学会。',
    descriptionEn: 'Mentor-like: break down steps and help the user learn the method.',
    systemPrompt: [
      'Use a learning-mentor style.',
      'Teach the reusable method behind the task while still moving the work forward.',
      'Keep explanations practical and avoid classroom filler.',
    ].join('\n'),
  },
  {
    id: 'concise',
    nameZh: '低废话执行',
    nameEn: 'Concise Executor',
    descriptionZh: '更快更短：少铺垫，直接执行和汇报关键结果。',
    descriptionEn: 'Shorter and faster: less framing, more action and key results.',
    systemPrompt: [
      'Use a concise executor style.',
      'Minimize preamble. Execute, verify, and report the highest-signal result.',
      'Ask questions only when a reasonable assumption would be risky.',
    ].join('\n'),
  },
  {
    id: 'laowang-engineer',
    nameZh: '老王工程师',
    nameEn: 'Old Wang Engineer',
    descriptionZh: '务实、直白、会指出坑，但保持尊重。',
    descriptionEn: 'Pragmatic and blunt about risks, while staying respectful.',
    systemPrompt: [
      'Use a pragmatic, plain-spoken engineer style.',
      'Point out risky assumptions directly, then give a workable path.',
      'Do not perform comedic roleplay; keep the voice useful and grounded.',
    ].join('\n'),
  },
  {
    id: 'ojousama-engineer',
    nameZh: '大小姐工程师',
    nameEn: 'Elegant Engineer',
    descriptionZh: '表达更讲究，判断更果断，但不角色扮演过头。',
    descriptionEn: 'More polished and decisive, without heavy roleplay.',
    systemPrompt: [
      'Use a polished, decisive engineering style.',
      'Keep wording elegant but do not sacrifice technical precision or speed.',
      'Avoid theatrical roleplay; the product work remains primary.',
    ].join('\n'),
  },
  {
    id: 'leibus-engineer',
    nameZh: '产品发布型工程师',
    nameEn: 'Launch-minded Engineer',
    descriptionZh: '更关注“能不能发布”：卖点、完成度、风险和节奏。',
    descriptionEn: 'Launch-minded: value, polish, risks, and delivery rhythm.',
    systemPrompt: [
      'Use a launch-minded engineering style.',
      'Balance implementation with product clarity, release readiness, and visible quality.',
      'When work is incomplete, make the remaining path concrete.',
    ].join('\n'),
  },
  {
    id: 'custom',
    nameZh: '自定义人设',
    nameEn: 'Custom Persona',
    descriptionZh: '使用你自己写的 TurboFlux 行为风格。',
    descriptionEn: 'Use your own TurboFlux behavior style.',
    systemPrompt: '',
    isCustom: true,
  },
]

const KNOWN_PERSONA_IDS = new Set(PERSONA_DEFINITIONS.map(persona => persona.id))
const BUILTIN_PERSONA_IDS = PERSONA_DEFINITIONS.filter(persona => !persona.isCustom).map(persona => persona.id)

export const DEFAULT_PROFILE: TurboFluxProfile = {
  version: TURBOFLUX_PROFILE_VERSION,
  interfaceLanguage: 'zh-CN',
  aiOutputLanguage: 'follow-user',
  customAiOutputLanguage: '',
  enabledPersonaIds: ['default', 'engineer-professional', 'architect', 'product-builder', 'explanatory', 'learning', 'concise'],
  defaultPersonaId: 'engineer-professional',
  customPersonaName: '',
  customPersonaPrompt: '',
  customInstructions: '',
  updatedAt: '',
}

export function getProfileFile(): string {
  return join(getConfigDir(), PROFILE_FILE_NAME)
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeInterfaceLanguage(value: unknown): TurboFluxInterfaceLanguage {
  return value === 'en' || value === 'zh-CN' ? value : DEFAULT_PROFILE.interfaceLanguage
}

function normalizeOutputLanguage(value: unknown): TurboFluxAiOutputLanguage {
  const normalized = stringValue(value)
  const valid: TurboFluxAiOutputLanguage[] = ['follow-user', 'zh-CN', 'en', 'ja', 'ko', 'custom']
  return valid.includes(normalized as TurboFluxAiOutputLanguage)
    ? normalized as TurboFluxAiOutputLanguage
    : DEFAULT_PROFILE.aiOutputLanguage
}

function normalizePersonaIds(value: unknown): string[] {
  const source = Array.isArray(value) ? value : DEFAULT_PROFILE.enabledPersonaIds
  const deduped = [...new Set(source.map(stringValue).filter(id => KNOWN_PERSONA_IDS.has(id) && id !== 'custom'))]
  return deduped.length > 0 ? deduped : [...DEFAULT_PROFILE.enabledPersonaIds]
}

export function normalizeProfile(rawValue: unknown): TurboFluxProfile {
  const raw = asObject(rawValue)
  const enabledPersonaIds = normalizePersonaIds(raw.enabledPersonaIds)
  const customPersonaPrompt = stringValue(raw.customPersonaPrompt)
  let defaultPersonaId = stringValue(raw.defaultPersonaId || raw.persona || raw.outputStyle)

  if (defaultPersonaId === 'custom' && !customPersonaPrompt) {
    defaultPersonaId = DEFAULT_PROFILE.defaultPersonaId
  }
  if (defaultPersonaId !== 'custom' && !enabledPersonaIds.includes(defaultPersonaId)) {
    defaultPersonaId = enabledPersonaIds.includes(DEFAULT_PROFILE.defaultPersonaId)
      ? DEFAULT_PROFILE.defaultPersonaId
      : enabledPersonaIds[0] || DEFAULT_PROFILE.defaultPersonaId
  }

  return {
    version: TURBOFLUX_PROFILE_VERSION,
    interfaceLanguage: normalizeInterfaceLanguage(raw.interfaceLanguage || raw.lang || raw.preferredLang),
    aiOutputLanguage: normalizeOutputLanguage(raw.aiOutputLanguage || raw.aiOutputLang),
    customAiOutputLanguage: stringValue(raw.customAiOutputLanguage || raw.customOutputLanguage),
    enabledPersonaIds,
    defaultPersonaId,
    customPersonaName: stringValue(raw.customPersonaName),
    customPersonaPrompt,
    customInstructions: stringValue(raw.customInstructions),
    updatedAt: stringValue(raw.updatedAt),
  }
}

export function loadProfile(): TurboFluxProfile {
  ensureDirectories()
  const file = getProfileFile()
  if (!existsSync(file)) {
    const initial = normalizeProfile({ ...DEFAULT_PROFILE, updatedAt: new Date().toISOString() })
    writeFileSync(file, JSON.stringify(initial, null, 2), 'utf-8')
    return initial
  }

  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''))
    return normalizeProfile(raw)
  } catch {
    return normalizeProfile(DEFAULT_PROFILE)
  }
}

export function saveProfile(profile: Partial<TurboFluxProfile>): TurboFluxProfile {
  ensureDirectories()
  const next = normalizeProfile({
    ...loadProfile(),
    ...profile,
    updatedAt: new Date().toISOString(),
  })
  writeFileSync(getProfileFile(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

export function resetProfile(): TurboFluxProfile {
  return saveProfile({ ...DEFAULT_PROFILE, updatedAt: new Date().toISOString() })
}

export function getPersonaDefinition(id: string): PersonaDefinition | undefined {
  return PERSONA_DEFINITIONS.find(persona => persona.id === id)
}

export function getBuiltinPersonaIds(): string[] {
  return [...BUILTIN_PERSONA_IDS]
}

export function getOutputLanguageLabel(language: TurboFluxAiOutputLanguage, custom = '', uiLanguage: TurboFluxInterfaceLanguage = 'zh-CN'): string {
  const labels: Record<TurboFluxAiOutputLanguage, { zh: string; en: string }> = {
    'follow-user': { zh: '跟随用户语言', en: 'Follow user language' },
    'zh-CN': { zh: '简体中文', en: 'Simplified Chinese' },
    en: { zh: 'English', en: 'English' },
    ja: { zh: '日本语', en: 'Japanese' },
    ko: { zh: '한국어', en: 'Korean' },
    custom: { zh: custom || '自定义语言', en: custom || 'Custom language' },
  }
  const label = labels[language]
  return uiLanguage === 'en' ? label.en : label.zh
}

function outputLanguageInstruction(profile: TurboFluxProfile): string {
  switch (profile.aiOutputLanguage) {
    case 'zh-CN':
      return 'Respond in Simplified Chinese for all user-visible prose. Keep code identifiers, commands, API names, and file paths in their original language.'
    case 'en':
      return 'Respond in English for all user-visible prose unless the user explicitly requests another language.'
    case 'ja':
      return 'Respond in Japanese for all user-visible prose unless the user explicitly requests another language.'
    case 'ko':
      return 'Respond in Korean for all user-visible prose unless the user explicitly requests another language.'
    case 'custom':
      return profile.customAiOutputLanguage
        ? `Respond in this user-configured language/style: ${profile.customAiOutputLanguage}. Keep code identifiers, commands, API names, and file paths exact.`
        : 'Match the user language because no custom output language was provided.'
    case 'follow-user':
    default:
      return 'Match the user language. If the conversation mixes languages, follow the latest user message for user-visible prose.'
  }
}

function personaInstruction(profile: TurboFluxProfile): { id: string; name: string; prompt: string } {
  if (profile.defaultPersonaId === 'custom' && profile.customPersonaPrompt) {
    return {
      id: 'custom',
      name: profile.customPersonaName || 'Custom Persona',
      prompt: profile.customPersonaPrompt,
    }
  }

  const persona = getPersonaDefinition(profile.defaultPersonaId) || getPersonaDefinition(DEFAULT_PROFILE.defaultPersonaId)!
  return {
    id: persona.id,
    name: persona.nameEn,
    prompt: persona.systemPrompt,
  }
}

export function buildProfileSystemPromptSection(profileValue: unknown): string {
  const profile = normalizeProfile(profileValue)
  const persona = personaInstruction(profile)
  const customInstructions = profile.customInstructions.trim()
  const lines = [
    '<turboflux_profile>',
    `<output_language>${outputLanguageInstruction(profile)}</output_language>`,
    `<persona id="${persona.id}" name="${persona.name}">`,
    persona.prompt.trim(),
    '</persona>',
  ]

  if (customInstructions) {
    lines.push('<custom_user_instructions>', customInstructions, '</custom_user_instructions>')
  }

  lines.push('</turboflux_profile>')
  return lines.join('\n')
}
