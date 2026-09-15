import { TASK_COMPLETION_CHIME } from '../taskCompletionSound'

let audioContext: AudioContext | null = null
let lastPlayedAt = Number.NEGATIVE_INFINITY

function contextConstructor(): typeof AudioContext | undefined {
  return window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

function completionAudioContext(): AudioContext | null {
  if (audioContext && audioContext.state !== 'closed') return audioContext
  const AudioContextConstructor = contextConstructor()
  if (!AudioContextConstructor) return null
  audioContext = new AudioContextConstructor({ latencyHint: 'interactive' })
  return audioContext
}

function deterministicNoise(index: number, channel: number): number {
  const value = Math.sin((index + 1) * (channel + 11) * 78.233) * 43_758.5453
  return (value - Math.floor(value)) * 2 - 1
}

function createRoomImpulse(context: AudioContext): AudioBuffer {
  const length = Math.ceil(context.sampleRate * TASK_COMPLETION_CHIME.room.durationMs / 1_000)
  const impulse = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const samples = impulse.getChannelData(channel)
    for (let index = 0; index < length; index += 1) {
      const position = index / length
      const earlyReflection = index % Math.max(1, Math.round(context.sampleRate * 0.013)) === 0 ? 0.18 : 0
      samples[index] = (deterministicNoise(index, channel) * 0.82 + earlyReflection)
        * Math.pow(1 - position, TASK_COMPLETION_CHIME.room.decay)
    }
  }
  return impulse
}

function scheduleMalletTransient(context: AudioContext, destination: AudioNode, startsAt: number): void {
  const duration = TASK_COMPLETION_CHIME.transient.durationMs / 1_000
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate)
  const samples = buffer.getChannelData(0)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = deterministicNoise(index, 0) * Math.pow(1 - index / samples.length, 3.4)
  }

  const source = context.createBufferSource()
  const filter = context.createBiquadFilter()
  const gain = context.createGain()
  source.buffer = buffer
  filter.type = 'bandpass'
  filter.frequency.value = TASK_COMPLETION_CHIME.transient.frequency
  filter.Q.value = TASK_COMPLETION_CHIME.transient.q
  gain.gain.setValueAtTime(TASK_COMPLETION_CHIME.transient.gain, startsAt)
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration)
  source.connect(filter).connect(gain).connect(destination)
  source.start(startsAt)
  source.stop(startsAt + duration)
}

function scheduleNote(
  context: AudioContext,
  destination: AudioNode,
  note: (typeof TASK_COMPLETION_CHIME.notes)[number],
  startsAt: number,
): void {
  const noteStart = startsAt + note.atMs / 1_000
  const noteDuration = note.durationMs / 1_000
  const panner = context.createStereoPanner()
  panner.pan.value = note.pan
  panner.connect(destination)

  for (const partial of note.partials) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const partialDuration = noteDuration * partial.decay
    const frequency = note.frequency * partial.ratio
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(frequency * 1.008, noteStart)
    oscillator.frequency.exponentialRampToValueAtTime(frequency, noteStart + 0.032)
    gain.gain.setValueAtTime(0.0001, noteStart)
    gain.gain.exponentialRampToValueAtTime(note.gain * partial.gain, noteStart + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + partialDuration)
    oscillator.connect(gain).connect(panner)
    oscillator.start(noteStart)
    oscillator.stop(noteStart + partialDuration + 0.012)
  }

  scheduleMalletTransient(context, panner, noteStart)
}

function scheduleCompletionChime(context: AudioContext): void {
  const startsAt = context.currentTime + 0.012
  const toneBus = context.createGain()
  const highpass = context.createBiquadFilter()
  const compressor = context.createDynamicsCompressor()
  const master = context.createGain()
  const convolver = context.createConvolver()
  const roomGain = context.createGain()

  highpass.type = 'highpass'
  highpass.frequency.value = 180
  highpass.Q.value = 0.55
  compressor.threshold.value = -22
  compressor.knee.value = 14
  compressor.ratio.value = 3
  compressor.attack.value = 0.004
  compressor.release.value = 0.11
  master.gain.setValueAtTime(TASK_COMPLETION_CHIME.masterGain, startsAt)
  master.gain.setValueAtTime(TASK_COMPLETION_CHIME.masterGain, startsAt + 0.48)
  master.gain.exponentialRampToValueAtTime(0.0001, startsAt + TASK_COMPLETION_CHIME.durationMs / 1_000)
  convolver.buffer = createRoomImpulse(context)
  roomGain.gain.value = TASK_COMPLETION_CHIME.room.gain

  toneBus.connect(highpass).connect(compressor)
  toneBus.connect(convolver).connect(roomGain).connect(compressor)
  compressor.connect(master).connect(context.destination)
  for (const note of TASK_COMPLETION_CHIME.notes) scheduleNote(context, toneBus, note, startsAt)
}

export async function primeTaskCompletionChime(): Promise<boolean> {
  try {
    const context = completionAudioContext()
    if (!context) return false
    if (context.state === 'suspended') await context.resume()
    return context.state === 'running'
  } catch {
    return false
  }
}

export async function playTaskCompletionChime(now = performance.now()): Promise<boolean> {
  if (now - lastPlayedAt < 320) return false
  try {
    const context = completionAudioContext()
    if (!context) return false
    if (context.state === 'suspended') await context.resume()
    if (context.state !== 'running') return false
    scheduleCompletionChime(context)
    lastPlayedAt = now
    return true
  } catch {
    return false
  }
}
