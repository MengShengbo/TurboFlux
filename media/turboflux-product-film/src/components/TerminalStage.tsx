import type {ReactNode} from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';
import {BRAND, TERMINAL, WORDMARK} from '../design';
import {phase, curves} from '../motion';

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

const PanelHeader = ({title, state, tone = 'default'}: {title: string; state: string; tone?: Tone}) => (
  <div style={{height: 42, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', background: BRAND.surfaceRaised, borderBottom: `1px solid ${BRAND.divider}`}}>
    <span style={{fontWeight: 800, fontSize: 18, color: BRAND.foreground}}>{title}</span>
    <span style={{fontWeight: 700, fontSize: 15, color: toneColor(tone)}}>●&nbsp; {state}</span>
  </div>
);

const Rail = ({side, items, progress}: {side: 'work' | 'task'; items: RailItem[]; progress?: number}) => (
  <div style={{height: '100%', background: BRAND.surface, borderRight: side === 'work' ? `1px solid ${BRAND.divider}` : undefined, borderLeft: side === 'task' ? `1px solid ${BRAND.divider}` : undefined}}>
    <PanelHeader title={side === 'work' ? 'WORK' : 'CURRENT TASK'} state={side === 'work' ? (items.some((item) => item.active) ? 'ACTIVE' : 'READY') : (items.length ? 'EXECUTING' : 'IDLE')} tone={items.some((item) => item.active) ? 'accent' : items.length ? 'success' : 'default'} />
    <div style={{padding: '16px 16px', display: 'flex', flexDirection: 'column', gap: 12, fontFamily: BRAND.mono}}>
      {typeof progress === 'number' ? (
        <div style={{display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 2}}>
          <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 14, color: BRAND.muted}}><span>PROGRESS</span><span style={{color: progress >= 100 ? BRAND.success : BRAND.accent}}>{Math.round(progress)}%</span></div>
          <div style={{height: 7, background: BRAND.dividerSoft, position: 'relative', overflow: 'hidden'}}>
            <div style={{position: 'absolute', inset: 0, width: `${Math.max(0, Math.min(100, progress))}%`, background: progress >= 100 ? BRAND.success : BRAND.accent}} />
          </div>
        </div>
      ) : null}
      {items.length === 0 ? <div style={{fontSize: 17, color: BRAND.muted}}>No active task</div> : null}
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} style={{display: 'grid', gridTemplateColumns: item.value ? '1fr auto' : '1fr', columnGap: 12, alignItems: 'baseline'}}>
          <span style={{fontSize: 15, color: item.active ? BRAND.foreground : BRAND.muted, fontWeight: item.active ? 700 : 500}}>{item.active ? '● ' : ''}{item.label}</span>
          {item.value ? <span style={{fontSize: 15, color: toneColor(item.tone), fontWeight: item.tone === 'default' ? 500 : 700}}>{item.value}</span> : null}
        </div>
      ))}
    </div>
  </div>
);

const ActivityLine = ({running}: {running: boolean}) => {
  const frame = useCurrentFrame();
  const head = (frame * 17) % 2100 - 220;
  return (
    <div style={{height: 5, position: 'relative', overflow: 'hidden', background: BRAND.dividerSoft}}>
      {running ? <div style={{position: 'absolute', left: head, width: 260, height: 5, background: BRAND.foreground, boxShadow: `0 0 22px ${BRAND.accent}`}} /> : null}
    </div>
  );
};

export const ProgressLine = ({value, tone = 'accent'}: {value: number; tone?: Tone}) => (
  <div style={{height: 7, background: BRAND.dividerSoft, position: 'relative', overflow: 'hidden'}}>
    <div style={{position: 'absolute', inset: 0, width: `${Math.max(0, Math.min(100, value))}%`, background: toneColor(tone), boxShadow: `0 0 14px ${toneColor(tone)}`}} />
  </div>
);

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
  statusContext = '12.9k/200k',
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
  const settle = animateIn ? phase(frame, fps, 0, 0.9, curves.heroEnter) : 1;
  const stageScale = scale * (0.965 + settle * 0.035);
  const bodyHeight = TERMINAL.height - TERMINAL.header - TERMINAL.composer - TERMINAL.status - 5;
  const resolvedTaskItems = taskTitle
    ? [{label: 'GOAL', value: ''}, {label: taskTitle, active: true}, ...taskItems]
    : taskItems;

  return (
    <div style={{
      position: 'absolute',
      left: TERMINAL.x,
      top: TERMINAL.y,
      width: TERMINAL.width,
      height: TERMINAL.height,
      opacity,
      transform: `translate(${translateX}px, ${translateY + (1 - settle) * 26}px) scale(${stageScale})`,
      transformOrigin: 'center center',
      background: BRAND.backgroundDeep,
      border: `1px solid ${BRAND.divider}`,
      boxShadow: '0 34px 110px rgba(0,0,0,0.64)',
      overflow: 'hidden',
      fontFamily: BRAND.mono,
    }}>
      <div style={{height: TERMINAL.header, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderBottom: `1px solid ${BRAND.dividerSoft}`, background: BRAND.backgroundDeep}}>
        <pre style={{margin: 0, fontFamily: BRAND.mono, fontSize: 15.5, lineHeight: 0.92, fontWeight: 800, color: BRAND.foreground, letterSpacing: 0}}>{WORDMARK.join('\n')}</pre>
        <div style={{fontSize: 14, color: BRAND.muted, marginTop: 8}}>v0.1.5&nbsp;&nbsp; workspace C:\projects\commerce-platform</div>
      </div>

      <div style={{height: bodyHeight, display: 'grid', gridTemplateColumns: `${TERMINAL.workRail}px 1fr ${TERMINAL.taskRail}px`, minHeight: 0}}>
        <Rail side="work" items={workItems} />
        <div style={{position: 'relative', minWidth: 0, background: BRAND.backgroundDeep, overflow: 'hidden'}}>
          <PanelHeader title="SESSION" state={running ? 'WORKING' : 'READY'} tone={running ? 'accent' : 'success'} />
          <div style={{height: bodyHeight - 42, padding: '18px 22px', boxSizing: 'border-box', overflow: 'hidden'}}>{children}</div>
          {overlay}
        </div>
        <div style={{position: 'relative'}}>
          <Rail side="task" items={resolvedTaskItems} progress={taskProgress} />
        </div>
      </div>

      <ActivityLine running={running} />
      <div style={{height: TERMINAL.composer, padding: '12px 16px', boxSizing: 'border-box', background: BRAND.surface, borderTop: `1px solid ${BRAND.divider}`, display: 'flex', alignItems: 'center', gap: 12}}>
        <span style={{fontSize: 24, color: BRAND.foreground, fontWeight: 800}}>&gt;</span>
        {promptAttachment ? <span style={{padding: '7px 10px', border: `1px solid ${BRAND.accentSoft}`, background: '#0d191d', color: BRAND.accent, fontSize: 14}}>{promptAttachment}</span> : null}
        <div style={{fontSize: 18, color: prompt ? BRAND.text : BRAND.muted, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden'}}>{prompt || 'What are we building today?'}</div>
        <div style={{width: 48, height: 48, display: 'grid', placeItems: 'center', background: running ? BRAND.accent : BRAND.foreground, color: BRAND.backgroundDeep, fontSize: 24, fontWeight: 900}}>↑</div>
      </div>
      <div style={{height: TERMINAL.status, display: 'flex', alignItems: 'center', gap: 12, padding: '0 16px', background: BRAND.surfaceRaised, color: BRAND.muted, fontSize: 14, boxSizing: 'border-box'}}>
        <b style={{color: BRAND.success}}>VIBE</b><span>|</span><span>{statusModel}</span><span>|</span><span>reason:{statusReason}</span><span>|</span><span>approval:agent</span><span>|</span><span>ctx {statusContext}</span><span>|</span><span>{statusExtra}</span>
      </div>
    </div>
  );
};

export const TerminalText = ({children, tone = 'default', bold = false}: {children: ReactNode; tone?: Tone; bold?: boolean}) => (
  <div style={{fontFamily: BRAND.mono, fontSize: 18, lineHeight: 1.5, color: toneColor(tone), fontWeight: bold ? 800 : 500}}>{children}</div>
);

export const ProofLabel = ({eyebrow, title, align = 'left'}: {eyebrow: string; title: string; align?: 'left' | 'center'}) => (
  <div style={{position: 'absolute', left: align === 'center' ? 0 : 126, right: align === 'center' ? 0 : undefined, top: 82, textAlign: align, zIndex: 20, fontFamily: BRAND.font}}>
    <div style={{fontSize: 16, color: BRAND.accent, fontWeight: 800}}>{eyebrow}</div>
    <div style={{fontSize: 42, color: BRAND.foreground, fontWeight: 800, marginTop: 8}}>{title}</div>
  </div>
);
