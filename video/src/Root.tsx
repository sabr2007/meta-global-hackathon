import React from 'react';
import { Composition } from 'remotion';
import { AynaDemo } from './demo/AynaDemo';
import { DEMO_SECONDS } from './demo/script';
import { AynaLoop } from './loop/AynaLoop';
import { FPS, H, LOOP_FRAMES, W } from './loop/timeline';

export const Root: React.FC = () => (
  <>
    {/* The landing's looping film: one real run, 4:5, loops cleanly (last frame = first frame). */}
    <Composition id="AynaLoop" component={AynaLoop} durationInFrames={LOOP_FRAMES} fps={FPS} width={W} height={H} />
    {/* The 3-minute demo skeleton: 8 beats with slots for screen recordings. */}
    <Composition id="AynaDemo" component={AynaDemo} durationInFrames={DEMO_SECONDS * FPS} fps={FPS} width={1920} height={1080} />
  </>
);
