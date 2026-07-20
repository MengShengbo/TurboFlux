import type {ReactNode} from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND, TERMINAL} from '../design';
import {curves, phase} from '../motion';

type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger';

export interface RailItem {
  label: string;
  value?: string;
  tone?: Tone;
  active?: boolean;
}

interface TerminalStageProps {
  children?: ReactNode;
  workItems?: RailItem[];
  taskTitle?: string;
  taskItems?: RailItem[];
  taskProgress?: number;
  prompt?: ReactNode;
  promptAttachment?: string;
  running?: boolean;
  statusModel?: string;
  statusReason?: string;
  statusContext?: string;
  statusExtra?: string;
  opacity?: number;
  scale?: number;
  translateX?: number;
  translateY?: number;
  animateIn?: boolean;
  overlay?: ReactNode;
}

const toneColor = (tone: Tone = 'default') => {
  if (tone === 'accent') return BRAND.accent;
  if (tone === 'success') return BRAND.success;
  if (tone === 'warning') return BRAND.warning;
  if (tone === 'danger') return BRAND.danger;
  return BRAND.text;
};

const Rail = ({title, items, progress}: {title: string; items: RailItem[]; progress?: number}) => (
  <div style={{height: '100%', padding: '22px 18px', boxSizing: 'border-box', background: BRAND.darkSoft}}>
    <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22}}>
      <span style={{fontFamily: BRAND.mono, fontSize: 13, color: BRAND.textMuted}}>{title}</span>
      <span style={{width: 6, height: 6, borderRadius: 6, background: items.some((item) => item.active) ? BRAND.accent : BRAND.darkLine}} />
    </div>
    {typeof progress === 'number' ? (
      <div style={{marginBottom: 24}}>
        <div style={{display: 'flex', justifyContent: 'space-between', fontFamily: BRAND.mono, fontSize: 12, color: BRAND.textMuted, marginBottom: 8}}>
          <span>progress</span><span>{Math.round(progress)}%</span>
        </div>
        <div style={{height: 2, background: BRAND.darkLine}}><div style={{height: 2, width: `${Math.max(0, Math.min(100, progress))}%`, background: progress >= 100 ? BRAND.success : BRAND.accent}} /></div>
      </div>
    ) : null}
    <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} style={{display: 'grid', gridTemplateColumns: item.value ? '1fr auto' : '1fr', gap: 10, alignItems: 'baseline'}}>
          <span style={{fontFamily: BRAND.mono, fontSize: 13, lineHeight: 1.35, color: item.active ? BRAND.text : BRAND.textMuted}}>{item.active ? '› ' : ''}{item.label}</span>
          {item.value ? <span style={{fontFamily: BRAND.mono, fontSize: 12, color: toneColor(item.tone)}}>{item.value}</span> : null}
        </div>
      ))}
    </div>
  </div>
);

const ActivityLine = ({running}: {running: boolean}) => {
  const frame = useCurrentFrame();
  const position = ((frame * 13) % 1760) - 200;
  return <div style={{height: 2, background: BRAND.darkLine, overflow: 'hidden'}}>{running ? <div style={{height: 2, width: 180, transform: `translateX(${position}px)`, background: BRAND.accent}} /> : null}</div>;
};

export const TerminalStage = ({
  children,
  workItems = [],
  taskItems = [],
  taskTitle,
  taskProgress,
  prompt,
  promptAttachment,
  running = false,
  statusModel = 'claude-sonnet-5',
  statusReason = 'high',
  statusContext = '18.6k/200k',
  statusExtra = 'git:on  mcp:off',
  opacity = 1,
  scale = 1,
  translateX = 0,
  translateY = 0,
  animateIn = false,
  overlay,
}: TerminalStageProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const settle = animateIn ? phase(frame, fps, 0, 1.15, curves.heroEnter) : 1;
  const bodyHeight = TERMINAL.height - TERMINAL.header - TERMINAL.composer - TERMINAL.status - 2;
  const resolvedTaskItems = taskTitle ? [{label: taskTitle, active: true}, ...taskItems] : taskItems;

  return (
    <div style={{
      position: 'absolute', left: TERMINAL.x, top: TERMINAL.y, width: TERMINAL.width, height: TERMINAL.height,
      opacity, transform: `translate(${translateX}px, ${translateY + (1 - settle) * 34}px) scale(${scale * (0.965 + settle * 0.035)})`, transformOrigin: 'center',
      background: BRAND.dark, border: `1px solid ${BRAND.darkLine}`, borderRadius: 8, overflow: 'hidden',
      boxShadow: '0 44px 120px rgba(0,0,0,0.48)',
    }}>
      <div style={{height: TERMINAL.header, display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', padding: '0 24px', boxSizing: 'border-box', borderBottom: `1px solid ${BRAND.darkLine}`, background: BRAND.dark}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 11}}>
          <div style={{width: 18, height: 18, border: `1px solid ${BRAND.text}`, borderRadius: 4, display: 'grid', placeItems: 'center', fontFamily: BRAND.mono, color: BRAND.accent, fontSize: 11, fontWeight: 800}}>&gt;</div>
          <span style={{fontSize: 16, fontWeight: 700, color: BRAND.text}}>TurboFlux</span>
        </div>
        <div style={{textAlign: 'center'}}>
          <div style={{fontFamily: BRAND.mono, fontSize: 12, color: BRAND.text}}>TurboFlux-legacy-backup</div>
          <div style={{fontFamily: BRAND.mono, fontSize: 10, color: BRAND.textMuted, marginTop: 4}}>C:\projects\TurboFlux</div>
        </div>
        <div style={{justifySelf: 'end', fontFamily: BRAND.mono, fontSize: 11, color: BRAND.textMuted}}>v0.1.5</div>
      </div>
      <div style={{height: bodyHeight, display: 'grid', gridTemplateColumns: `${TERMINAL.workRail}px 1fr ${TERMINAL.taskRail}px`, minHeight: 0}}>
        <div style={{borderRight: `1px solid ${BRAND.darkLine}`}}><Rail title="WORK" items={workItems} /></div>
        <div style={{position: 'relative', minWidth: 0, overflow: 'hidden', background: BRAND.dark}}>
          <div style={{height: '100%', padding: '26px 30px', boxSizing: 'border-box', overflow: 'hidden'}}>{children}</div>
          {overlay}
        </div>
        <div style={{borderLeft: `1px solid ${BRAND.darkLine}`}}><Rail title="CURRENT TASK" items={resolvedTaskItems} progress={taskProgress} /></div>
      </div>
      <ActivityLine running={running} />
      <div style={{height: TERMINAL.composer, padding: '16px 20px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 13, background: BRAND.panel, borderTop: `1px solid ${BRAND.darkLine}`}}>
        <span style={{fontFamily: BRAND.mono, fontSize: 21, color: BRAND.accent}}>&gt;</span>
        {promptAttachment ? <span style={{fontFamily: BRAND.mono, fontSize: 12, color: BRAND.textMuted, borderBottom: `1px solid ${BRAND.accent}`, paddingBottom: 3}}>{promptAttachment}</span> : null}
        <div style={{fontFamily: BRAND.mono, fontSize: 15, color: prompt ? BRAND.text : BRAND.textMuted, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden'}}>{prompt || 'Ask TurboFlux'}</div>
        <div style={{width: 38, height: 38, borderRadius: 19, display: 'grid', placeItems: 'center', background: BRAND.text, color: BRAND.dark, fontSize: 19, fontWeight: 800}}>↑</div>
      </div>
      <div style={{height: TERMINAL.status, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', boxSizing: 'border-box', background: BRAND.darkSoft, fontFamily: BRAND.mono, fontSize: 10.5, color: BRAND.textMuted}}>
        <b style={{color: BRAND.success}}>VIBE</b><span>·</span><span>{statusModel}</span><span>·</span><span>effort:{statusReason}</span><span>·</span><span>approval:agent</span><span>·</span><span>ctx {statusContext}</span><span>·</span><span>{statusExtra}</span>
      </div>
    </div>
  );
};

export const TerminalText = ({children, tone = 'default', bold = false, size = 16}: {children: ReactNode; tone?: Tone; bold?: boolean; size?: number}) => (
  <div style={{fontFamily: BRAND.mono, fontSize: size, lineHeight: 1.55, color: toneColor(tone), fontWeight: bold ? 700 : 400}}>{children}</div>
);
