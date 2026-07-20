import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND} from '../design';
import {curves, mix, phase, stagger} from '../motion';

const nodes = [
  {at: 1.7, command: 'recap', label: '阶段结论写入摘要', detail: '保留决策与证据', color: BRAND.accent},
  {at: 2.9, command: 'compact', label: '较早对话被压缩', detail: '最近工作保持原样', color: BRAND.warning},
  {at: 4.05, command: 'checkpoint', label: '文件状态可恢复', detail: '本地历史独立保存', color: BRAND.success},
  {at: 5.15, command: 'resume', label: '会话继续', detail: '任务状态重新挂载', color: BRAND.foreground},
];

export const ContinuityScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const intro = phase(frame, fps, 0.2, 0.65, curves.heroEnter);
  const occupancy = mix(42.35, 42.35, 1);
  const lineWidth = phase(frame, fps, 0.55, 0.95, curves.camera);
  const exit = phase(frame, fps, 6.85, 0.7, curves.heroExit);

  return (
    <div style={{position: 'absolute', inset: 0, padding: '96px 126px', boxSizing: 'border-box', transform: `translateY(${-exit * 22}px)`, opacity: 1 - exit}}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', opacity: intro, transform: `translateY(${(1 - intro) * 34}px)`}}>
        <div>
          <div style={{fontSize: 17, color: BRAND.accent, fontWeight: 800}}>长会话，不靠遗忘换空间</div>
          <div style={{fontSize: 58, lineHeight: 1.12, fontWeight: 850, marginTop: 12}}>保留决定。压缩重复。</div>
        </div>
        <div style={{fontFamily: BRAND.mono, textAlign: 'right'}}>
          <div style={{fontSize: 15, color: BRAND.muted}}>CONTEXT OCCUPANCY</div>
          <div style={{fontSize: 30, color: BRAND.foreground, marginTop: 8}}>84.7k <span style={{color: BRAND.muted}}>/ 200k</span></div>
        </div>
      </div>

      <div style={{position: 'relative', marginTop: 72, height: 420}}>
        <div style={{position: 'absolute', left: 0, right: 0, top: 90, height: 8, background: BRAND.dividerSoft}} />
        <div style={{position: 'absolute', left: 0, top: 90, width: `${occupancy * lineWidth}%`, height: 8, background: BRAND.accent, boxShadow: `0 0 26px ${BRAND.accent}`}} />
        <div style={{position: 'absolute', left: `${occupancy}%`, top: 76, width: 4, height: 36, background: BRAND.foreground}} />

        {nodes.map((node, index) => {
          const show = stagger(frame, fps, index, 1.45, 1.12, 0.42);
          const resolved = time >= node.at + 0.9;
          const left = 4 + index * 24.5;
          return (
            <div key={node.command} style={{position: 'absolute', left: `${left}%`, top: index % 2 === 0 ? 130 : 250, width: 330, opacity: show, transform: `translateY(${(1 - show) * 24}px)`}}>
              <div style={{position: 'absolute', left: 18, top: index % 2 === 0 ? -40 : -160, width: 1, height: index % 2 === 0 ? 40 : 160, background: resolved ? node.color : BRAND.divider}} />
              <div style={{display: 'flex', alignItems: 'center', gap: 10, fontFamily: BRAND.mono}}>
                <span style={{width: 12, height: 12, background: resolved ? node.color : BRAND.surface, border: `2px solid ${node.color}`, boxShadow: resolved ? `0 0 16px ${node.color}` : undefined}} />
                <span style={{fontSize: 17, color: node.color, fontWeight: 800}}>{node.command}</span>
              </div>
              <div style={{fontSize: 24, fontWeight: 750, marginTop: 16}}>{node.label}</div>
              <div style={{fontSize: 16, color: BRAND.muted, marginTop: 8}}>{node.detail}</div>
            </div>
          );
        })}
      </div>

      <div style={{position: 'absolute', left: 126, right: 126, bottom: 72, height: 46, display: 'flex', alignItems: 'center', gap: 16, padding: '0 18px', background: BRAND.surfaceRaised, border: `1px solid ${BRAND.divider}`, fontFamily: BRAND.mono, fontSize: 15}}>
        <b style={{color: BRAND.success}}>VIBE</b><span style={{color: BRAND.muted}}>| claude-sonnet-5 | reason:high | approval:agent | ctx 84.7k/200k | cache 72.4k | history ready</span>
      </div>
    </div>
  );
};
