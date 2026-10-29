import React from 'react';
import { C, FONT, RADIUS } from '../theme';

export type Tone = 'lime' | 'orange' | 'neutral';

const toneColor = (tone: Tone): string => (tone === 'lime' ? C.lime : tone === 'orange' ? C.orange : C.neutral);

/** Small wide caps, as AynaEyebrow. */
export const Eyebrow: React.FC<{ children: React.ReactNode; color?: string; size?: number; style?: React.CSSProperties }> = ({
  children,
  color = C.secondary,
  size = 17,
  style,
}) => (
  <div
    style={{
      fontFamily: FONT.title,
      fontSize: size,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color,
      lineHeight: 1.2,
      ...style,
    }}
  >
    {children}
  </div>
);

/** The Meta model at work right now: a pill with a status light. */
export const ModelChip: React.FC<{ name: string; tone?: Tone; style?: React.CSSProperties }> = ({ name, tone = 'lime', style }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 14,
      padding: '12px 22px 12px 18px',
      borderRadius: 999,
      background: 'rgba(37, 37, 40, 0.92)',
      boxShadow: `inset 0 0 0 1.5px ${C.raised}`,
      ...style,
    }}
  >
    <span style={{ width: 12, height: 12, borderRadius: 6, background: toneColor(tone) }} />
    <Eyebrow color={C.text} size={18}>
      {name}
    </Eyebrow>
  </div>
);

/** A rounded graphite card (22 px radius, like the app). */
export const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div
    style={{
      background: C.surface,
      borderRadius: RADIUS.card,
      boxShadow: '0 1px 0 rgba(255,255,255,0.06) inset, 0 24px 60px -24px rgba(0,0,0,0.8)',
      padding: 36,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Dot: React.FC<{ tone: Tone; size?: number }> = ({ tone, size = 14 }) => (
  <span style={{ display: 'inline-block', width: size, height: size, borderRadius: size, background: toneColor(tone), flex: 'none' }} />
);

export const Tag: React.FC<{ children: React.ReactNode; tone?: Tone; size?: number }> = ({ children, tone = 'neutral', size = 20 }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '5px 14px',
      borderRadius: 999,
      fontFamily: FONT.body,
      fontWeight: 600,
      fontSize: size,
      background: tone === 'lime' ? C.limeSoft : tone === 'orange' ? C.orangeSoft : C.raised,
      color: toneColor(tone),
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

/** Dot-matrix figures: numbers only. */
export const Num: React.FC<{ children: React.ReactNode; size: number; color?: string; style?: React.CSSProperties }> = ({
  children,
  size,
  color = C.text,
  style,
}) => (
  <span
    style={{
      fontFamily: FONT.number,
      fontWeight: 900,
      fontSize: size,
      lineHeight: 1,
      color,
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0.02em',
      ...style,
    }}
  >
    {children}
  </span>
);

/** A verdict stamped on a version: lime when SAM 3.1 passed it, orange with the reason when not. */
export const Stamp: React.FC<{ tone: Tone; title: string; detail?: string; scale?: number; rotate?: number; style?: React.CSSProperties }> = ({
  tone,
  title,
  detail,
  scale = 1,
  rotate = -3,
  style,
}) => (
  <div
    style={{
      display: 'inline-flex',
      flexDirection: 'column',
      gap: 4,
      padding: '10px 16px',
      borderRadius: 14,
      background: 'rgba(27, 27, 28, 0.9)',
      boxShadow: `inset 0 0 0 2.5px ${toneColor(tone)}`,
      transform: `rotate(${rotate}deg) scale(${scale})`,
      transformOrigin: 'center',
      ...style,
    }}
  >
    <span style={{ fontFamily: FONT.title, fontSize: 15, letterSpacing: '0.1em', textTransform: 'uppercase', color: toneColor(tone) }}>
      {title}
    </span>
    {detail ? (
      <span style={{ fontFamily: FONT.body, fontSize: 17, fontWeight: 600, color: C.text, lineHeight: 1.25 }}>{detail}</span>
    ) : null}
  </div>
);
