import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, mix, phase, stagger} from '../motion';

const fragments = [
  {text: 'src/core/session.ts:184', x: 150, y: 174, speed: 0.44},
  {text: 'TimeoutError: upstream did not respond', x: 1148, y: 198, speed: 0.62},
  {text: 'retryPolicy.resolve()', x: 402, y: 314, speed: 0.82},
  {text: 'auth/controller.ts:92', x: 1298, y: 346, speed: 0.57},
  {text: 'POST /v1/session 504', x: 210, y: 512, speed: 0.68},
  {text: 'context/messages.ts', x: 1240, y: 590, speed: 0.91},
  {text: 'run regression suite', x: 448, y: 724, speed: 0.53},
  {text: 'pending approval', x: 1314, y: 770, speed: 0.74},
];

export const SignalScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const gather = phase(frame, fps, 2.1, 1.35, curves.camera);
  const line = phase(frame, fps, 2.55, 0.72, curves.heroEnter);
  const first = stagger(frame, fps, 0, 0.62, 0.16, 0.58);
  const second = stagger(frame, fps, 1, 0.62, 0.16, 0.58);

  return (
    <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
      <div style={{position: 'absolute', left: 124, top: 92, fontFamily: BRAND.mono, fontSize: 15, color: BRAND.subtle}}>TurboFlux / 0.1.5</div>
      {fragments.map((item, index) => {
        const opacity = (1 - gather) * (0.22 + index * 0.045);
        const targetX = 960;
        const targetY = 822;
        const x = mix(item.x + Math.sin(time * item.speed + index) * 34, targetX, gather);
        const y = mix(item.y + Math.cos(time * item.speed * 0.7 + index) * 18, targetY, gather);
        const scale = mix(1, 0.54, gather);
        return (
          <div key={item.text} style={{position: 'absolute', left: x, top: y, opacity, transform: `translate(-50%,-50%) scale(${scale})`, fontFamily: BRAND.mono, color: index % 3 === 0 ? BRAND.accent : BRAND.muted, fontSize: 18, whiteSpace: 'nowrap'}}>
            {item.text}
          </div>
        );
      })}

      <div style={{position: 'absolute', left: 190, top: 346, overflow: 'hidden', width: 1540}}>
        <div style={{fontSize: 92, fontWeight: 850, lineHeight: 1.04, transform: `translateY(${(1 - first) * 96}px)`, opacity: first, letterSpacing: 0}}>代码很多。</div>
        <div style={{fontSize: 92, fontWeight: 850, lineHeight: 1.04, color: BRAND.muted, transform: `translateY(${(1 - second) * 96}px)`, opacity: second, letterSpacing: 0}}>线索不该散。</div>
      </div>

      <div style={{position: 'absolute', left: 960 - 610 * line, top: 820, width: 1220 * line, height: 2, background: BRAND.foreground, boxShadow: `0 0 28px ${BRAND.accent}`}} />
      <div style={{position: 'absolute', left: 960, top: 808, width: 3, height: 26, background: BRAND.foreground, opacity: 0.45 + Math.sin(time * Math.PI * 4) * 0.3}} />
    </div>
  );
};
