import fs from 'node:fs';
import path from 'node:path';

const sampleRate = 48000;
const duration = 36;
const channels = 2;
const samples = sampleRate * duration;
const bpm = 124;
const beat = 60 / bpm;
const cuts = [145 / 30, 276 / 30, 421 / 30, 595 / 30, 726 / 30, 900 / 30];
let seed = 0x5f3759df;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff * 2 - 1;
};

const data = Buffer.alloc(samples * channels * 2);
let previousNoise = 0;

for (let i = 0; i < samples; i++) {
  const t = i / sampleRate;
  const beatIndex = Math.floor(t / beat);
  const beatPhase = t - beatIndex * beat;
  const eighth = beat / 2;
  const eighthPhase = t - Math.floor(t / eighth) * eighth;
  const sidechain = 0.48 + 0.52 * Math.min(1, beatPhase / 0.14);

  const kickEnv = Math.exp(-beatPhase * 17) * (beatPhase < .32 ? 1 : 0);
  const kickFreq = 48 + 72 * Math.exp(-beatPhase * 35);
  const kick = Math.sin(Math.PI * 2 * kickFreq * beatPhase) * kickEnv * .62;

  const rawNoise = random();
  const highNoise = rawNoise - previousNoise * .92;
  previousNoise = rawNoise;
  const hatEnv = Math.exp(-eighthPhase * 54) * (eighthPhase < .12 ? 1 : 0);
  const hatAccent = Math.floor(t / eighth) % 2 === 1 ? 1 : .58;
  const hat = highNoise * hatEnv * .13 * hatAccent;

  const keyInterval = 1.45 / 30;
  const keyPhase = t >= .6 && t < 3.02 ? (t - .6) % keyInterval : 1;
  const keyEnv = keyPhase < .018 ? Math.exp(-keyPhase * 260) : 0;
  const keyboard = (highNoise * .055 + Math.sin(Math.PI * 2 * 2350 * keyPhase) * .025) * keyEnv;

  let mechanical = 0;
  for (const action of [96 / 30, 690 / 30, 924 / 30]) {
    const after = t - action;
    if (after >= 0 && after < .07) {
      mechanical += (Math.sin(Math.PI * 2 * 780 * after) + highNoise * .7) * Math.exp(-after * 68) * .13;
    }
  }

  let cardFoley = 0;
  const agentLandings = [451, 462, 472, 481, 489];
  const diffLandings = [750, 762, 774, 786, 798, 810, 822, 834];
  for (const actionFrame of [...agentLandings, ...diffLandings]) {
    const after = t - actionFrame / 30;
    if (after >= 0 && after < .11) {
      cardFoley += (highNoise * .62 + Math.sin(Math.PI * 2 * 310 * after)) * Math.exp(-after * 42) * .045;
    }
  }

  const logoAfter = t - 1000 / 30;
  const sparkle = logoAfter >= 0 && logoAfter < 1.25
    ? (Math.sin(Math.PI * 2 * 1320 * logoAfter) + .55 * Math.sin(Math.PI * 2 * 1978 * logoAfter)) * Math.exp(-logoAfter * 3.5) * .045
    : 0;

  const notes = [55, 55, 65.406, 49, 55, 73.416, 65.406, 49];
  const bassFreq = notes[beatIndex % notes.length];
  const bassEnv = Math.min(1, beatPhase * 35) * Math.exp(-beatPhase * 2.4);
  const bass = (Math.sin(Math.PI * 2 * bassFreq * t) + .24 * Math.sin(Math.PI * 4 * bassFreq * t)) * bassEnv * sidechain * .18;

  const pad = (Math.sin(Math.PI * 2 * 110 * t) + .6 * Math.sin(Math.PI * 2 * 164.81 * t + .7)) * .022 * sidechain;
  let riser = 0;
  let impact = 0;
  for (const cut of cuts) {
    const before = cut - t;
    if (before > 0 && before < .42) riser += highNoise * Math.pow(1 - before / .42, 2) * .12;
    const after = t - cut;
    if (after >= 0 && after < .45) impact += Math.sin(Math.PI * 2 * (42 - after * 18) * after) * Math.exp(-after * 9) * .32;
  }

  const introGain = Math.min(1, t / .6);
  const outroGain = t > 34.8 ? Math.max(0, (36 - t) / 1.2) : 1;
  const master = introGain * outroGain;
  const monoMix = (kick + bass + pad + riser + impact + keyboard + mechanical + cardFoley + sparkle) * master;
  const left = Math.max(-.96, Math.min(.96, monoMix + hat * .82 * master));
  const right = Math.max(-.96, Math.min(.96, monoMix + hat * 1.18 * master));
  data.writeInt16LE(Math.round(left * 32767), i * 4);
  data.writeInt16LE(Math.round(right * 32767), i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(channels, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * channels * 2, 28);
header.writeUInt16LE(channels * 2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const output = path.resolve('public/audio/turboflux-score.wav');
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, Buffer.concat([header, data]));
console.log(`Wrote ${output} (${duration}s, ${bpm} BPM)`);
