import {execFileSync} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, 'public', 'audio');
const wavePath = join(outputDir, 'turboflux-score.temp.wav');
const mp3Path = join(outputDir, 'turboflux-score.mp3');
const sampleRate = 44100;
const duration = 58;
const channels = 2;
const sampleCount = sampleRate * duration;
const dataSize = sampleCount * channels * 2;
const buffer = Buffer.alloc(44 + dataSize);

buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(channels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * channels * 2, 28);
buffer.writeUInt16LE(channels * 2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

const sections = [
  {start: 0, notes: [55, 82.41, 110]},
  {start: 11.8, notes: [58.27, 87.31, 116.54]},
  {start: 20.2, notes: [43.65, 65.41, 87.31]},
  {start: 29, notes: [49, 73.42, 98]},
  {start: 37.8, notes: [55, 82.41, 110]},
  {start: 45.5, notes: [58.27, 87.31, 116.54]},
  {start: 52, notes: [55, 82.41, 110, 146.83]},
];

const cues = [2.9, 10.15, 13.1, 14, 14.9, 22.4, 24.3, 29.5, 32.7, 35.4, 39.8, 41, 43.25, 46, 49, 52.4, 54.55];
const typing = Array.from({length: 28}, (_, index) => 6.48 + index * 0.082);

const fract = (value) => value - Math.floor(value);
const noise = (value) => fract(Math.sin(value * 12.9898) * 43758.5453) * 2 - 1;
const envelope = (time, start, attack, decay) => {
  const local = time - start;
  if (local < 0 || local > attack + decay) return 0;
  if (local < attack) return local / attack;
  return Math.exp(-(local - attack) * 5 / decay);
};

for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const section = [...sections].reverse().find((item) => time >= item.start) ?? sections[0];
  const master = Math.min(1, time / 1.6, (duration - time) / 2.2);
  const beat = time % 0.6;
  const beatEnvelope = Math.exp(-beat * 8.5);
  const slow = 0.5 + 0.5 * Math.sin(time * Math.PI / 6);
  let left = 0;
  let right = 0;

  section.notes.forEach((frequency, noteIndex) => {
    const wobble = Math.sin(time * 0.33 + noteIndex) * 0.28;
    const toneLeft = Math.sin(2 * Math.PI * (frequency + wobble) * time + noteIndex * 0.72);
    const toneRight = Math.sin(2 * Math.PI * (frequency * 1.002 - wobble * 0.5) * time + noteIndex * 1.07);
    const weight = 0.034 / (1 + noteIndex * 0.22);
    left += toneLeft * weight * (0.72 + slow * 0.28);
    right += toneRight * weight * (0.9 - slow * 0.18);
  });

  const sub = Math.sin(2 * Math.PI * 41.2 * time) * beatEnvelope * 0.055;
  const shimmerStep = Math.floor(time / 0.3);
  const shimmerLocal = time - shimmerStep * 0.3;
  const shimmerFrequency = [220, 293.66, 329.63, 440][shimmerStep % 4];
  const shimmer = Math.sin(2 * Math.PI * shimmerFrequency * time) * Math.exp(-shimmerLocal * 13) * 0.014;
  left += sub + shimmer * 0.7;
  right += sub + shimmer;

  for (const cue of cues) {
    const cueEnvelope = envelope(time, cue, 0.012, 0.52);
    if (cueEnvelope > 0) {
      const rise = 420 + Math.max(0, time - cue) * 240;
      left += Math.sin(2 * Math.PI * rise * time) * cueEnvelope * 0.075;
      right += Math.sin(2 * Math.PI * rise * 1.004 * time) * cueEnvelope * 0.075;
    }
  }

  for (const keyTime of typing) {
    const keyEnvelope = envelope(time, keyTime, 0.0015, 0.035);
    if (keyEnvelope > 0) {
      const click = noise(index * 0.017) * keyEnvelope * 0.035;
      left += click;
      right += click * 0.82;
    }
  }

  const air = noise(index * 0.00071) * 0.0024;
  left = Math.tanh((left + air) * 1.7) * master;
  right = Math.tanh((right - air) * 1.7) * master;
  buffer.writeInt16LE(Math.round(left * 32767), 44 + index * 4);
  buffer.writeInt16LE(Math.round(right * 32767), 46 + index * 4);
}

mkdirSync(outputDir, {recursive: true});
writeFileSync(wavePath, buffer);
execFileSync('ffmpeg', [
  '-y',
  '-hide_banner',
  '-loglevel', 'error',
  '-i', wavePath,
  '-af', 'loudnorm=I=-16:LRA=4:TP=-1.5',
  '-codec:a', 'libmp3lame',
  '-b:a', '256k',
  mp3Path,
]);
rmSync(wavePath, {force: true});
console.log(mp3Path);
