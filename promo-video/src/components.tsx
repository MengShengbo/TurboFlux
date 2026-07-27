import React from 'react';
import {AbsoluteFill, interpolate, spring, useVideoConfig} from 'remotion';
import {C, ease, mono} from './theme';

export const GridBackground: React.FC<{opacity?: number}> = ({opacity = 0.18}) => (
  <AbsoluteFill
    style={{
      backgroundColor: C.bg,
      backgroundImage: `linear-gradient(${C.cyan}14 1px, transparent 1px), linear-gradient(90deg, ${C.cyan}14 1px, transparent 1px), radial-gradient(circle at 50% 45%, ${C.info}13, transparent 46%)`,
      backgroundSize: '48px 48px, 48px 48px, 100% 100%',
      opacity,
    }}
  />
);

export const Vignette: React.FC = () => (
  <AbsoluteFill style={{background: 'radial-gradient(circle at 50% 46%, transparent 44%, rgba(0,0,0,.72) 100%)'}} />
);

export const Badge: React.FC<{children: React.ReactNode; color?: string; filled?: boolean}> = ({children, color = C.cyan, filled = false}) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8,
    border: `1px solid ${color}80`, background: filled ? color : `${color}10`, color: filled ? C.bg : color,
    fontFamily: mono, fontSize: 18, fontWeight: 700, letterSpacing: 0.5, whiteSpace: 'nowrap',
  }}>{children}</span>
);

export const BrandMark: React.FC<{size?: number; compact?: boolean}> = ({size = 96, compact = false}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: size * 0.24}}>
    <div style={{width: size, height: size, position: 'relative', transform: 'rotate(45deg)'}}>
      <div style={{position: 'absolute', inset: size * 0.1, border: `${Math.max(3, size * 0.07)}px solid ${C.cyan}`, boxShadow: `0 0 ${size * .28}px ${C.cyan}55`}} />
      <div style={{position: 'absolute', left: size * 0.34, top: -size * 0.05, width: size * 0.32, height: size * 1.1, background: C.bg}} />
      <div style={{position: 'absolute', left: size * 0.43, top: size * 0.07, width: size * 0.14, height: size * 0.86, background: C.cyan, boxShadow: `0 0 ${size * .2}px ${C.cyan}77`}} />
    </div>
    {!compact && <div style={{fontFamily: mono, fontSize: size * .66, fontWeight: 800, color: C.white, letterSpacing: -size * .05}}>TurboFlux</div>}
  </div>
);

export const WindowFrame: React.FC<{
  children: React.ReactNode;
  title?: string;
  right?: React.ReactNode;
  style?: React.CSSProperties;
}> = ({children, title = 'TurboFlux · local workspace', right, style}) => (
  <div style={{
    background: C.panel, border: `1px solid ${C.line}`, borderRadius: 18, overflow: 'hidden',
    boxShadow: `0 40px 120px rgba(0,0,0,.72), 0 0 80px ${C.info}0d`, ...style,
  }}>
    <div style={{height: 54, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', borderBottom: `1px solid ${C.line}`, background: '#0D0D0D'}}>
      {[C.red, C.yellow, C.green].map((color) => <div key={color} style={{width: 12, height: 12, borderRadius: 6, background: color, opacity: .86}} />)}
      <div style={{fontFamily: mono, color: C.muted, fontSize: 16, marginLeft: 12}}>{title}</div>
      <div style={{marginLeft: 'auto'}}>{right}</div>
    </div>
    {children}
  </div>
);

const statusRows = [
  ['01', '理解目标与约束', 'done'],
  ['02', 'FastContext 证据检索', 'done'],
  ['03', '并行实施与验证', 'active'],
  ['04', '结构化 Git 交付', 'queued'],
];

export const Dashboard: React.FC<{frame?: number; dense?: boolean}> = ({frame = 90, dense = false}) => {
  const progress = Math.min(100, Math.round(32 + frame * .34));
  return (
    <div style={{height: '100%', display: 'grid', gridTemplateColumns: '320px 1fr', fontFamily: mono, color: C.white}}>
      <div style={{borderRight: `1px solid ${C.line}`, background: '#080808', padding: '26px 22px', boxSizing: 'border-box'}}>
        <BrandMark size={36} />
        <div style={{marginTop: 34, color: C.dim, fontSize: 13, letterSpacing: 2}}>WORKFLOW</div>
        <div style={{display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14}}>
          {statusRows.map(([id, label, state], index) => {
            const color = state === 'done' ? C.green : state === 'active' ? C.cyan : C.dim;
            return <div key={id} style={{padding: '14px 12px', borderRadius: 10, background: state === 'active' ? `${C.cyan}0d` : 'transparent', border: `1px solid ${state === 'active' ? `${C.cyan}33` : 'transparent'}`, opacity: ease(frame, 6 + index * 4, 22 + index * 4)}}>
              <div style={{display: 'flex', gap: 12, color, fontSize: 15}}><span>{id}</span><span style={{color: state === 'queued' ? C.dim : C.white}}>{label}</span></div>
            </div>;
          })}
        </div>
        <div style={{position: 'absolute', bottom: 28, left: 24, width: 270}}>
          <div style={{display: 'flex', justifyContent: 'space-between', color: C.muted, fontSize: 13}}><span>CONTEXT</span><span>{progress}%</span></div>
          <div style={{height: 4, background: C.lineSoft, marginTop: 10, borderRadius: 4}}><div style={{width: `${progress}%`, height: 4, background: C.cyan, boxShadow: `0 0 12px ${C.cyan}`}} /></div>
        </div>
      </div>
      <div style={{display: 'grid', gridTemplateRows: '88px 1fr 104px', minWidth: 0}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: '0 28px', borderBottom: `1px solid ${C.line}`}}>
          <Badge color={C.cyan}>VIBE</Badge><Badge color={C.info}>GPT-5 · HIGH</Badge><Badge color={C.green}>LOCAL</Badge>
          <div style={{marginLeft: 'auto', display: 'flex', gap: 12, color: C.muted, fontSize: 14}}><span>QUEUE 02</span><span>·</span><span>CTX 146K</span></div>
        </div>
        <div style={{padding: dense ? 22 : 30, overflow: 'hidden'}}>
          <div style={{fontSize: dense ? 16 : 18, color: C.muted}}>~/studio/aurora <span style={{color: C.cyan}}>on feature/auth-proof</span></div>
          <div style={{fontSize: dense ? 24 : 29, lineHeight: 1.45, marginTop: 18, color: C.white}}>审计认证流程，修复并交付可审查补丁。</div>
          <div style={{marginTop: 28, display: 'flex', flexDirection: 'column', gap: dense ? 12 : 17, fontSize: dense ? 15 : 17}}>
            <LogRow frame={frame} cue={20} tag="FAST" color={C.info} text="隔离映射 184 files · 12 candidates ranked" />
            <LogRow frame={frame} cue={31} tag="TOOL" color={C.cyan} text="read src/auth/session.ts · src/api/token.ts" />
            <LogRow frame={frame} cue={42} tag="AGENT" color={C.yellow} text="3 workers active · test runner detached" />
            <LogRow frame={frame} cue={55} tag="DONE" color={C.green} text="patch verified · diff ready for review" />
          </div>
        </div>
        <div style={{borderTop: `1px solid ${C.line}`, padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 18}}>
          <div style={{flex: 1, height: 58, border: `1px solid ${C.line}`, borderRadius: 12, display: 'flex', alignItems: 'center', padding: '0 18px', color: C.muted, fontSize: 16}}>继续检查边界条件，并准备 Git 交付…</div>
          <div style={{width: 58, height: 58, borderRadius: 12, background: C.cyan, color: C.bg, display: 'grid', placeItems: 'center', fontWeight: 900, fontSize: 25}}>↵</div>
        </div>
      </div>
    </div>
  );
};

const LogRow: React.FC<{frame: number; cue: number; tag: string; color: string; text: string}> = ({frame, cue, tag, color, text}) => {
  const p = ease(frame, cue, cue + 16);
  return <div style={{display: 'flex', gap: 16, transform: `translateY(${18 * (1 - p)}px)`, opacity: p}}>
    <span style={{width: 64, color, fontWeight: 700}}>[{tag}]</span><span style={{color: C.muted}}>{text}</span>
  </div>;
};

export const SceneLabel: React.FC<{eyebrow: string; title: string; subtitle: string; align?: 'left' | 'center'}> = ({eyebrow, title, subtitle, align = 'left'}) => (
  <div style={{textAlign: align, fontFamily: mono}}>
    <div style={{color: C.cyan, letterSpacing: 4, fontSize: 18, fontWeight: 700}}>{eyebrow}</div>
    <div style={{color: C.white, fontSize: 64, lineHeight: 1.1, fontWeight: 800, letterSpacing: -3, marginTop: 16}}>{title}</div>
    <div style={{color: C.muted, fontSize: 22, lineHeight: 1.55, marginTop: 18}}>{subtitle}</div>
  </div>
);

export const DropIn: React.FC<{frame: number; cue: number; children: React.ReactNode; distance?: number}> = ({frame, cue, children, distance = 80}) => {
  const {fps} = useVideoConfig();
  const p = spring({frame: frame - cue, fps, config: {damping: 18, stiffness: 120, mass: .8}});
  return <div style={{opacity: p, transform: `translateY(${distance * (1 - p)}px) scale(${.96 + .04 * p})`}}>{children}</div>;
};
