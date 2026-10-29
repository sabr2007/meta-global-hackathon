import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile } from 'remotion';
import { type Candidate, type Size } from '../data';
import { C, FONT } from '../theme';
import { Eyebrow, ModelChip, type Tone } from '../components/Ui';
import { ramp, type Rect } from './timeline';

/** The caption block at the bottom: which model is working, and what it does. */
export const Caption: React.FC<{ chip: string; tone?: Tone; text: string; opacity: number; children?: React.ReactNode }> = ({
  chip,
  tone = 'lime',
  text,
  opacity,
  children,
}) => (
  <AbsoluteFill style={{ justifyContent: 'flex-end', padding: '0 56px 60px', opacity }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, transform: `translateY(${(1 - opacity) * 14}px)` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <ModelChip name={chip} tone={tone} />
        {children}
      </div>
      <div style={{ fontFamily: FONT.title, fontSize: 38, lineHeight: 1.28, color: C.text, maxWidth: 960, letterSpacing: '0.01em' }}>
        {text}
      </div>
    </div>
  </AbsoluteFill>
);

/** Darkens the photo for cards; the top and bottom keep the header and caption readable. */
export const Shade: React.FC<{ amount: number }> = ({ amount }) => (
  <AbsoluteFill style={{ background: `rgba(27, 27, 28, ${amount})` }} />
);

export const EdgeShade: React.FC = () => (
  <AbsoluteFill
    style={{
      background:
        'linear-gradient(180deg, rgba(27,27,28,0.88) 0%, rgba(27,27,28,0.35) 13%, rgba(27,27,28,0) 22%, rgba(27,27,28,0) 64%, rgba(27,27,28,0.82) 82%, rgba(27,27,28,0.96) 100%)',
    }}
  />
);

/** A dotted contour, like the SAM outlines in the app. */
export const DottedPath: React.FC<{ d: string; color: string; opacity?: number; width?: number; gap?: number }> = ({
  d,
  color,
  opacity = 1,
  width = 6,
  gap = 11,
}) => <path d={d} fill="none" stroke={color} strokeWidth={width} strokeDasharray={`0 ${gap}`} strokeLinecap="round" opacity={opacity} />;

/** A label pill pinned to an object, in frame pixels. */
export const ObjectLabel: React.FC<{ x: number; y: number; text: string; tone?: Tone; opacity: number }> = ({ x, y, text, tone = 'neutral', opacity }) => (
  <div
    style={{
      position: 'absolute',
      left: x,
      top: y,
      transform: `translate(-50%, 0) translateY(${(1 - opacity) * 8}px)`,
      opacity,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      borderRadius: 999,
      background: 'rgba(27, 27, 28, 0.86)',
      fontFamily: FONT.body,
      fontWeight: 600,
      fontSize: 19,
      color: C.text,
      whiteSpace: 'nowrap',
    }}
  >
    <span style={{ width: 9, height: 9, borderRadius: 5, background: tone === 'lime' ? C.lime : tone === 'orange' ? C.orange : C.neutral }} />
    {text}
  </div>
);

/** A version of the after photo as a print that develops out of the graphite. */
export const Print: React.FC<{
  candidate: Candidate;
  rect: Rect;
  develop: number; // 0 = blank paper, 1 = fully developed
  size?: Size;
  radius?: number;
  ring?: string | null;
  opacity?: number;
}> = ({ candidate, rect, develop, size = '720', radius = 14, ring = null, opacity = 1 }) => {
  const file = candidate.images?.[size];
  const brightness = interpolate(develop, [0, 0.55, 1], [0.04, 0.6, 1], { easing: Easing.out(Easing.quad) });
  const blur = interpolate(develop, [0, 0.7, 1], [10, 2, 0]);
  const contrast = interpolate(develop, [0, 1], [1.5, 1]);
  return (
    <div
      style={{
        position: 'absolute',
        ...rect,
        borderRadius: radius,
        overflow: 'hidden',
        background: C.raised,
        boxShadow: ring ? `0 0 0 4px ${ring}, 0 30px 60px -28px rgba(0,0,0,0.9)` : '0 30px 60px -28px rgba(0,0,0,0.9)',
        opacity,
      }}
    >
      {file ? (
        <Img
          src={staticFile(file)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'fill',
            filter: `brightness(${brightness}) contrast(${contrast}) blur(${blur}px)`,
            opacity: ramp(develop, 0, 0.25),
          }}
        />
      ) : (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Eyebrow>no image saved</Eyebrow>
        </AbsoluteFill>
      )}
    </div>
  );
};

/** Types `text` out between two frames. */
export function typed(text: string, frame: number, start: number, end: number): string {
  const count = Math.round(interpolate(frame, [start, end], [0, text.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  return text.slice(0, count);
}
