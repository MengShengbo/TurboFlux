export const TURBOFLUX_VOICE_PROFILE = {
  name: 'TurboFlux',
  tone: 'professional',
}

export function buildVoiceSection(_profile?: any): string {
  return ''
}

export function buildVoiceAdapterSection(_provider?: string, _modelId?: string): string {
  return ''
}

export function buildVoiceReminderContext(_turnCount: number): string | null {
  return null
}
