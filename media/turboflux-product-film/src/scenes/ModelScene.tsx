import {useCurrentFrame, useVideoConfig} from 'remotion';
import {Pointer} from '../engine/Pointer';
import {rectAnchor} from '../engine/geometry';
import {clickPulse, samplePointerPath} from '../engine/pointerPath';
import {BRAND} from '../design';
import {curves, phase, stagger} from '../motion';
import {TerminalStage} from '../components/TerminalStage';

const xhighRect = {x: 420, y: 548, width: 1030, height: 52};

const modelRows = [
  ['claude-sonnet-5', 'ctx 200K  out 64K  tools  vision  reasoning'],
  ['gpt-5.6-sol', 'ctx 200K  out 64K  tools  vision  reasoning'],
  ['deepseek-reasoner', 'ctx 128K  out 32K  tools  reasoning'],
  ['kimi-k2', 'ctx 200K  out 32K  tools  vision'],
  ['glm', 'ctx 128K  out 32K  tools'],
];

const ModelList = ({frame, fps}: {frame: number; fps: number}) => (
  <div style={{padding: '4px 8px', fontFamily: BRAND.mono}}>
    <div style={{display: 'flex', justifyContent: 'space-between', marginBottom: 18}}>
      <b style={{fontSize: 19, color: BRAND.foreground}}>Models</b>
      <span style={{fontSize: 15, color: BRAND.success}}>5 available · discovered from API</span>
    </div>
    <div style={{display: 'flex', flexDirection: 'column', gap: 7}}>
      {modelRows.map(([name, capability], index) => {
        const show = stagger(frame, fps, index, 0.32, 0.13, 0.32);
        return (
          <div key={name} style={{height: 58, display: 'grid', gridTemplateColumns: '32px 330px 1fr', alignItems: 'center', padding: '0 14px', background: index === 0 ? '#0d191d' : 'transparent', borderLeft: `3px solid ${index === 0 ? BRAND.accent : 'transparent'}`, opacity: show, transform: `translateX(${(1 - show) * 28}px)`}}>
            <span style={{fontSize: 18, color: index === 0 ? BRAND.accent : BRAND.subtle}}>{index === 0 ? '›' : ''}</span>
            <b style={{fontSize: 17, color: index === 0 ? BRAND.foreground : BRAND.muted}}>{name}{index === 0 ? <span style={{color: BRAND.success}}> *</span> : null}</b>
            <span style={{fontSize: 14, color: BRAND.muted}}>{capability}</span>
          </div>
        );
      })}
    </div>
  </div>
);

const EffortList = ({selected}: {selected: boolean}) => (
  <div style={{padding: '4px 8px', fontFamily: BRAND.mono}}>
    <div style={{marginBottom: 16}}>
      <b style={{fontSize: 19}}>Reasoning effort</b>
      <div style={{fontSize: 15, color: BRAND.muted, marginTop: 6}}>claude-sonnet-5 · model-native control</div>
    </div>
    <div style={{display: 'flex', flexDirection: 'column', gap: 3}}>
      {[
        ['Off', 'Disable extended reasoning.'],
        ['Low', 'Prioritize latency and cost.'],
        ['Medium', 'Balanced reasoning for everyday work.'],
        ['High', 'Spend more reasoning on difficult tasks.'],
        ['Xhigh', 'Extended reasoning for complex engineering work.'],
        ['Max', 'Use the model maximum reasoning effort.'],
      ].map(([label, description], index) => {
        const active = index === 4;
        return (
          <div key={label} style={{height: 52, display: 'grid', gridTemplateColumns: '32px 170px 1fr', alignItems: 'center', padding: '0 14px', background: active ? '#0d191d' : 'transparent', borderLeft: `3px solid ${active ? BRAND.accent : 'transparent'}`}}>
            <span style={{color: active ? BRAND.accent : BRAND.subtle, fontSize: 18}}>{active ? '›' : ''}</span>
            <b style={{fontSize: 17, color: active ? BRAND.foreground : BRAND.muted}}>{label}{active && selected ? <span style={{color: BRAND.success}}> *</span> : null}</b>
            <span style={{fontSize: 14, color: BRAND.muted}}>{description}</span>
          </div>
        );
      })}
    </div>
  </div>
);

export const ModelScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const switchPanel = phase(frame, fps, 1.65, 0.38, curves.editorial);
  const selected = time >= 3.56;
  const pointer = samplePointerPath({frame, fps, start: 2.6, duration: 0.9, from: {x: 1320, y: 490}, to: rectAnchor(xhighRect), arc: -0.06});
  const press = clickPulse({frame, fps, at: 3.5});

  return (
    <>
      <TerminalStage
        animateIn
        workItems={[
          {label: 'EXECUTION', value: 'READY'},
          {label: 'Fast context', value: 'READY', tone: 'success'},
          {label: 'Models', value: '5 FOUND', tone: 'accent'},
          {label: 'MCP servers', value: 'OFF'},
        ]}
        prompt="/effort"
        statusModel="claude-sonnet-5"
        statusReason={selected ? 'xhigh' : 'high'}
        statusContext="84.7k/200k"
        statusExtra="out 1.2k  cache 72.4k"
      >
        <div style={{position: 'relative', height: '100%', overflow: 'hidden'}}>
          <div style={{position: 'absolute', inset: 0, opacity: 1 - switchPanel, transform: `translateY(${-switchPanel * 34}px)`}}><ModelList frame={frame} fps={fps} /></div>
          <div style={{position: 'absolute', inset: 0, opacity: switchPanel, transform: `translateY(${(1 - switchPanel) * 34}px)`}}><EffortList selected={selected} /></div>
        </div>
      </TerminalStage>
      {time >= 2.38 && time <= 3.96 ? <Pointer x={pointer.x} y={pointer.y} press={press} /> : null}
      <div style={{position: 'absolute', right: 122, top: 96, textAlign: 'right', opacity: phase(frame, fps, 0.2, 0.5, curves.heroEnter)}}>
        <div style={{fontSize: 17, color: BRAND.accent, fontWeight: 800}}>连接你的 API</div>
        <div style={{fontSize: 40, fontWeight: 850, marginTop: 8}}>模型选择权，留给你。</div>
      </div>
    </>
  );
};
