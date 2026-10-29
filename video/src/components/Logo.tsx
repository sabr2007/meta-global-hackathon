import React from 'react';
import { C, FONT } from '../theme';

// AYNA in Michroma over the same word in Doto dots, flipped: the thing and its mirror of points.
// Column widths are Michroma advances (em), as in AynaDesign.swift and web/src/styles/logo.ts.
const LETTERS: [string, number][] = [
  ['A', 1.062],
  ['Y', 1.062],
  ['N', 1.133],
  ['A', 1.062],
];
const DOTO_SCALE = 1.07;

export const Logo: React.FC<{ size?: number; mirror?: string }> = ({ size = 34, mirror = C.reflection }) => {
  const row = (kind: 'solid' | 'mirror') => (
    <div
      style={{
        display: 'flex',
        lineHeight: 1,
        marginTop: kind === 'mirror' ? -0.41 * size : 0,
        transform: kind === 'mirror' ? 'scaleY(-1)' : undefined,
      }}
    >
      {LETTERS.map(([letter, width], i) => (
        <span
          key={i}
          style={{
            width: width * size,
            textAlign: 'center',
            fontFamily: kind === 'solid' ? FONT.title : FONT.number,
            fontWeight: kind === 'solid' ? 400 : 900,
            fontSize: kind === 'solid' ? size : size * DOTO_SCALE,
            color: kind === 'solid' ? C.text : mirror,
            transform: kind === 'mirror' ? `translateX(${0.05 * size * DOTO_SCALE}px)` : undefined,
          }}
        >
          {letter}
        </span>
      ))}
    </div>
  );
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column' }}>
      {row('solid')}
      {row('mirror')}
    </div>
  );
};
