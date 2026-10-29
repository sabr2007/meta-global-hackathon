// A window onto the hero photo (or a version of it) with SAM outlines drawn in the photo's own
// pixels, so the dotted contours sit exactly on the objects at any size.
import { h, s } from './dom';
import type { Images, Outline } from './types';

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PHOTO = { width: 1440, height: 1920 }; // hero pixels; the WebP copies keep the 3:4 shape
const pct = (value: number): string => `${(value * 100).toFixed(4)}%`;

export interface PhotoOptions {
  crop: Crop;
  images: Pick<Images, '720'> & Partial<Images>;
  alt: string;
  sizes: string;
  outlines?: { outline: Outline; tone: 'lime' | 'orange' | 'neutral' }[];
  markers?: { at: [number, number]; text: string }[];
}

export function photoCrop({ crop, images, alt, sizes, outlines = [], markers = [] }: PhotoOptions): HTMLElement {
  const frame = h('div', { class: 'photo-crop' });
  frame.style.setProperty('--crop-ratio', `${crop.w} / ${crop.h}`);
  frame.style.setProperty('--img-width', pct(PHOTO.width / crop.w));
  frame.style.setProperty('--img-left', pct(-crop.x / crop.w));
  frame.style.setProperty('--img-top', pct(-crop.y / crop.h));
  frame.append(
    h('img', {
      src: `/landing/${images['720']}`,
      srcset: images['1080'] ? `/landing/${images['720']} 720w, /landing/${images['1080']} 1080w` : null,
      sizes: images['1080'] ? sizes : null,
      width: 720,
      height: 960,
      loading: 'lazy',
      decoding: 'async',
      alt,
    }),
  );
  if (outlines.length || markers.length) {
    const svg = s('svg', { viewBox: `${crop.x} ${crop.y} ${crop.w} ${crop.h}`, preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
    for (const { outline, tone } of outlines) svg.append(s('path', { class: `outline outline--${tone}`, d: outline.d }));
    for (const marker of markers) {
      svg.append(
        s('g', { class: 'marker', transform: `translate(${marker.at[0]} ${marker.at[1]})` }, s('circle', { r: 30 }), s('text', {}, marker.text)),
      );
    }
    frame.append(svg);
  }
  return frame;
}
