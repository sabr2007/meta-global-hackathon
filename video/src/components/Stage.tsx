import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { IMAGE, type Point } from '../data';
import { H, W } from '../loop/timeline';

// The photo and everything drawn on it share the hero photo's pixel space (1440 x 1920): SAM masks,
// outlines and centroids come from the real run in those pixels. A camera picks the visible part.

export interface Camera {
  zoom: number; // 1 = the photo's width fills the frame
  cx: number; // hero pixel at the frame's centre
  cy: number;
}

export const BASE_CAMERA: Camera = { zoom: 1, cx: IMAGE.width / 2, cy: 900 };

export function mixCamera(a: Camera, b: Camera, t: number): Camera {
  return { zoom: a.zoom + (b.zoom - a.zoom) * t, cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t };
}

/** Hero pixels -> loop frame pixels (fixed 1080 x 1350, so the loop can be embedded at any scale). */
export function useProjection(camera: Camera) {
  const k = (W / IMAGE.width) * camera.zoom;
  const left = W / 2 - camera.cx * k;
  const top = H / 2 - camera.cy * k;
  const toFrame = ([x, y]: Point | number[]): Point => [left + x * k, top + y * k];
  return { k, left, top, toFrame, box: { left, top, width: IMAGE.width * k, height: IMAGE.height * k } };
}

export const Photo: React.FC<{ camera: Camera; file: string; style?: React.CSSProperties }> = ({ camera, file, style }) => {
  const { box } = useProjection(camera);
  return (
    <AbsoluteFill style={style}>
      <Img src={staticFile(file)} style={{ position: 'absolute', ...box, objectFit: 'fill' }} />
    </AbsoluteFill>
  );
};

/** SVG in hero pixels, laid exactly over the photo. */
export const Overlay: React.FC<{ camera: Camera; children: React.ReactNode; style?: React.CSSProperties }> = ({
  camera,
  children,
  style,
}) => {
  const { box } = useProjection(camera);
  return (
    <AbsoluteFill style={style}>
      <svg
        viewBox={`0 0 ${IMAGE.width} ${IMAGE.height}`}
        style={{ position: 'absolute', ...box, overflow: 'visible' }}
      >
        {children}
      </svg>
    </AbsoluteFill>
  );
};
