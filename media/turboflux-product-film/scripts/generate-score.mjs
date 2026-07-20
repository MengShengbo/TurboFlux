import {execFileSync} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, 'public', 'audio');
const wavePath = join(outputDir, 'turboflux-score.temp.wav');
const mp3Path = join(outputDir, 'turboflux-score.mp3');
const sampleRate = 44100;
const duration = 78;
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

const impacts = [0.45, 5.45, 8.8, 17.45, 22, 24.55, 31, 35.4, 38.3, 40.2, 44, 49.4, 53.45, 59, 61.25, 62.4, 65, 68.5, 72, 73.3];
const wideSwells = [8.6, 20.6, 29.4, 42.8, 54.7, 63.8, 70.2];
const typing = Array.from({length: 42}, (_, index) => 11.1 + index * 0.118 + (index % 5) * 0.009);
const navigation = [37.2, 37.56, 38.3, 60.9, 61.25, 68.5];

const fract = (value) => value - Math.floor(value);
const noise = (value) => fract(Math.sin(value * 12.9898 + 78.233) * 43758.5453) * 2 - 1;
const envelope = (time, start, attack, decay) => {
  const local = time - start;
  if (local < 0 || local > attack + decay) return 0;
  if (local < attack) return local / Math.max(attack, 0.0001);
  return Math.exp(-(local - attack) * 5 / Math.max(decay, 0.0001));
};
const smoothWindow = (time, start, end, edge = 1) => {
  const fadeIn = Math.max(0, Math.min(1, (time - start) / edge));
  const fadeOut = Math.max(0, Math.min(1, (end - time) / edge));
  return Math.min(fadeIn, fadeOut);
};

let slowNoise = 0;
let slowerNoise = 0;

for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const master = Math.min(1, time / 1.5, (duration - time) / 2.4);
  const white = noise(index * 0.0137);
  slowNoise += (white - slowNoise) * 0.0018;
  slowerNoise += (slowNoise - slowerNoise) * 0.00045;
  const highAir = white - slowNoise;
  const productWeight = smoothWindow(time, 22, 65, 2.4);
  const whiteField = 1 - productWeight * 0.62;

  let left = highAir * 0.0022 * whiteField + slowNoise * 0.0042 * productWeight;
  let right = -highAir * 0.0019 * whiteField + slowerNoise * 0.005 * productWeight;

  const subBreath = Math.sin(2 * Math.PI * (31 + Math.sin(time * 0.07) * 1.8) * time) * 0.018 * productWeight;
  const roomTone = Math.sin(2 * Math.PI * 47 * time + Math.sin(time * 0.11) * 0.6) * 0.006 * productWeight;
  left += subBreath + roomTone;
  right += subBreath * 0.96 - roomTone * 0.72;

  for (const start of impacts) {
    const env = envelope(time, start, 0.006, start === 31 || start === 44 ? 1.1 : 0.62);
    if (env > 0) {
      const local = Math.max(0, time - start);
      const frequency = 74 - Math.min(34, local * 48);
      const body = Math.sin(2 * Math.PI * frequency * local) * env * 0.085;
      const texture = noise(index * 0.071 + start) * Math.exp(-local * 16) * 0.025;
      left += body + texture;
      right += body * 0.94 - texture * 0.76;
    }
  }

  for (const start of wideSwells) {
    const local = time - start;
    if (local >= 0 && local <= 1.6) {
      const shape = Math.sin(Math.PI * local / 1.6) ** 2;
      const sweep = (highAir * 0.024 + slowNoise * 0.035) * shape;
      left += sweep;
      right -= sweep * 0.84;
    }
  }

  for (const start of typing) {
    const env = envelope(time, start, 0.001, 0.032);
    if (env > 0) {
      const local = time - start;
      const click = (noise(index * 0.29 + start) * 0.032 + Math.sin(2 * Math.PI * 1650 * local) * 0.012) * env;
      left += click;
      right += click * 0.72;
    }
  }

  for (const start of navigation) {
    const env = envelope(time, start, 0.002, 0.09);
    if (env > 0) {
      const local = time - start;
      const tick = Math.sin(2 * Math.PI * 760 * local) * env * 0.03;
      left += tick * 0.75;
      right += tick;
    }
  }

  const verification = envelope(time, 53.45, 0.04, 1.5);
  if (verification > 0) {
    const local = time - 53.45;
    const partial = Math.sin(2 * Math.PI * 286 * local) * 0.028 + Math.sin(2 * Math.PI * 431 * local) * 0.018;
    left += partial * verification;
    right += partial * verification * 0.94;
  }

  left = Math.tanh(left * 2.1) * master;
  right = Math.tanh(right * 2.1) * master;
  buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left)) * 32767), 44 + index * 4);
  buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right)) * 32767), 46 + index * 4);
}

mkdirSync(outputDir, {recursive: true});
writeFileSync(wavePath, buffer);
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error', '-i', wavePath,
  '-af', 'highpass=f=24,lowpass=f=15000,loudnorm=I=-18:LRA=7:TP=-1.0',
  '-codec:a', 'libmp3lame', '-b:a', '256k', mp3Path,
]);
rmSync(wavePath, {force: true});
console.log(mp3Path);
